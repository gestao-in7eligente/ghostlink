#!/bin/sh
# Builds the `ghostlink-server start` arguments from environment variables, for
# container platforms such as Railway:
#   GHOSTLINK_DATA            data directory (default /data; mount a persistent volume)
#   GHOSTLINK_PORT            TCP port for HTTPS + WSS (default: RAILWAY_TCP_APPLICATION_PORT,
#                             the port Railway's TCP proxy forwards to, else 7700)
#   GHOSTLINK_NAME            server name (first run only)
#   GHOSTLINK_PUBLIC_ADDRESS  comma-separated host:port list put in invites
#                             (default in proxy mode: the proxy's address)
#   GHOSTLINK_NODE_IP         IPv4 announced for voice media (default in proxy mode:
#                             the proxy host's IPv4, resolved again every 5 minutes)
#   GHOSTLINK_VOICE           1 = run LiveKit (voice). Default 0: voice is marked
#                             unavailable instead of failing to connect.
#
# Proxy mode (spec §8.6): for platforms that forward ONE TCP port and no UDP, the public
# port carries HTTPS/WSS and voice (ICE-TCP), LiveKit listens on the proxy's external
# port inside the container, and the per-IP limits become server-wide. It is on when:
#   GHOSTLINK_PROXY_ADDRESS   is set: the proxy's external host:port; else when
#   RAILWAY_TCP_PROXY_DOMAIN and RAILWAY_TCP_PROXY_PORT are both set (Railway sets them
#                             once the service has a TCP proxy); else when
#   GHOSTLINK_PROXY_MODE=1    with the first GHOSTLINK_PUBLIC_ADDRESS as the proxy.
#   GHOSTLINK_PROXY_MODE=0    keeps it off, even on Railway.
# The proxy's external port must differ from GHOSTLINK_PORT (LiveKit listens on it).
set -eu

port="${GHOSTLINK_PORT:-${RAILWAY_TCP_APPLICATION_PORT:-7700}}"
if [ -n "${RAILWAY_TCP_APPLICATION_PORT:-}" ] && [ "$RAILWAY_TCP_APPLICATION_PORT" != "$port" ]; then
  echo "Warning: Railway's TCP proxy forwards to port $RAILWAY_TCP_APPLICATION_PORT, but the server listens on $port (GHOSTLINK_PORT)." >&2
fi

proxy=""
case "${GHOSTLINK_PROXY_MODE:-}" in
  0) ;;
  *)
    if [ -n "${GHOSTLINK_PROXY_ADDRESS:-}" ]; then
      proxy="$GHOSTLINK_PROXY_ADDRESS"
    elif [ -n "${RAILWAY_TCP_PROXY_DOMAIN:-}" ] && [ -n "${RAILWAY_TCP_PROXY_PORT:-}" ]; then
      proxy="$RAILWAY_TCP_PROXY_DOMAIN:$RAILWAY_TCP_PROXY_PORT"
    elif [ "${GHOSTLINK_PROXY_MODE:-}" = "1" ]; then
      proxy="$(printf '%s' "${GHOSTLINK_PUBLIC_ADDRESS:-}" | cut -d, -f1 | tr -d ' ')"
      if [ -z "$proxy" ]; then
        echo "GHOSTLINK_PROXY_MODE=1 needs the proxy's external host:port in GHOSTLINK_PROXY_ADDRESS or GHOSTLINK_PUBLIC_ADDRESS." >&2
        exit 1
      fi
    fi
    ;;
esac

set -- start --data "${GHOSTLINK_DATA:-/data}" --port "$port"
if [ -n "${GHOSTLINK_NAME:-}" ]; then set -- "$@" --name "$GHOSTLINK_NAME"; fi
if [ -n "${GHOSTLINK_NODE_IP:-}" ]; then set -- "$@" --node-ip "$GHOSTLINK_NODE_IP"; fi
if [ -n "${GHOSTLINK_PUBLIC_ADDRESS:-}" ]; then
  for address in $(printf '%s' "$GHOSTLINK_PUBLIC_ADDRESS" | tr ',' ' '); do
    set -- "$@" --public-address "$address"
  done
fi
if [ -n "$proxy" ]; then set -- "$@" --proxy "$proxy"; fi
if [ "${GHOSTLINK_VOICE:-0}" = "1" ]; then
  export GHOSTLINK_LIVEKIT_BIN=/opt/livekit/livekit-server
fi

exec node /opt/ghostlink/dist/cli.js "$@"
