#!/bin/sh
# Builds the `ghostlink-server start` arguments from environment variables, for
# container platforms such as Railway:
#   GHOSTLINK_DATA            data directory (default /data; mount a persistent volume)
#   GHOSTLINK_PORT            TCP port for HTTPS + WSS (default 7700)
#   GHOSTLINK_NAME            server name (first run only)
#   GHOSTLINK_PUBLIC_ADDRESS  comma-separated host:port list put in invites
#                             (e.g. the platform's TCP proxy address)
#   GHOSTLINK_NODE_IP         IPv4 announced for voice media
#   GHOSTLINK_VOICE           1 = run LiveKit (voice). Default 0: platforms without a
#                             reachable media path (no UDP, no proxy mode yet) keep
#                             voice marked unavailable instead of failing to connect.
set -eu

set -- start --data "${GHOSTLINK_DATA:-/data}" --port "${GHOSTLINK_PORT:-7700}"
if [ -n "${GHOSTLINK_NAME:-}" ]; then set -- "$@" --name "$GHOSTLINK_NAME"; fi
if [ -n "${GHOSTLINK_NODE_IP:-}" ]; then set -- "$@" --node-ip "$GHOSTLINK_NODE_IP"; fi
if [ -n "${GHOSTLINK_PUBLIC_ADDRESS:-}" ]; then
  for address in $(printf '%s' "$GHOSTLINK_PUBLIC_ADDRESS" | tr ',' ' '); do
    set -- "$@" --public-address "$address"
  done
fi
if [ "${GHOSTLINK_VOICE:-0}" = "1" ]; then
  export GHOSTLINK_LIVEKIT_BIN=/opt/livekit/livekit-server
fi

exec node /opt/ghostlink/dist/cli.js "$@"
