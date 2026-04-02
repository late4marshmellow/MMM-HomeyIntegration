const fs = require("fs");
const path = require("path");
const NodeHelper = require("node_helper");
const mqtt = require("mqtt");
const Busboy = require("busboy");

module.exports = NodeHelper.create({
    start: function () {
        this.config = null;
        this.mqttClient = null;
        this.pollTimers = [];
        this.routeHandlersInstalled = false;
        this.mediaRoutesInstalled = false;
        this.mediaCache = new Map();
        this.mediaDirectory = path.join(this.path, "media-cache");
        console.log("[MMM-HomeyIntegration] node_helper started");
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification !== "INIT") {
            return;
        }

        this.config = this.withDefaults(payload || {});
        this.ensureMediaStorage();
        this.setupWebhookRoutes();
        this.setupMediaRoutes();
        this.setupMqtt();
        this.setupApiPollers();
        this.setupApiMedia();
        this.sendStatus("initialized");
    },

    withDefaults: function (config) {
        const webhookConfig = Object.assign({
            enabled: true,
            basePath: "/api/homey-bridge",
            authToken: "",
            routes: []
        }, config.webhooks || {});

        const mqttConfig = Object.assign({
            enabled: false,
            url: "",
            username: "",
            password: "",
            clientId: "mmm-homey-bridge",
            qos: 0,
            topics: []
        }, config.mqtt || {});

        const apiConfig = Object.assign({
            enabled: false,
            baseUrl: "",
            headers: {},
            pollers: [],
            media: []
        }, config.api || {});

        const mediaServerConfig = Object.assign({
            enabled: false,
            publicPath: (webhookConfig.basePath || "/api/homey-bridge") + "/media",
            uploadFieldName: "image",
            defaultSource: "default",
            allowUploads: true,
            maxUploadSizeMb: 8,
            retainHistory: 0,
            showOnUpload: true,
            duration: null
        }, config.mediaServer || {});

        return Object.assign({}, config, {
            mqtt: mqttConfig,
            api: apiConfig,
            webhooks: webhookConfig,
            mediaServer: mediaServerConfig
        });
    },

    ensureMediaStorage: function () {
        if (!this.config || !this.config.mediaServer.enabled) {
            return;
        }

        fs.mkdirSync(this.mediaDirectory, { recursive: true });
    },

    sendStatus: function (message, extra) {
        this.sendSocketNotification("BRIDGE_STATUS", Object.assign({
            message: message,
            timestamp: new Date().toISOString()
        }, extra || {}));
    },

    setupWebhookRoutes: function () {
        if (!this.config.webhooks.enabled || this.routeHandlersInstalled) {
            return;
        }

        const basePath = this.config.webhooks.basePath || "/api/homey-bridge";
        const routes = Array.isArray(this.config.webhooks.routes) ? this.config.webhooks.routes.slice() : [];

        routes.forEach((route) => {
            const method = String(route.method || "POST").toLowerCase();
            const pathName = this.normalizeRoute(basePath, route.path || "/");

            if (typeof this.expressApp[method] !== "function") {
                console.warn("[MMM-HomeyIntegration] unsupported method for route:", method, pathName);
                return;
            }

            this.expressApp[method](pathName, async (req, res) => {
                try {
                    if (!this.isAuthorized(req)) {
                        res.status(401).json({ status: "unauthorized" });
                        return;
                    }

                    const requestData = {
                        body: req.body || {},
                        query: req.query || {},
                        headers: req.headers || {}
                    };

                    const action = await this.resolveConfiguredAction(route.action || {}, requestData, {
                        source: "webhook",
                        route: pathName
                    });

                    this.dispatchAction(action, {
                        source: "webhook",
                        route: pathName,
                        request: requestData
                    });

                    res.json({
                        status: "ok",
                        route: pathName,
                        actionType: action.type || null,
                        timestamp: new Date().toISOString()
                    });
                } catch (error) {
                    console.error("[MMM-HomeyIntegration] webhook route failed:", pathName, error);
                    res.status(500).json({
                        status: "error",
                        message: error.message
                    });
                }
            });

            console.log("[MMM-HomeyIntegration] route ready:", method.toUpperCase(), pathName);
        });

        this.routeHandlersInstalled = true;
    },

    setupMediaRoutes: function () {
        if (!this.config.mediaServer.enabled || this.mediaRoutesInstalled) {
            return;
        }

        this.ensureMediaStorage();

        const publicPath = String(this.config.mediaServer.publicPath || "/api/homey-bridge/media").replace(/\/+$/, "");
        const uploadPath = publicPath + "/upload";
        const latestPath = publicPath + "/latest";
        const metaPath = publicPath + "/meta";

        this.expressApp.post(uploadPath, async (req, res) => {
            try {
                if (!this.isAuthorized(req)) {
                    res.status(401).json({ status: "unauthorized" });
                    return;
                }

                if (!this.config.mediaServer.allowUploads) {
                    res.status(403).json({ status: "disabled", message: "Uploads are disabled" });
                    return;
                }

                const upload = await this.parseMultipartUpload(req);
                const source = this.normalizeSourceId(upload.fields.source || req.query.source || this.config.mediaServer.defaultSource);
                const displayName = upload.fields.cameraName || upload.fields.name || upload.file.filename || source;

                const media = await this.emitMediaUpdateFromBuffer(upload.file.buffer, {
                    source: source,
                    name: upload.file.filename || displayName,
                    displayName: displayName,
                    contentType: upload.file.contentType
                });

                const displayAction = this.buildUploadDisplayAction(upload.fields, req.query);
                if (displayAction) {
                    this.dispatchAction(displayAction, {
                        source: "media-upload",
                        route: uploadPath,
                        mediaSource: source
                    });
                }

                res.json({
                    status: "ok",
                    source: source,
                    media: this.serializeMedia(media),
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error("[MMM-HomeyIntegration] media upload failed:", error);
                res.status(500).json({
                    status: "error",
                    message: error.message
                });
            }
        });

        this.expressApp.get(latestPath, (req, res) => {
            this.serveLatestMedia(req.query.source || this.config.mediaServer.defaultSource, res);
        });

        this.expressApp.get(latestPath + "/:source", (req, res) => {
            this.serveLatestMedia(req.params.source, res);
        });

        this.expressApp.get(metaPath, (req, res) => {
            this.serveMediaMetadata(req.query.source || this.config.mediaServer.defaultSource, res);
        });

        this.expressApp.get(metaPath + "/:source", (req, res) => {
            this.serveMediaMetadata(req.params.source, res);
        });

        console.log("[MMM-HomeyIntegration] media upload endpoint ready at POST " + uploadPath);
        console.log("[MMM-HomeyIntegration] media latest endpoint ready at GET " + latestPath + "/:source");

        this.mediaRoutesInstalled = true;
    },

    normalizeRoute: function (basePath, routePath) {
        const normalizedBase = String(basePath || "").replace(/\/+$/, "");
        const normalizedRoute = String(routePath || "").startsWith("/") ? routePath : "/" + routePath;
        return normalizedBase + normalizedRoute;
    },

    isAuthorized: function (req) {
        const token = this.config.webhooks.authToken;
        if (!token) {
            return true;
        }

        const headerToken = req.headers["x-homey-token"];
        const bearerHeader = req.headers.authorization || "";
        const bearerToken = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7) : "";
        const queryToken = req.query && req.query.token;

        return headerToken === token || bearerToken === token || queryToken === token;
    },

    parseMultipartUpload: function (req) {
        const maxUploadBytes = Math.max(Number(this.config.mediaServer.maxUploadSizeMb) || 8, 1) * 1024 * 1024;

        return new Promise((resolve, reject) => {
            const fields = {};
            let fileRecord = null;
            let resolved = false;

            const finish = (error, value) => {
                if (resolved) {
                    return;
                }

                resolved = true;
                if (error) {
                    reject(error);
                    return;
                }

                resolve(value);
            };

            let busboy;

            try {
                busboy = Busboy({
                    headers: req.headers,
                    limits: {
                        files: 1,
                        fileSize: maxUploadBytes
                    }
                });
            } catch (error) {
                finish(error);
                return;
            }

            busboy.on("field", (fieldName, value) => {
                fields[fieldName] = value;
            });

            busboy.on("file", (fieldName, file, info) => {
                const chunks = [];
                let totalBytes = 0;
                const fileName = info && info.filename ? info.filename : "upload";
                const contentType = info && info.mimeType ? info.mimeType : "image/jpeg";
                const expectedField = this.config.mediaServer.uploadFieldName || "image";

                if (fieldName !== expectedField) {
                    file.resume();
                    return;
                }

                file.on("data", (chunk) => {
                    chunks.push(chunk);
                    totalBytes += chunk.length;
                });

                file.on("limit", () => {
                    finish(new Error("Uploaded image exceeds the configured upload size limit"));
                });

                file.on("end", () => {
                    if (resolved) {
                        return;
                    }

                    fileRecord = {
                        fieldName: fieldName,
                        filename: fileName,
                        contentType: contentType,
                        sizeBytes: totalBytes,
                        buffer: Buffer.concat(chunks)
                    };
                });
            });

            busboy.on("error", (error) => finish(error));

            busboy.on("finish", () => {
                if (!fileRecord) {
                    finish(new Error("No uploaded image was found in form field '" + (this.config.mediaServer.uploadFieldName || "image") + "'"));
                    return;
                }

                finish(null, {
                    fields: fields,
                    file: fileRecord
                });
            });

            req.pipe(busboy);
        });
    },

    buildUploadDisplayAction: function (fields, query) {
        if (!this.config.mediaServer.showOnUpload) {
            return null;
        }

        const duration = this.parseOptionalNumber(fields.duration || query.duration, this.config.mediaServer.duration, this.config.displayDuration);

        return {
            type: "display",
            duration: duration
        };
    },

    parseOptionalNumber: function (value, preferredFallback, defaultFallback) {
        const parsedValue = Number(value);
        if (Number.isFinite(parsedValue)) {
            return parsedValue;
        }

        if (Number.isFinite(preferredFallback)) {
            return preferredFallback;
        }

        return defaultFallback;
    },

    normalizeSourceId: function (source) {
        return String(source || this.config.mediaServer.defaultSource || "default")
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "default";
    },

    serveLatestMedia: function (source, res) {
        const media = this.getMediaRecord(source);

        if (!media || !media.filePath || !fs.existsSync(media.filePath)) {
            res.status(404).json({ status: "not-found" });
            return;
        }

        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");

        if (media.contentType) {
            res.type(media.contentType);
        }

        res.sendFile(media.filePath);
    },

    serveMediaMetadata: function (source, res) {
        const media = this.getMediaRecord(source);

        if (!media) {
            res.status(404).json({ status: "not-found" });
            return;
        }

        res.json({
            status: "ok",
            media: this.serializeMedia(media)
        });
    },

    getMediaRecord: function (source) {
        const normalized = this.normalizeSourceId(source);
        return this.mediaCache.get(normalized) || this.mediaCache.get("latest") || null;
    },

    serializeMedia: function (media) {
        return {
            source: media.source,
            name: media.name,
            displayName: media.displayName,
            contentType: media.contentType,
            fetchedAt: media.fetchedAt,
            sizeBytes: media.sizeBytes,
            url: media.url || null,
            dataUrl: media.dataUrl || null
        };
    },

    setupMqtt: function () {
        if (!this.config.mqtt.enabled || !this.config.mqtt.url) {
            return;
        }

        if (this.mqttClient) {
            this.mqttClient.end(true);
            this.mqttClient = null;
        }

        this.mqttClient = mqtt.connect(this.config.mqtt.url, {
            username: this.config.mqtt.username || undefined,
            password: this.config.mqtt.password || undefined,
            clientId: this.config.mqtt.clientId || "mmm-homey-bridge",
            reconnectPeriod: 5000
        });

        this.mqttClient.on("connect", () => {
            console.log("[MMM-HomeyIntegration] MQTT connected");
            this.sendStatus("mqtt-connected");

            this.config.mqtt.topics.forEach((topicConfig) => {
                this.mqttClient.subscribe(topicConfig.topic, { qos: this.config.mqtt.qos || 0 }, (error) => {
                    if (error) {
                        console.error("[MMM-HomeyIntegration] MQTT subscribe failed:", topicConfig.topic, error);
                    } else {
                        console.log("[MMM-HomeyIntegration] MQTT subscribed:", topicConfig.topic);
                    }
                });
            });
        });

        this.mqttClient.on("reconnect", () => {
            console.log("[MMM-HomeyIntegration] MQTT reconnecting");
        });

        this.mqttClient.on("error", (error) => {
            console.error("[MMM-HomeyIntegration] MQTT error:", error);
        });

        this.mqttClient.on("message", async (topic, messageBuffer) => {
            const topicConfig = this.config.mqtt.topics.find((entry) => entry.topic === topic);
            if (!topicConfig) {
                return;
            }

            try {
                const raw = messageBuffer.toString("utf8");
                const parsed = this.parseIncomingValue(raw, topicConfig.parser, topicConfig.valuePath);
                const action = await this.resolveConfiguredAction(topicConfig.action || {}, {
                    value: parsed,
                    topic: topic,
                    raw: raw
                }, {
                    source: "mqtt",
                    topic: topic
                });

                this.dispatchAction(action, {
                    source: "mqtt",
                    topic: topic,
                    value: parsed
                });
            } catch (error) {
                console.error("[MMM-HomeyIntegration] MQTT message handling failed:", topic, error);
            }
        });
    },

    setupApiPollers: function () {
        this.pollTimers.forEach((timer) => clearInterval(timer));
        this.pollTimers = [];

        if (!this.config.api.enabled || !this.config.api.baseUrl) {
            return;
        }

        this.config.api.pollers.forEach((poller) => {
            const interval = Math.max(Number(poller.interval) || 30000, 5000);

            const runPoller = async () => {
                try {
                    const responseData = await this.fetchJsonFromApi(poller.path, poller.method || "GET", poller.body, poller.headers);
                    const value = this.extractValue(responseData, poller.transform && poller.transform.valuePath);
                    const action = await this.resolveConfiguredAction(poller.action || {}, {
                        response: responseData,
                        value: value
                    }, {
                        source: "api-poller",
                        pollerId: poller.id || poller.path
                    });

                    this.dispatchAction(action, {
                        source: "api-poller",
                        pollerId: poller.id || poller.path,
                        value: value
                    });
                } catch (error) {
                    console.error("[MMM-HomeyIntegration] API poller failed:", poller.id || poller.path, error);
                }
            };

            runPoller();
            this.pollTimers.push(setInterval(runPoller, interval));
        });
    },

    setupApiMedia: function () {
        if (!this.config.api.enabled || !this.config.api.baseUrl) {
            return;
        }

        this.config.api.media.forEach((mediaConfig) => {
            const interval = Number(mediaConfig.interval) || 0;
            if (interval <= 0) {
                return;
            }

            const runMediaFetch = async () => {
                try {
                    await this.emitMediaUpdateFromRemote({
                        url: this.toAbsoluteUrl(mediaConfig.path),
                        headers: Object.assign({}, this.config.api.headers, mediaConfig.headers || {}),
                        name: mediaConfig.id || "snapshot",
                        displayName: mediaConfig.label || mediaConfig.id || "snapshot",
                        source: mediaConfig.id || mediaConfig.path
                    });
                } catch (error) {
                    console.error("[MMM-HomeyIntegration] media fetch failed:", mediaConfig.id || mediaConfig.path, error);
                }
            };

            runMediaFetch();
            this.pollTimers.push(setInterval(runMediaFetch, interval));
        });
    },

    parseIncomingValue: function (rawValue, parser, valuePath) {
        if (parser === "json") {
            const data = JSON.parse(rawValue);
            return this.extractValue(data, valuePath);
        }

        return rawValue;
    },

    extractValue: function (input, valuePath) {
        if (!valuePath) {
            return input;
        }

        return String(valuePath).split(".").reduce((current, key) => {
            if (current === null || typeof current === "undefined") {
                return undefined;
            }

            return current[key];
        }, input);
    },

    inferActionType: function (action) {
        if (action.type) {
            return action.type;
        }

        if (action.notification) {
            return "notification";
        }

        if (typeof action.duration !== "undefined" || action.fetchMediaFromBodyPath || action.fetchMediaUrl) {
            return "display";
        }

        return null;
    },

    resolveConfiguredAction: async function (actionConfig, data, context) {
        const action = Object.assign({}, actionConfig);
        action.type = this.inferActionType(action);
        const body = data.body || {};

        if (action.valuePath && typeof action.payload === "undefined") {
            action.payload = this.extractValue(data.body || data.response || data, action.valuePath);
        }

        if (action.notification && typeof action.payload === "undefined" && typeof data.value !== "undefined") {
            action.payload = data.value;
        }

        if (action.type === "display") {
            const inlineMedia = this.extractValue(body, action.mediaDataUriBodyPath || "snapshotUri") || body.imageUri || body.dataUri;
            if (typeof inlineMedia === "string" && inlineMedia.startsWith("data:")) {
                await this.emitMediaUpdateFromDataUri(inlineMedia, {
                    source: action.mediaSource || body.source || body.cameraName || this.config.mediaServer.defaultSource,
                    name: action.mediaName || body.cameraName || "snapshot",
                    displayName: body.cameraName || body.name || action.mediaName || "snapshot"
                });
            }

            let mediaUrl = null;
            if (action.fetchMediaFromBodyPath) {
                mediaUrl = this.extractValue(body, action.fetchMediaFromBodyPath);
            } else if (body.snapshotUrl || body.imageUrl) {
                mediaUrl = body.snapshotUrl || body.imageUrl;
            }

            if (mediaUrl) {
                await this.emitMediaUpdateFromRemote({
                    url: mediaUrl,
                    headers: action.mediaHeaders || {},
                    name: action.mediaName || body.cameraName || "snapshot",
                    displayName: body.cameraName || body.name || action.mediaName || "snapshot",
                    source: action.mediaSource || body.source || body.cameraName || this.config.mediaServer.defaultSource
                });
            }

            if (typeof action.duration === "undefined" && Number.isFinite(Number(body.duration))) {
                action.duration = Number(body.duration);
            }

            if (action.fetchMediaUrl) {
                await this.emitMediaUpdateFromRemote({
                    url: this.expandTemplate(action.fetchMediaUrl, data, context),
                    headers: action.mediaHeaders || {},
                    name: action.mediaName || "snapshot",
                    displayName: action.mediaName || "snapshot",
                    source: action.mediaSource || this.config.mediaServer.defaultSource
                });
            }
        }

        return action;
    },

    dispatchAction: function (action, meta) {
        if (!action || !action.type) {
            return;
        }

        this.sendSocketNotification("BRIDGE_ACTION", {
            action: action,
            source: meta.source || "bridge",
            meta: meta
        });
    },

    fetchJsonFromApi: async function (pathName, method, body, extraHeaders) {
        const response = await fetch(this.toAbsoluteUrl(pathName), {
            method: method || "GET",
            headers: Object.assign({
                "Content-Type": "application/json"
            }, this.config.api.headers || {}, extraHeaders || {}),
            body: body ? JSON.stringify(body) : undefined
        });

        if (!response.ok) {
            throw new Error("HTTP " + response.status + " for " + pathName);
        }

        return response.json();
    },

    fetchMedia: async function (options) {
        const response = await fetch(options.url, {
            method: "GET",
            headers: options.headers || {}
        });

        if (!response.ok) {
            throw new Error("Media HTTP " + response.status + " for " + options.url);
        }

        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") || "image/jpeg";
        const buffer = Buffer.from(arrayBuffer);

        return {
            name: options.name || "snapshot",
            contentType: contentType,
            buffer: buffer,
            dataUrl: "data:" + contentType + ";base64," + buffer.toString("base64"),
            sizeBytes: buffer.length,
            fetchedAt: new Date().toISOString()
        };
    },

    emitMediaUpdateFromRemote: async function (options) {
        const media = await this.fetchMedia(options);
        return this.emitMediaUpdateFromBuffer(media.buffer, {
            source: options.source || options.name || this.config.mediaServer.defaultSource,
            name: options.name || "snapshot",
            displayName: options.displayName || options.name || "snapshot",
            contentType: media.contentType
        });
    },

    emitMediaUpdateFromDataUri: async function (dataUri, options) {
        const parsed = this.parseDataUri(dataUri);
        return this.emitMediaUpdateFromBuffer(parsed.buffer, {
            source: options.source,
            name: options.name,
            displayName: options.displayName,
            contentType: parsed.contentType,
            originalDataUrl: dataUri
        });
    },

    emitMediaUpdateFromBuffer: async function (buffer, options) {
        const contentType = options.contentType || "image/jpeg";
        const source = this.normalizeSourceId(options.source || this.config.mediaServer.defaultSource);
        const fetchedAt = new Date().toISOString();
        let media;

        if (this.config.mediaServer.enabled) {
            media = this.storeMediaBuffer(buffer, {
                source: source,
                name: options.name || "snapshot",
                displayName: options.displayName || options.name || source,
                contentType: contentType,
                fetchedAt: fetchedAt
            });
        } else {
            media = {
                source: source,
                name: options.name || "snapshot",
                displayName: options.displayName || options.name || source,
                contentType: contentType,
                dataUrl: options.originalDataUrl || this.buildDataUri(buffer, contentType),
                fetchedAt: fetchedAt,
                sizeBytes: buffer.length
            };
        }

        this.mediaCache.set(source, media);
        this.mediaCache.set("latest", media);
        this.sendSocketNotification("MEDIA_UPDATED", media);
        return media;
    },

    storeMediaBuffer: function (buffer, options) {
        this.ensureMediaStorage();

        const source = this.normalizeSourceId(options.source);
        const sourceDirectory = path.join(this.mediaDirectory, source);
        const extension = this.getExtensionForContentType(options.contentType);
        const fetchedAt = options.fetchedAt || new Date().toISOString();
        const latestFilePath = path.join(sourceDirectory, "latest" + extension);

        fs.mkdirSync(sourceDirectory, { recursive: true });

        fs.readdirSync(sourceDirectory)
            .filter((entry) => entry.startsWith("latest."))
            .forEach((entry) => {
                const existingPath = path.join(sourceDirectory, entry);
                if (existingPath !== latestFilePath) {
                    fs.rmSync(existingPath, { force: true });
                }
            });

        fs.writeFileSync(latestFilePath, buffer);
        this.storeHistoryCopy(sourceDirectory, extension, buffer);

        return {
            source: source,
            name: options.name || "snapshot",
            displayName: options.displayName || options.name || source,
            contentType: options.contentType || "image/jpeg",
            filePath: latestFilePath,
            url: this.buildMediaUrl(source, fetchedAt),
            fetchedAt: fetchedAt,
            sizeBytes: buffer.length
        };
    },

    storeHistoryCopy: function (sourceDirectory, extension, buffer) {
        const retainHistory = Math.max(Number(this.config.mediaServer.retainHistory) || 0, 0);
        if (retainHistory <= 0) {
            return;
        }

        const historyFileName = Date.now() + extension;
        fs.writeFileSync(path.join(sourceDirectory, historyFileName), buffer);

        const historyFiles = fs.readdirSync(sourceDirectory)
            .filter((entry) => !entry.startsWith("latest."))
            .sort()
            .reverse();

        historyFiles.slice(retainHistory).forEach((entry) => {
            fs.rmSync(path.join(sourceDirectory, entry), { force: true });
        });
    },

    buildMediaUrl: function (source, fetchedAt) {
        const basePath = String(this.config.mediaServer.publicPath || "/api/homey-bridge/media").replace(/\/+$/, "");
        return basePath + "/latest/" + encodeURIComponent(source) + "?t=" + encodeURIComponent(fetchedAt || Date.now());
    },

    parseDataUri: function (dataUri) {
        const match = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUri || ""));
        if (!match) {
            throw new Error("Invalid data URI payload");
        }

        return {
            contentType: match[1],
            buffer: Buffer.from(match[2], "base64")
        };
    },

    buildDataUri: function (buffer, contentType) {
        return "data:" + contentType + ";base64," + buffer.toString("base64");
    },

    getExtensionForContentType: function (contentType) {
        const extensions = {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp"
        };

        return extensions[String(contentType || "").toLowerCase()] || ".bin";
    },

    toAbsoluteUrl: function (pathName) {
        if (!pathName) {
            return this.config.api.baseUrl;
        }

        if (/^https?:\/\//i.test(pathName)) {
            return pathName;
        }

        const baseUrl = String(this.config.api.baseUrl || "").replace(/\/+$/, "");
        const suffix = String(pathName).startsWith("/") ? pathName : "/" + pathName;
        return baseUrl + suffix;
    },

    expandTemplate: function (template, data, context) {
        return String(template).replace(/\{\{([^}]+)\}\}/g, (_, rawKey) => {
            const key = rawKey.trim();

            if (key.startsWith("body.")) {
                return this.extractValue(data.body || {}, key.slice(5)) || "";
            }

            if (key.startsWith("value.")) {
                return this.extractValue(data.value || {}, key.slice(6)) || "";
            }

            if (key === "topic") {
                return context.topic || "";
            }

            return "";
        });
    },

    stop: function () {
        this.pollTimers.forEach((timer) => clearInterval(timer));
        this.pollTimers = [];

        if (this.mqttClient) {
            this.mqttClient.end(true);
            this.mqttClient = null;
        }
    }
});
