# Spice Management API

Express API for organization-scoped accounts, central SQLite operations, permissions and synchronization events. MongoDB retains the existing JWT accounts and sync records. Financial operations run in the existing Rust/SQLite engine, shared with the desktop app.

## Local setup

1. Install dependencies from the repository root with `npm install --prefix server`.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` and a random `JWT_SECRET` of at least 32 characters.
3. Start MongoDB or use a MongoDB Atlas connection string.
4. Build the database worker with `cargo build --manifest-path src-tauri/Cargo.toml`. Set `DATABASE_WORKER` to the executable's absolute path when deploying elsewhere.
5. Start the API with `npm run api:dev` from the repository root.

The API binds **127.0.0.1:3000** by default. `GET /health` reports database readiness, protocol version and supported capabilities. Existing databases are never reset.

## Desktop LAN setup

In the local database's Settings → Network & server, select an actual IPv4 adapter and port, then enter that database owner's existing credentials. Start verifies those local credentials before launching the existing Express process, establishes the organization's central database mapping, and connects the host through the same API used by other clients. Other computers use the existing **Connect to Server Database** card with the copied address and an authorized username/password. Create additional users in Settings → Users & permissions.

Node.js, this `server` installation with its existing dependencies, MongoDB and a private `server/.env` containing `JWT_SECRET` must be available on the host. The desktop's Start/Stop controls own only the process they started. Packaged installations may set `SPICE_API_DIR` to their installed server directory; Node.js/MongoDB are not bundled by this change. A stopped host is unavailable to connected clients. Local standalone mode retains its existing offline owner login; central users and their permissions apply to API sessions.

For an explicitly administered standalone LAN listener, set `API_HOST` to one of the addresses from `node src/control.js`, and `LAN_ENABLED=true`. Binding all interfaces in LAN mode is deliberately rejected. Allow the chosen port through the host firewall only for the intended private network.

## Cloud setup and existing organizations

Use the **same API** behind a TLS reverse proxy. Set `SERVER_MODE=cloud`, `PUBLIC_API_URL=https://api.example.com` and the exact trusted proxy via `TRUST_PROXY` (for example `loopback` for a local proxy). Cloud API requests without trusted HTTPS are rejected. Configure `API_HOST` for the deployment, and add the deployed frontend's exact origin to `CLIENT_ORIGINS`. Clients select Cloud and enter the HTTPS API address. No MongoDB credentials or SQLite paths are sent to clients.

New organization registration provisions an isolated SQLite database under `SQLITE_DATA_DIR` (default `server/data`). To attach an existing database to an existing MongoDB organization, run on the server:

```sh
node src/control.js --assign ORGANIZATION_ID /absolute/path/to/existing.sqlite3
```

This is an administrator CLI operation, never an HTTP file-path parameter. A canonical database path can belong to only one organization. Back up the database before an administrator changes its deployment. Legacy accounts remain usable; the oldest active account of a legacy organization is promoted once to Super Admin. Set globally unique usernames for legacy cloud users whose phone numbers are duplicated between organizations.

## Endpoints

- `POST /api/v1/auth/register`: create an organization and its first administrator. Requires `companyName`, `firstName`, `lastName`, `phone`, and a password of at least 10 characters.
- `POST /api/v1/auth/login`: exchange `organizationId`, `phone`, and `password` for a 12-hour bearer token.
- `POST /api/v1/sync/push`: append up to 100 idempotent local changes. Requires a bearer token and UUID `eventId` values.
- `GET /api/v1/sync/pull?cursor=<cursor>`: retrieve the next page of changes for the authenticated organization.
- `GET /api/v1/auth/me`: current active user and effective permissions; every request rechecks the current account and token version.
- `GET/POST /api/v1/users`, `PUT/DELETE /api/v1/users/:id`: organization-scoped user administration, requiring Manage Users and the corresponding action. Updates include `revision`; deletion uses `If-Match`.
- `POST /api/v1/data/:command`: allowlisted existing database commands with `{ "args": ... }`. All writes require a UUID `Idempotency-Key`. Edits/deletes use `If-Match` with the revision returned by reads. Server-selected database paths always override client input.

Role defaults are shared by React and Express in `src/shared/permissions.js`. Explicit booleans override role defaults, including explicit denials. Super Admin always retains all permissions. Administrators cannot grant permissions they do not possess or modify a Super Admin. The last active Super Admin cannot be removed, disabled or demoted; an atomic reservation protects concurrent administration. An uncertain MongoDB failure during demotion conservatively retains the reservation rather than risking removal of the final administrator.

SQLite uses WAL, busy timeouts and immediate transactions. A remote command, its saved response, audit entry and revision commit atomically. Retrying the same command with the same key returns its stored result even after a worker restart. Reusing a key with a different user or payload returns 409. A conflict returns 409 and the client requests a reload. Central sessions read current server data and refresh open lists every five seconds; disconnected central writes fail instead of being queued or written to a local database. Existing standalone sync outboxes remain in place.

Sync events are append-only. Clients apply them to their local database and persist the returned cursor. Data is always scoped to the organization in the verified token; clients cannot select another organization in the request body.

## Checks

Run `npm run api:check` and `npm run api:test` from the repository root. The original API checks do not require MongoDB. `central.test.js` requires a running MongoDB at 127.0.0.1:27017 and a built worker; it creates a uniquely named `spice_central_test_*` MongoDB database and temporary SQLite files, tests two authenticated LAN clients and cleans up only those test resources. It never uses production database files. Run the Rust regression tests with `cargo test --manifest-path src-tauri/Cargo.toml --offline --lib`.

### Verification in this workspace

- 24 API tests passed against real isolated MongoDB and SQLite databases, including two LAN clients, central sales/stock/cash, permissions, user deletion, last-admin protection, concurrency, idempotent retries after worker restart, server startup/shutdown and HTTPS proxy enforcement.
- 16 existing Rust tests and 11 existing report/cash calculation tests passed.
- 11 browser checks passed against the real API: connection card, health/version check, login, settings, creating a central user, live password confirmation, role defaults, restricted navigation and mobile RTL. No browser exceptions were observed.
- Frontend production build and API syntax checks passed. The existing large JavaScript bundle warning remains.

The LAN clients were separate HTTP clients on this computer; two physical computers and a deployed public HTTPS server were not available for testing. The native Tauri Start/Stop IPC was compiled; its underlying API bootstrap/lifecycle was tested in a real child process, rather than through an interactive native window.

### Changed source files

- Connection/session: `src/App.jsx`, `src/pages/LoginPage/LoginPage.jsx`, `src/componets/database/ServerConnection.jsx`, `ServerConnection.css`, `src/sevices/api.js`, `database.js`, `remote.js`, `sync.js`.
- Shared access/navigation: `src/shared/permissions.js`, `src/context/AccessContext.jsx`, `src/hooks/useRemoteRefresh.js`, `src/componets/common/PermissionControls.jsx`, `PrintControls/PrintControls.jsx`, `src/componets/layout/Sidebar/Sidebar.jsx`, `MobileNavigation/MobileNavigation.jsx`.
- Settings: `src/pages/Settings/Settings.jsx`, `NetworkSettings.jsx`, `NetworkSettings.css`, `UserManagement.jsx`; translations: `src/i18n/network.js`, `translation.jsx`.
- Existing page integration: `Dashboard/Dashboard.jsx`, `DashboardHome.jsx`, `MobileLayout.css`, `Products/Products.jsx`, `Purchases/Purchases.jsx`, `Sales/Sales.jsx`, `Customers/Customers.jsx`, `Companies/Companies.jsx`, `Expenses/Expenses.jsx`, `Reports/Reports.jsx`, `Reports/reportEngine.js` under `src/pages`. These receive permission controls, API routing, revision metadata or remote refresh; the dashboard calculation was moved into the existing shared report engine.
- Existing API: `server/src/app.js`, `server.js`, `access.js`, `database.js`, `control.js`, `config/env.js`, `middleware/authenticate.js`, `models/User.js`, `Organization.js`, `AuditLog.js`, `routes/auth.js`, `sync.js`, `data.js`, `users.js`; `server/test/central.test.js`, `server/package.json`, `.env.example`, this guide.
- Existing native engine: `src-tauri/src/lib.rs`, `main.rs`, `database_api.rs`, `network.rs`; `cash.rs` and `reports.rs` only lose unnecessary mutable bindings after the shared connection adaptation.
- `.gitignore` excludes central data files. An ignored `server/.env` was prepared locally with a private random JWT secret; no existing configuration was replaced.
