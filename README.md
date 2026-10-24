# Spice Management

Offline-first desktop inventory management built with Tauri, React, and SQLite. The Express API in `server/` provides organization-scoped authentication and cloud sync endpoints backed by MongoDB.

## Desktop development

Install desktop dependencies with `npm install`, then launch the app with `npm run tauri dev`. Run the production frontend build with `npm run build`.

When creating a company database, choose a folder and database name. The desktop app creates a new `.sqlite3` file in that folder, stores company and administrator data locally, hashes the password with Argon2, and queues a non-sensitive company record for synchronization. Existing database files are never overwritten.

## API development

Install API dependencies with `npm install --prefix server`, copy `server/.env.example` to `server/.env`, and set a MongoDB URI and a random JWT secret of at least 32 characters. Start the API with `npm run api:dev`.

Set `VITE_API_BASE_URL` at frontend build time to the deployed API URL. The default is `http://127.0.0.1:3000/api/v1`.

## Synchronization status

Local outbox events can be read and acknowledged through Tauri, and `syncPendingChanges` pushes pending events when supplied with a database path and a valid API bearer token. Network failures leave outbox events pending for retry. A desktop sign-in/session flow that obtains and stores this token, automatic retry scheduling, and applying cloud pull events to SQLite are not implemented yet.

Validate the API with `npm run api:check` and `npm run api:test`. Validate local persistence with `cargo test --manifest-path src-tauri/Cargo.toml`.