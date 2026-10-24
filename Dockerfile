# Tauri embeds the built frontend while compiling the native worker.
FROM node:22-bookworm-slim AS frontend-build

WORKDIR /frontend
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

# Build the native SQLite worker used by the Express API.
FROM rust:1-bookworm AS worker-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libssl-dev \
    libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY src-tauri ./src-tauri
# The native permission guard embeds this shared policy at compile time.
COPY src/shared ./src/shared
COPY --from=frontend-build /frontend/dist ./dist
RUN cargo build --manifest-path src-tauri/Cargo.toml --release --bin spice-management-app

# Keep the production image small: Node API plus the compiled worker only.
FROM node:22-bookworm-slim

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server --omit=dev

COPY server ./server
# Server report handlers reuse the existing frontend report engine and policies.
COPY src ./src
COPY --from=worker-build /build/src-tauri/target/release/spice-management-app /usr/local/bin/spice-management-app

ENV NODE_ENV=production \
    DATABASE_WORKER=/usr/local/bin/spice-management-app

WORKDIR /app/server
CMD ["npm", "start"]
