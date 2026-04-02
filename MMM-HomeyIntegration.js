Module.register("MMM-HomeyIntegration", {
    defaults: {
        debug: false,
        displayDuration: 60000,
        showSnapshot: false,
        snapshotCssClass: "homey-bridge-snapshot",
        snapshotSize: "100%",
        showSnapshotCaption: false,
        mqtt: {
            enabled: false,
            url: "",
            username: "",
            password: "",
            clientId: "mmm-homey-bridge",
            qos: 0,
            topics: []
        },
        api: {
            enabled: false,
            baseUrl: "",
            headers: {},
            pollers: [],
            media: []
        },
        webhooks: {
            enabled: true,
            basePath: "/api/homey-bridge",
            authToken: "",
            routes: []
        },
        mediaServer: {
            enabled: false,
            publicPath: "/api/homey-bridge/media",
            uploadFieldName: "image",
            defaultSource: "default",
            allowUploads: true,
            maxUploadSizeMb: 8,
            retainHistory: 0,
            showOnUpload: true,
            duration: null
        }
    },

    start: function () {
        this.latestSnapshot = null;
        this.overlayActive = false;
        this.overlayElement = null;
        this.overlayImage = null;
        this.overlayCaption = null;
        this.overlayTimer = null;
        Log.info(this.name + " started");
        this.sendSocketNotification("INIT", this.config);
    },

    getStyles: function () {
        return [this.file("MMM-HomeyIntegration.css")];
    },

    notificationReceived: function (notification) {
        if (notification === "DOM_OBJECTS_CREATED") {
            this.ensureOverlayElement();
        }
    },

    getDom: function () {
        const wrapper = document.createElement("div");
        wrapper.className = "mmm-homey-bridge";
        wrapper.style.display = "none";
        return wrapper;
    },

    socketNotificationReceived: function (notification, payload) {
        if (notification === "BRIDGE_ACTION") {
            this.handleBridgeAction(payload || {});
            return;
        }

        if (notification === "MEDIA_UPDATED") {
            this.latestSnapshot = payload || null;
            this.renderOverlay();
            this.updateDom(300);
            return;
        }

        if (notification === "BRIDGE_STATUS" && this.config.debug) {
            Log.info(this.name + " status:", payload);
        }
    },

    handleBridgeAction: function (payload) {
        const action = payload.action || {};
        const source = payload.source || "bridge";

        if (this.config.debug) {
            Log.info(this.name + " action from " + source + ":", payload);
        }

        if (action.type === "notification" && action.notification) {
            this.sendNotification(action.notification, action.payload);
            return;
        }

        if (action.type === "display") {
            this.showOverlay(action.duration, source);
            return;
        }

        if (action.type === "alert") {
            this.sendNotification("SHOW_ALERT", {
                type: action.alertType || "notification",
                title: action.title || "Homey",
                message: action.message || "",
                timer: action.timer || 5000
            });
            return;
        }

        if (action.type === "multi" && Array.isArray(action.actions)) {
            action.actions.forEach((nextAction) => {
                this.handleBridgeAction({
                    action: nextAction,
                    source: source
                });
            });
        }
    },

    showOverlay: function (duration, source) {
        this.overlayActive = true;
        this.renderOverlay();
        this.updateDom(0);

        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
            this.overlayTimer = null;
        }

        const overlayDuration = typeof duration === "number" ? duration : this.config.displayDuration;

        if (overlayDuration > 0) {
            this.overlayTimer = setTimeout(() => {
                Log.info(this.name + " hiding overlay from " + source);
                this.overlayActive = false;
                this.renderOverlay();
                this.updateDom(0);
            }, overlayDuration);
        }
    },

    ensureOverlayElement: function () {
        if (this.overlayElement || typeof document === "undefined" || !document.body) {
            return;
        }

        const overlay = document.createElement("div");
        overlay.className = "mmm-homey-bridge-global-overlay";
        overlay.style.display = "none";

        const image = document.createElement("img");
        image.className = this.config.snapshotCssClass;
        overlay.appendChild(image);

        const caption = document.createElement("div");
        caption.className = "homey-bridge-caption small";
        overlay.appendChild(caption);

        document.body.appendChild(overlay);

        this.overlayElement = overlay;
        this.overlayImage = image;
        this.overlayCaption = caption;
    },

    renderOverlay: function () {
        this.ensureOverlayElement();

        if (!this.overlayElement) {
            return;
        }

        const hasSnapshot = this.latestSnapshot && (this.latestSnapshot.url || this.latestSnapshot.dataUrl);
        if (!this.overlayActive || !this.config.showSnapshot || !hasSnapshot) {
            this.overlayElement.style.display = "none";
            return;
        }

        this.overlayImage.src = this.latestSnapshot.url || this.latestSnapshot.dataUrl;
        this.overlayImage.alt = this.latestSnapshot.name || "Homey snapshot";
        this.applySnapshotSizing(this.overlayImage);

        if (this.config.showSnapshotCaption) {
            this.overlayCaption.innerText = this.latestSnapshot.displayName || this.latestSnapshot.source || this.latestSnapshot.name || "Homey snapshot";
            this.overlayCaption.style.display = "block";
        } else {
            this.overlayCaption.innerText = "";
            this.overlayCaption.style.display = "none";
        }

        this.overlayElement.style.display = "flex";
    },

    applySnapshotSizing: function (image) {
        image.style.width = this.config.snapshotSize;
        image.style.maxWidth = "100%";
        image.style.height = "auto";
        image.style.maxHeight = "calc(100vh - 48px)";
        image.style.objectFit = "contain";
    }
});
