# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the Vite/React frontend into static assets.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS frontend
WORKDIR /app/frontend

# Install deps against the lockfile first for better layer caching.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Build the SPA → /app/frontend/dist
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime: Node + ffmpeg (libx264), backend serving UI + API + HLS.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# ffmpeg from Alpine ships with libx264 — required by the transcode ladder.
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
WORKDIR /app/backend

# Backend production dependencies only.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Backend source.
COPY backend/src ./src

# The server resolves the built client at ../../frontend/dist (relative to
# backend/src), so keep that layout inside the image.
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# data/ (SQLite) and media/ (HLS output) are mounted as volumes at runtime.
RUN mkdir -p /app/backend/data /app/backend/media

EXPOSE 4000

# node:sqlite is stable on Node 24; no experimental flag needed.
CMD ["node", "src/server.js"]
