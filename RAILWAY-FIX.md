# Vynx Railway deployment

Railway hosts only the Node.js backend/API/Socket.IO server and the existing static web frontend in `public/`.

Expo/React Native is NOT installed or built on Railway.

Build command:
`npm install`

Start command:
`npm start`

Keep Railway Root Directory empty and keep the existing environment variables.

The Android Expo project remains a separate project and connects to this same backend URL.
