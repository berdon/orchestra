# Orchestra Mobile

Cross-platform Android/iOS/web client for Orchestra's remote driver API.

## What it does

- pair with an Orchestra host using a one-time code
- browse projects and tasks
- approve tasks or send them back for work
- read and archive inbox messages
- use supervisor chat
- inspect session transcripts and send follow-up messages
- receive live updates over the remote WebSocket connection

## Run locally

### Native development

```bash
cd mobile
npm install
npm run start
```

Then use Expo to launch on Android or iOS.

### Shared web frontend

```bash
cd mobile
npm install
npm run web
```

To produce a static web build from the shared codebase:

```bash
cd mobile
npm run web:build
```

That writes the exported web app to `mobile/dist-web/`.

## Pairing flow

1. In the Orchestra desktop app, open **Settings → Remote**.
2. Enable remote access and save the settings.
3. Create a pairing code.
4. Enter the Orchestra host LAN URL and pairing code in the mobile app.
