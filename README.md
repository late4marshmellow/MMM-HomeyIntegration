# MMM-HomeyIntegration

`MMM-HomeyIntegration` is a [MagicMirror²](https://magicmirror.builders/) module that bridges Homey with MagicMirror through webhooks, MQTT, API polling, and media uploads.

It can:

- receive webhook calls from Homey flows
- subscribe to Homey MQTT topics
- poll Homey APIs
- fetch media such as camera snapshots
- receive uploaded image files from Homey apps such as Image Poster
- optionally serve the latest cached snapshot to other modules
- emit native MagicMirror notifications such as `SHOW_ALERT`, `INDOOR_TEMPERATURE`, `INDOOR_HUMIDITY`, and `CURRENT_WEATHER_OVERRIDE`

## Requirements

- MagicMirror²
- Node.js 18 or newer
- A Homey setup that can send webhooks, MQTT messages, API responses, or image uploads

## Why this design

The node helper is the Homey bridge hub.

That keeps:

- authentication in one place
- MQTT reconnect handling in one place
- API polling in one place
- snapshot fetching in one place
- media upload handling in one place

The frontend only:

- forwards bridge actions into MagicMirror notifications
- optionally renders the latest snapshot directly on screen

The media server is optional and can be disabled if you do not need uploads or image re-use.

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/late4marshmellow/MMM-HomeyIntegration.git
cd ~/MagicMirror/modules/MMM-HomeyIntegration
npm install
```

Then add the module to your `config/config.js` file.

## Features

- webhook bridge for Homey flows
- MQTT subscriptions for device events and sensor values
- Homey API polling for notifications and media
- image upload endpoint for Homey Image Poster
- self-contained fullscreen snapshot overlay
- native MagicMirror notifications for weather and alerts

## Example config

```javascript
{
  module: "MMM-HomeyIntegration",
  position: "top_right",
  config: {
    displayDuration: 60000,
    showSnapshot: true,
    snapshotSize: "1000px",

    mediaServer: {
      enabled: true,
      publicPath: "/api/homey-bridge/media",
      uploadFieldName: "image",
      defaultSource: "front-door",
      allowUploads: true,
      maxUploadSizeMb: 8,
      retainHistory: 5,
      showOnUpload: true,
      duration: 60000
    },

    webhooks: {
      enabled: true,
      basePath: "/api/homey-bridge",
      authToken: "change-me",
      routes: [
        {
          path: "/temperature",
          method: "POST",
          action: {
            type: "notification",
            notification: "INDOOR_TEMPERATURE",
            valuePath: "temperature"
          }
        },
        {
          path: "/humidity",
          method: "POST",
          action: {
            type: "notification",
            notification: "INDOOR_HUMIDITY",
            valuePath: "humidity"
          }
        },
        {
          path: "/weather",
          method: "POST",
          action: {
            type: "notification",
            notification: "CURRENT_WEATHER_OVERRIDE",
            valuePath: "weather"
          }
        },
        {
          path: "/camera",
          method: "POST",
          action: {
            type: "display",
            duration: 60000,
            fetchMediaFromBodyPath: "snapshotUrl"
          }
        }
      ]
    },

    mqtt: {
      enabled: true,
      url: "mqtt://HOMEY_OR_BROKER_IP:1883",
      username: "",
      password: "",
      clientId: "mmm-homey-bridge",
      qos: 0,
      topics: [
        {
          topic: "homey/devices/livingroom/temperature",
          parser: "plain",
          action: {
            type: "notification",
            notification: "INDOOR_TEMPERATURE"
          }
        },
        {
          topic: "homey/devices/livingroom/humidity",
          parser: "plain",
          action: {
            type: "notification",
            notification: "INDOOR_HUMIDITY"
          }
        },
        {
          topic: "homey/camera/motion",
          parser: "json",
          action: {
            type: "display",
            duration: 60000
          }
        }
      ]
    },

    api: {
      enabled: true,
      baseUrl: "http://HOMEY_IP",
      headers: {
        Authorization: "Bearer YOUR_HOMEY_TOKEN"
      },
      pollers: [
        {
          id: "indoor-temp",
          path: "/api/manager/devices/device/DEVICE_ID",
          interval: 30000,
          transform: {
            valuePath: "capabilitiesObj.measure_temperature.value"
          },
          action: {
            type: "notification",
            notification: "INDOOR_TEMPERATURE"
          }
        }
      ],
      media: [
        {
          id: "front-door",
          path: "/api/front-door/snapshot",
          interval: 30000
        }
      ]
    }
  }
}
```

## Configuration

Top-level configuration options:

| Option | Description | Default |
|---|---|---|
| `displayDuration` | Default overlay time in milliseconds. | `60000` |
| `showSnapshot` | Enables snapshot overlay rendering in the frontend module. | `false` |
| `snapshotSize` | Single intuitive size for the displayed image, for example `"1000px"`. | `"100%"` |
| `showSnapshotCaption` | Shows the snapshot source or label below the image. | `false` |
| `webhooks` | Webhook routing, authentication, and action configuration. | See module defaults |
| `mqtt` | MQTT connection and topic action configuration. | See module defaults |
| `api` | API polling and media fetch configuration. | See module defaults |
| `mediaServer` | Upload, cache, retention, and overlay-on-upload configuration. | See module defaults |

Important nested options:

| Path | Description | Default |
|---|---|---|
| `mediaServer.enabled` | Enables upload and media-serving endpoints. | `false` |
| `mediaServer.publicPath` | Base path for upload and cached media endpoints. | `"/api/homey-bridge/media"` |
| `mediaServer.uploadFieldName` | Multipart field name used for image uploads. | `"image"` |
| `mediaServer.defaultSource` | Default source id for stored snapshots. | `"default"` |
| `mediaServer.allowUploads` | Allows or blocks multipart uploads. | `true` |
| `mediaServer.maxUploadSizeMb` | Maximum accepted upload size in megabytes. | `8` |
| `mediaServer.retainHistory` | Number of historical media files to keep per source. | `0` |
| `mediaServer.showOnUpload` | Shows the overlay automatically when a new image is uploaded. | `true` |
| `mediaServer.duration` | Optional upload-specific overlay duration override. | `null` |
| `webhooks.basePath` | Base webhook path. | `"/api/homey-bridge"` |
| `webhooks.authToken` | Optional shared token accepted through header, bearer auth, or query string. | `""` |
| `mqtt.enabled` | Enables MQTT client startup. | `false` |
| `api.enabled` | Enables API pollers and media fetchers. | `false` |

## Endpoints

The integration module supports configurable routes under:

```text
POST /api/homey-bridge/*
```

If `mediaServer.enabled` is true, it also exposes:

```text
POST /api/homey-bridge/media/upload
GET  /api/homey-bridge/media/latest/:source
GET  /api/homey-bridge/media/meta/:source
```

`/media/upload` accepts multipart form uploads with the image in form field `image` by default. This matches Homey's Image Poster app.

## Display Actions

`MMM-HomeyIntegration` now uses a single self-contained display action.

- use `type: "display"` to show the latest snapshot as an overlay
- set `duration` to control how long the overlay stays visible
- uploads can trigger the overlay automatically with `mediaServer.showOnUpload`

## Snapshot Sizing

Use `snapshotSize` as the single image size setting.

- `snapshotSize: "1000px"` makes the image larger
- the image keeps its original aspect ratio automatically
- the module still limits the image to the available screen height so it does not get cropped

## Weather module integration

For the standard `weather` module:

- use `INDOOR_TEMPERATURE` to update indoor temp
- use `INDOOR_HUMIDITY` to update indoor humidity
- use `CURRENT_WEATHER_OVERRIDE` to override or augment current weather

If you want `CURRENT_WEATHER_OVERRIDE` to work, set this in the standard weather module:

```javascript
allowOverrideNotification: true
```

## Example webhook payloads

Indoor temperature:

```json
{
  "temperature": 21.7
}
```

Indoor humidity:

```json
{
  "humidity": 43
}
```

Weather override:

```json
{
  "weather": {
    "temperature": 5.2,
    "feelsLike": 2.8,
    "humidity": 81,
    "windSpeed": 4.5,
    "weatherType": "cloudy"
  }
}
```

Camera trigger:

```json
{
  "snapshotUrl": "http://camera.local/cgi-bin/snapshot.cgi"
}
```

Inline data URI trigger:

```json
{
  "cameraName": "Front Door",
  "duration": 60000,
  "snapshotUri": "data:image/jpeg;base64,..."
}
```

## Homey Image Poster app

If you use the Homey Image Poster app, point it to:

```text
http://<MAGICMIRROR_IP>:8132/api/homey-bridge/media/upload
```

The module will:

- receive the uploaded image file
- cache it locally
- optionally serve it back from `/api/homey-bridge/media/latest/<source>`
- optionally show it as an overlay immediately after upload

## Notes For Publishing

This README is structured to match common MagicMirror module expectations: short purpose, installation, example config, configuration reference, endpoints, and integration notes.

## Repository Notes

This repository intentionally does not include personal HomeyScript helpers or local media cache files.
