# syntax=docker/dockerfile:1
# GhostLink server image for cloud platforms (Railway, any Docker host).
# Build from the repository root:
#   docker build -f apps/server/docker/Dockerfile -t ghostlink-server .
# Configuration is by environment variables (see entrypoint.sh); data lives in /data
# (mount a persistent volume there: it holds the TLS key = the server identity).

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
# npm ci validates every workspace listed in the lockfile; the desktop app is not installed.
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --workspace @ghostlink/server --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/server apps/server
# One self-contained file: dist/cli.js (+ dist/migrations/).
RUN npm run build -w @ghostlink/server

FROM debian:bookworm-slim AS livekit
# Pinned LiveKit, verified against the official checksums.txt (spec §8.1).
ARG LIVEKIT_VERSION=1.13.7
ARG LIVEKIT_SHA256_AMD64=6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 5 -o /tmp/livekit.tar.gz \
      "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz" \
 && echo "${LIVEKIT_SHA256_AMD64}  /tmp/livekit.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/livekit \
 && tar -xzf /tmp/livekit.tar.gz -C /opt/livekit livekit-server

FROM node:24-bookworm-slim
COPY --from=build /src/apps/server/dist /opt/ghostlink/dist
COPY --from=livekit /opt/livekit/livekit-server /opt/livekit/livekit-server
COPY apps/server/docker/entrypoint.sh /opt/ghostlink/entrypoint.sh
RUN chmod 0755 /opt/ghostlink/entrypoint.sh
ENV GHOSTLINK_DATA=/data \
    NODE_ENV=production
# 7700/TCP: HTTPS + WSS (self-signed, pinned by clients). 7881/TCP: voice over ICE-TCP.
EXPOSE 7700 7881
ENTRYPOINT ["/opt/ghostlink/entrypoint.sh"]
