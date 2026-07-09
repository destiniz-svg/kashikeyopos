# KashikeyoPOS Railway Build

This package is arranged for Railway as a Node/Express service.

Railway settings:

- Build: Dockerfile or Nixpacks auto-detect
- Start command: `npm start`
- Required variable: `DATABASE_URL`
- Recommended variable: `JWT_SECRET`

The Express server listens on `process.env.PORT`, initializes `schema.sql`, exposes `/api/health`, and serves the prebuilt PWA from `web/dist`.

Do not run a Vite build for this artifact. The frontend is already built and is served as static files by Express.
