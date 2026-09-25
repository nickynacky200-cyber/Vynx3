# Vynx — Railway deployment

This repository is intentionally **root-ready**. The backend files and `package.json` are at the repository root, so Railway does not need a Root Directory setting.

## Railway
- Root Directory: leave empty
- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Keep your existing environment variables in Railway.

The build installs the Expo web project in `pwa-source/`, exports the PWA, and copies the finished web files into the root `pwa/` directory. The backend serves the existing root `public/` pages; wire the React PWA to `/pwa` in your server if you want it as the primary web app.

## Android
Use the separate `vynx-android-expo.zip`. Its API configuration points to the same Railway backend.
