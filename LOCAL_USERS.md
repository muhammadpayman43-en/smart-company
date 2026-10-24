# Local users and permissions

- Local/server mode is determined by the database path (`remote:` means API),
  never by whether a user object exists.
- Local users reuse `admin_users` in their own SQLite database. Migration adds
  usernames, activation state, permission overrides, revisions and session
  versions in a transaction. No passwords or financial records are reset.
- A new database explicitly creates its first account as `super_admin`. For an
  existing legacy database, only its original first `admin` is promoted once.
  Other accounts are not promoted. Missing authentication grants no rights.
- Existing phone/full-name logins still work. Users also sign in by username.
  Existing passwords remain valid; new or changed user passwords follow the
  existing user-management minimum of 10 characters. Password hashes use Argon2.
- Native sessions are bound to the invoking webview and canonical SQLite path.
  Tauri checks the current database identity and permissions before dispatch,
  independently of React's role display. Access/password changes and disabling
  or deleting a user revoke existing sessions. Signing out clears the session.
- React, Express and Rust share `src/shared/permission-config.json`. User
  management requires `users.manage` plus the appropriate view/create/edit/delete
  permission. Delegates cannot grant rights they lack or create super admins.
- The last active super administrator cannot be deleted, disabled or demoted.
  These checks and user updates run in one immediate SQLite transaction. Deleted
  local accounts are retained with `deleted_at`; financial history is untouched.
- Local users/passwords are never queued for synchronization or copied to MongoDB.
  Connecting to LAN/Cloud uses independent existing central credentials and
  clears local native authentication. Central users still use `/api/v1/users`.
- The existing explicit "Start LAN" flow can bootstrap a separate central owner
  for an unlinked database. It now requires local owner credentials, describes
  this step in the UI, and never transfers ordinary local users/permissions.

## Verification

`cargo test --offline --manifest-path src-tauri/Cargo.toml --lib` exercises real
temporary SQLite databases, including migration, offline login, direct command
denial, revocation, stale revisions and concurrent last-owner protection.

`node tools/test-api-isolated.mjs` runs the existing central API tests with
disposable MongoDB/SQLite stores and leaves real databases unchanged.

`node tests/local-users-browser.mjs` exercises the actual React screens and
service routing in Edge using mocked native/HTTP responses. It is not a physical
multi-device Tauri test. No package or business-data migration is required.
