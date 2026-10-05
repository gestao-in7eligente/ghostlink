#!/usr/bin/env bash
# GhostLink server installer for a VPS (spec §10). Ubuntu 22.04+ or Debian 12+, as root.
#
#   curl -fsSLO https://github.com/gestao-in7eligente/ghostlink/releases/latest/download/install.sh
#   sudo bash install.sh [--node-ip <ipv4>] [--port 7700] [--name "My server"]
#
# Idempotent: running it again updates GhostLink and LiveKit and keeps the data
# (/var/lib/ghostlink) and the settings of the first run (/etc/ghostlink/install.conf).
# It never installs a version older than the installed one without --allow-downgrade.
#
# Automatic update (spec "servidores acompanham o app" §4): unless --no-auto-update, it copies
# itself to /opt/ghostlink/install.sh and installs ghostlink-update.timer, which runs
# `install.sh --auto-update` every hour: a newer release is downloaded and checked like below
# and prepared in /opt/ghostlink/releases/<version>, and `current` switches to it only when
# the server's status.json says nobody is in a voice call, or once it has waited 24 h.
#
# Every download is verified before use:
#   - checksums-sha256.txt against its Ed25519 signature by the release key (below),
#     before any of its lines is used; then the server package against its single line
#     there, which pins the bytes of this version (an older genuine package is refused),
#     and against its own Ed25519 signature, plus the Sigstore bundle of the checksums
#     (signed by release.yml for this tag) when cosign is installed; once unpacked, the
#     package's package.json must carry the requested version;
#   - LiveKit against SHA-256 values pinned in this file.
# The public IP comes from the routing table (ip -4 route get 1.1.1.1), which sends
# no packet; no external service is asked.
set -euo pipefail

GHOSTLINK_REPO="gestao-in7eligente/ghostlink"
# Raw Ed25519 public key (base64url, 32 bytes) of the release signing key (same value as
# RELEASE_PUBLIC_KEY in packages/shared/src/release.ts).
RELEASE_PUBLIC_KEY_B64URL="Hhib591tl4P4Nf9us1fB5FCXXbGOZDBHwvWIu-2FWnc"
# Sigstore: the checksums are signed by the release workflow run of the version's tag.
SIGSTORE_OIDC_ISSUER="https://token.actions.githubusercontent.com"

LIVEKIT_VERSION="1.13.7"
# From https://github.com/livekit/livekit/releases/download/v1.13.7/checksums.txt
LIVEKIT_SHA256_AMD64="6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2"
LIVEKIT_SHA256_ARM64="5d167fdf52cf43c0c72972f25325364479f41f854bfef651056eab2504da5de9"

NODE_MAJOR=24
INSTALL_DIR="/opt/ghostlink"
DATA_DIR="/var/lib/ghostlink"
CONF_DIR="/etc/ghostlink"
CONF_FILE="${CONF_DIR}/install.conf"
SERVICE_USER="ghostlink"
UNIT_FILE="/etc/systemd/system/ghostlink.service"
MEDIA_UDP_PORT=7882
MEDIA_TCP_PORT=7881

# Automatic update. The pending file lives in the root-owned install directory, not in the
# data directory, which the server's user owns (it could plant a symlink there for root).
UPDATER="${INSTALL_DIR}/install.sh"
UPDATE_SERVICE_FILE="/etc/systemd/system/ghostlink-update.service"
UPDATE_TIMER_FILE="/etc/systemd/system/ghostlink-update.timer"
PENDING_FILE="${INSTALL_DIR}/update-pending"
# Written by the server every 60 s and whenever someone joins or leaves voice.
STATUS_FILE="${DATA_DIR}/status.json"
STATUS_MAX_AGE_S=180
# A prepared update waits at most this long for a moment without calls.
UPDATE_MAX_WAIT_S=86400

WORK=""
DRY_RUN=0
ASSUME_YES=0
ALLOW_DOWNGRADE=0
OPT_NODE_IP=""
OPT_PORT=""
OPT_NAME=""
OPT_VERSION=""
# install | auto-update | auto-update-off | auto-update-on
ACTION="install"
# 1: install the automatic update, 0: leave it out; empty until the options or install.conf say.
AUTO_UPDATE=""

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

# Runs a command, or only prints it with --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

# Writes stdin to a file (mode $2), or prints it with --dry-run.
write_file() {
  local path="$1" mode="$2" content
  content="$(cat)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ write %s (mode %s):\n%s\n' "$path" "$mode" "$content"
  else
    install -d -m 0755 "$(dirname "$path")"
    printf '%s\n' "$content" >"${path}.tmp"
    chmod "$mode" "${path}.tmp"
    mv -f "${path}.tmp" "$path"
  fi
}

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh [options]

Installs or updates the GhostLink server (Node.js 24, the ghostlink user,
/opt/ghostlink, data in /var/lib/ghostlink, a hardened systemd service).

Options:
  --node-ip <ipv4>   Public IP announced to voice clients and put in invites
                     (default: this machine's IP on the default route, if public)
  --port <n>         TCP port of the server (default 7700)
  --name <text>      Server name, first install only (letters, digits, space . _ -)
  --version <x.y.z>  Install this version instead of the latest release
  --allow-downgrade  Allow a version older than the installed one (the data in
                     /var/lib/ghostlink may not work with it); refused otherwise
  --no-auto-update   Leave out the automatic update (remembered for later runs)
  --yes              Never ask; fail when a value is missing
  --dry-run          Print every action without changing anything
  -h, --help         Show this help

Automatic update of an installed server (on by default, every hour):
  --auto-update      Update now if a newer release is out: it is downloaded, checked
                     and prepared, and the server switches to it only when nobody is
                     in a voice call, or once it has waited 24 h
  --auto-update off  Remove the automatic update
  --auto-update on   Put it back
EOF
}

# ---------- validation (pure, sourced by the tests) ----------

is_ipv4() {
  local ip="$1" IFS=. part
  [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  # shellcheck disable=SC2086
  set -- $ip
  for part in "$@"; do
    [ "$part" -le 255 ] || return 1
    [[ "$part" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  done
}

# Private, loopback, link-local, CGNAT or unspecified: not reachable from the internet.
is_private_ipv4() {
  local a b
  IFS=. read -r a b _ _ <<<"$1"
  [ "$a" = 10 ] || [ "$a" = 127 ] || [ "$a" = 0 ] && return 0
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 0
  [ "$a" = 169 ] && [ "$b" = 254 ] && return 0
  [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 0
  return 1
}

is_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# version_lt <a> <b>: version a is older than version b (numeric order: 0.9.0 < 0.10.0).
version_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

# Safe inside a double-quoted systemd argument: no quotes, backslashes, % or control characters.
is_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,63}$ ]]
}

# The source address of the default route, from `ip -4 route get 1.1.1.1` output on stdin.
route_source_ip() {
  sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1
}

# The tag of the latest release, from the GitHub API JSON on stdin ("v0.1.0" → "0.1.0").
latest_version_from_json() {
  sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' | head -n 1
}

# ---------- verification (sourced by the tests) ----------

sha256_of() {
  sha256sum "$1" | cut -d' ' -f1
}

# verify_checksum <file> <checksums-file> <name>: the checksums file (already authenticated)
# must have exactly one line "<sha256>  <name>" for <name>, and its hash must be the file's.
# A missing, duplicate or conflicting line is refused, never resolved by picking one.
verify_checksum() {
  local file="$1" sums="$2" name="$3" actual
  actual="$(sha256_of "$file")"
  [[ "$actual" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "$(awk -v n="$name" 'length($0) > 66 && substr($0, 67) == n' "$sums" | wc -l)" -eq 1 ] || {
    warn "$(basename "$sums") must have exactly one line for $name"
    return 1
  }
  grep -qFx -- "$actual  $name" "$sums"
}

# verify_ed25519 <file> <signature-file> <public-key-b64url>: detached signature over the
# file bytes. The signature file holds 64 raw bytes or their base64/base64url text.
verify_ed25519() {
  local file="$1" sig="$2" key="$3" work b64 pad
  [[ "$key" =~ ^[A-Za-z0-9_-]{43}$ ]] || {
    warn "invalid release public key"
    return 1
  }
  work="$(mktemp -d)"
  # base64url → base64 with padding.
  b64="$(printf '%s' "$key" | tr '_-' '/+')"
  pad=$(((4 - ${#b64} % 4) % 4))
  b64="${b64}$(printf '%*s' "$pad" '' | tr ' ' '=')"
  # SubjectPublicKeyInfo DER for Ed25519 = fixed 12-byte prefix + the 32-byte key.
  { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; printf '%s' "$b64" | base64 -d; } >"$work/key.der"
  if [ "$(wc -c <"$sig")" -eq 64 ]; then
    cp "$sig" "$work/sig.bin"
  else
    tr -d ' \r\n' <"$sig" | tr '_-' '/+' >"$work/sig.b64"
    pad=$(((4 - $(wc -c <"$work/sig.b64") % 4) % 4))
    printf '%*s' "$pad" '' | tr ' ' '=' >>"$work/sig.b64"
    base64 -d <"$work/sig.b64" >"$work/sig.bin" 2>/dev/null || true
  fi
  local ok=1
  if [ "$(wc -c <"$work/sig.bin")" -eq 64 ] &&
    openssl pkeyutl -verify -pubin -keyform DER -inkey "$work/key.der" -rawin -in "$file" -sigfile "$work/sig.bin" >/dev/null 2>&1; then
    ok=0
  fi
  rm -rf "$work"
  return "$ok"
}

# ---------- steps ----------

check_os() {
  local release=/etc/os-release id version major minimum
  # Test hooks (GHOSTLINK_TEST_*) are only honoured with --dry-run.
  [ "$DRY_RUN" = 1 ] && [ -n "${GHOSTLINK_TEST_OS_RELEASE:-}" ] && release="$GHOSTLINK_TEST_OS_RELEASE"
  [ -r "$release" ] || die "cannot read $release: this installer supports Ubuntu 22.04+ and Debian 12+"
  id="$(sed -n 's/^ID=//p' "$release" | tr -d '"')"
  version="$(sed -n 's/^VERSION_ID=//p' "$release" | tr -d '"')"
  major="${version%%.*}"
  case "$id" in
    ubuntu) minimum=22 ;;
    debian) minimum=12 ;;
    *) die "unsupported system '$id' (Ubuntu 22.04+ or Debian 12+)" ;;
  esac
  if ! [[ "$major" =~ ^[0-9]+$ ]] || [ "$major" -lt "$minimum" ]; then
    die "$id $version is too old (Ubuntu 22.04+ or Debian 12+)"
  fi
  say "System: $id $version"
}

detect_arch() {
  local m
  m="$(uname -m)"
  [ "$DRY_RUN" = 1 ] && [ -n "${GHOSTLINK_TEST_ARCH:-}" ] && m="$GHOSTLINK_TEST_ARCH"
  case "$m" in
    x86_64 | amd64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "unsupported CPU '$m' (x86_64 or arm64)" ;;
  esac
}

install_packages() {
  say "Installing the system packages…"
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q ca-certificates curl gnupg openssl tar iproute2
  # ffmpeg: the Ghost DJ (music bot) decodes with it; without it the DJ stays off.
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ffmpeg
}

install_node() {
  local current=""
  if command -v node >/dev/null 2>&1; then current="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"; fi
  if [ "$DRY_RUN" = 0 ] && [[ "$current" =~ ^[0-9]+$ ]] && [ "$current" -ge "$NODE_MAJOR" ]; then
    say "Node.js $(node -v) is already installed."
    return
  fi
  say "Installing Node.js ${NODE_MAJOR}.x from NodeSource…"
  # The repository is added by hand (signed-by keyring), no remote script is piped into bash.
  run install -d -m 0755 /usr/share/keyrings
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg\n'
  else
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  fi
  write_file /etc/apt/sources.list.d/nodesource.list 0644 <<EOF
deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main
EOF
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
}

create_user() {
  if id -u "$SERVICE_USER" >/dev/null 2>&1 && [ "$DRY_RUN" = 0 ]; then
    say "User $SERVICE_USER exists."
  else
    run useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  run install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
}

resolve_version() {
  if [ -n "$OPT_VERSION" ]; then
    VERSION="$OPT_VERSION"
  elif [ -n "${GHOSTLINK_TEST_LATEST_JSON:-}" ] && [ "$DRY_RUN" = 1 ]; then
    VERSION="$(printf '%s' "$GHOSTLINK_TEST_LATEST_JSON" | latest_version_from_json)"
  else
    VERSION="$(curl -fsSL "https://api.github.com/repos/${GHOSTLINK_REPO}/releases/latest" | latest_version_from_json)"
  fi
  is_version "$VERSION" || die "could not find the latest GhostLink version (use --version x.y.z)"
  say "GhostLink version: $VERSION"
}

# $INSTALL_DIR/current, the link to releases/<version> the service runs.
current_link() {
  local link="$INSTALL_DIR/current"
  [ "$DRY_RUN" = 1 ] && [ -n "${GHOSTLINK_TEST_CURRENT:-}" ] && link="$GHOSTLINK_TEST_CURRENT"
  printf '%s\n' "$link"
}

# The releases/ directory next to current_link.
releases_dir() {
  printf '%s/releases\n' "$(dirname "$(current_link)")"
}

# The version $INSTALL_DIR/current points to (releases/<version>), or nothing.
installed_version() {
  local link version
  link="$(current_link)"
  [ -e "$link" ] || return 0
  version="$(basename "$(readlink -f "$link")")"
  if is_version "$version"; then printf '%s\n' "$version"; fi
}

# No rollback: an older release (a stale "latest", a mistyped --version) is refused unless
# --allow-downgrade is given. The same version again is an ordinary update.
check_downgrade() {
  local installed
  installed="$(installed_version)"
  [ -n "$installed" ] || return 0
  say "Installed version: $installed"
  version_lt "$VERSION" "$installed" || return 0
  [ "$ALLOW_DOWNGRADE" = 1 ] || die "GhostLink $installed is installed and $VERSION is older: refused (a downgrade may not read the data in $DATA_DIR; use --allow-downgrade to install it anyway)"
  warn "downgrading GhostLink from $installed to $VERSION (--allow-downgrade)"
}

download() {
  local url="$1" out="$2"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ download %s\n' "$url"
    # Test hook: the release files come from a local directory, so their checks really run.
    if [ -n "${GHOSTLINK_TEST_RELEASE_DIR:-}" ]; then cp "$GHOSTLINK_TEST_RELEASE_DIR/${url##*/}" "$out"; fi
  else
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$out" "$url"
  fi
}

# The "version" field of a package.json.
package_version() {
  node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(typeof p.version === "string" ? p.version : "")' <"$1" 2>/dev/null || true
}

# Downloads the server package of $VERSION and checks it, then sets SERVER_ROOT to the
# unpacked package. With --dry-run it only prints the steps, unless the release files are
# local (test hook): then the checks really run and SERVER_ROOT is set.
fetch_server() {
  SERVER_ROOT=""
  local base="https://github.com/${GHOSTLINK_REPO}/releases/download/v${VERSION}"
  local tgz="ghostlink-server-${VERSION}.tgz" sums="checksums-sha256.txt"
  local identity="https://github.com/${GHOSTLINK_REPO}/.github/workflows/release.yml@refs/tags/v${VERSION}"
  local work="$WORK/server" key="$RELEASE_PUBLIC_KEY_B64URL"
  [ "$DRY_RUN" = 1 ] && [ -n "${GHOSTLINK_TEST_RELEASE_KEY:-}" ] && key="$GHOSTLINK_TEST_RELEASE_KEY"
  mkdir -p "$work"
  say "Downloading ${tgz}…"
  download "$base/$tgz" "$work/$tgz"
  download "$base/$sums" "$work/$sums"
  download "$base/$sums.ed25519" "$work/$sums.ed25519"
  download "$base/$tgz.ed25519" "$work/$tgz.ed25519"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ verify Ed25519 signature %s.ed25519 with the release key, before using %s\n' "$sums" "$sums"
    printf '+ verify sha256 of %s against its single line in %s\n' "$tgz" "$sums"
    printf '+ verify Ed25519 signature %s.ed25519\n' "$tgz"
    printf '+ if cosign is installed: cosign verify-blob --bundle %s.sigstore.json --certificate-identity %s --certificate-oidc-issuer %s %s\n' \
      "$sums" "$identity" "$SIGSTORE_OIDC_ISSUER" "$sums"
    printf '+ check that the package.json version is %s\n' "$VERSION"
    # Test hook: with local release files, the checks below run too (nothing is installed).
    [ -n "${GHOSTLINK_TEST_RELEASE_DIR:-}" ] || return 0
  fi
  # checksums-sha256.txt is trusted only once its own signature checks out: its line for
  # this version pins the package bytes, which the package's own signature alone does not
  # (an older genuine package with its genuine .ed25519 would pass that one).
  verify_ed25519 "$work/$sums" "$work/$sums.ed25519" "$key" || die "invalid Ed25519 signature for $sums: download refused"
  verify_checksum "$work/$tgz" "$work/$sums" "$tgz" || die "checksum mismatch for $tgz: download refused"
  verify_ed25519 "$work/$tgz" "$work/$tgz.ed25519" "$key" || die "invalid Ed25519 signature for $tgz: download refused"
  say "Signed checksums, checksum and Ed25519 signature OK."
  if [ "$DRY_RUN" = 0 ] && command -v cosign >/dev/null 2>&1; then
    download "$base/$sums.sigstore.json" "$work/$sums.sigstore.json"
    cosign verify-blob --bundle "$work/$sums.sigstore.json" \
      --certificate-identity "$identity" \
      --certificate-oidc-issuer "$SIGSTORE_OIDC_ISSUER" \
      "$work/$sums" >/dev/null || die "the Sigstore bundle does not match $sums"
    say "Sigstore bundle OK."
  fi
  mkdir -p "$work/unpacked"
  tar -xzf "$work/$tgz" -C "$work/unpacked" --no-same-owner
  local cli
  cli="$(find "$work/unpacked" -maxdepth 3 -type f -path '*dist/cli.js' | head -n 1)"
  [ -n "$cli" ] || die "the package has no dist/cli.js"
  local root package
  root="$(dirname "$(dirname "$cli")")"
  [ -f "$root/package.json" ] || die "the package has no package.json"
  package="$(package_version "$root/package.json")"
  [ "$package" = "$VERSION" ] || die "the package is version '$package', not $VERSION: download refused"
  say "Package version $VERSION OK."
  SERVER_ROOT="$root"
}

# Copies the checked package (fetch_server) to releases/$VERSION. `current` is not touched.
stage_server() {
  local target="$INSTALL_DIR/releases/$VERSION"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ stage ghostlink-server-%s.tgz into %s\n' "$VERSION" "$target"
    return
  fi
  rm -rf "$target.new"
  install -d -m 0755 "$INSTALL_DIR/releases"
  cp -a "$SERVER_ROOT" "$target.new"
  chown -R root:root "$target.new"
  chmod -R go-w "$target.new"
  rm -rf "$target"
  mv "$target.new" "$target"
}

# Points $INSTALL_DIR/current at releases/<version>, atomically (rename of a new link).
switch_current() {
  local target="$INSTALL_DIR/releases/$1"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ switch %s/current to %s\n' "$INSTALL_DIR" "$target"
    return
  fi
  ln -sfn "$target" "$INSTALL_DIR/current.new"
  mv -Tf "$INSTALL_DIR/current.new" "$INSTALL_DIR/current"
}

install_server() {
  fetch_server
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ install ghostlink-server-%s.tgz into %s/releases/%s and switch %s/current\n' "$VERSION" "$INSTALL_DIR" "$VERSION" "$INSTALL_DIR"
    return
  fi
  stage_server
  switch_current "$VERSION"
  say "Installed GhostLink $VERSION in $INSTALL_DIR/releases/$VERSION."
}

install_livekit() {
  local sha name url dir="$INSTALL_DIR/livekit"
  case "$ARCH" in
    amd64) sha="$LIVEKIT_SHA256_AMD64" ;;
    arm64) sha="$LIVEKIT_SHA256_ARM64" ;;
  esac
  name="livekit_${LIVEKIT_VERSION}_linux_${ARCH}.tar.gz"
  url="https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/${name}"
  if [ "$DRY_RUN" = 0 ] && [ "$(cat "$dir/VERSION" 2>/dev/null || true)" = "$LIVEKIT_VERSION-$ARCH" ] && [ -x "$dir/livekit-server" ]; then
    say "LiveKit $LIVEKIT_VERSION is already installed."
    return
  fi
  say "Downloading LiveKit $LIVEKIT_VERSION ($ARCH)…"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ download %s\n+ verify sha256 %s\n+ install livekit-server into %s\n' "$url" "$sha" "$dir"
    return
  fi
  local work="$WORK/livekit"
  mkdir -p "$work"
  download "$url" "$work/$name"
  [ "$(sha256_of "$work/$name")" = "$sha" ] || die "LiveKit checksum mismatch: download refused"
  tar -xzf "$work/$name" -C "$work" --no-same-owner livekit-server
  install -d -m 0755 "$dir"
  install -m 0755 -o root -g root "$work/livekit-server" "$dir/livekit-server"
  printf '%s\n' "$LIVEKIT_VERSION-$ARCH" >"$dir/VERSION"
  say "LiveKit installed in $dir."
}

# Settings of the first run, kept for updates (strict key=value parsing, never sourced).
load_conf() {
  [ -r "$CONF_FILE" ] || return 0
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      NODE_IP) [ -z "$OPT_NODE_IP" ] && is_ipv4 "$value" && OPT_NODE_IP="$value" ;;
      PORT) [ -z "$OPT_PORT" ] && is_port "$value" && OPT_PORT="$value" ;;
      NAME) [ -z "$OPT_NAME" ] && is_name "$value" && OPT_NAME="$value" ;;
      AUTO_UPDATE) [ -z "$AUTO_UPDATE" ] && [[ "$value" =~ ^[01]$ ]] && AUTO_UPDATE="$value" ;;
    esac
  done <"$CONF_FILE"
  # The loop's status is its last line's: a key already set by an option is not an error.
  return 0
}

save_conf() {
  write_file "$CONF_FILE" 0644 <<EOF
NODE_IP=$NODE_IP
PORT=$PORT
NAME=$OPT_NAME
AUTO_UPDATE=$AUTO_UPDATE
EOF
}

resolve_node_ip() {
  PORT="${OPT_PORT:-7700}"
  if [ -n "$OPT_NODE_IP" ]; then
    NODE_IP="$OPT_NODE_IP"
  else
    local route
    route="${GHOSTLINK_TEST_ROUTE:-}"
    if [ -z "$route" ] || [ "$DRY_RUN" = 0 ]; then route="$(ip -4 route get 1.1.1.1 2>/dev/null || true)"; fi
    NODE_IP="$(printf '%s\n' "$route" | route_source_ip)"
    if [ -z "$NODE_IP" ] || is_private_ipv4 "$NODE_IP"; then
      say "This machine's address on the default route is '${NODE_IP:-unknown}', which is not a public IP."
      say "(Some providers use 1:1 NAT: the public IP is shown in their control panel.)"
      if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then die "give the public IP with --node-ip <ipv4>"; fi
      read -r -p "Public IPv4 of this server: " NODE_IP
    fi
  fi
  is_ipv4 "$NODE_IP" || die "'$NODE_IP' is not an IPv4 address"
  say "Public IP: $NODE_IP (port $PORT)"
}

write_unit() {
  local node_bin name_arg=""
  node_bin="$(command -v node 2>/dev/null || echo /usr/bin/node)"
  [ -n "$OPT_NAME" ] && name_arg=" --name \"$OPT_NAME\""
  write_file "$UNIT_FILE" 0644 <<EOF
[Unit]
Description=GhostLink server
Documentation=https://gestao-in7eligente.github.io/ghostlink/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
Environment=GHOSTLINK_DATA=$DATA_DIR
Environment=GHOSTLINK_LIVEKIT_BIN=$INSTALL_DIR/livekit/livekit-server
ExecStart=$node_bin --disable-warning=ExperimentalWarning $INSTALL_DIR/current/dist/cli.js start --data $DATA_DIR --port $PORT --node-ip $NODE_IP --public-address $NODE_IP:$PORT$name_arg
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
StateDirectory=ghostlink
StateDirectoryMode=0700
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}

open_firewall() {
  local status="${GHOSTLINK_TEST_UFW_STATUS:-}"
  if [ -z "$status" ] || [ "$DRY_RUN" = 0 ]; then
    command -v ufw >/dev/null 2>&1 || return 0
    status="$(ufw status 2>/dev/null || true)"
  fi
  if printf '%s' "$status" | grep -q '^Status: active'; then
    say "Opening the ports in ufw…"
    run ufw allow "$PORT/tcp" comment 'GhostLink'
    run ufw allow "$MEDIA_TCP_PORT/tcp" comment 'GhostLink media (ICE-TCP)'
    run ufw allow "$MEDIA_UDP_PORT/udp" comment 'GhostLink media'
  fi
}

start_service() {
  run systemctl daemon-reload
  run systemctl enable ghostlink.service
  run systemctl restart ghostlink.service
  wait_healthy
}

wait_healthy() {
  [ "$DRY_RUN" = 1 ] && return
  say "Waiting for the server…"
  for _ in $(seq 1 30); do
    if curl -fsk --max-time 2 "https://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  die "the server did not start; see: journalctl -u ghostlink -n 50"
}

# ---------- automatic update (spec "servidores acompanham o app" §4) ----------

now_epoch() {
  if [ "$DRY_RUN" = 1 ] && [ -n "${GHOSTLINK_TEST_NOW:-}" ]; then
    printf '%s\n' "$GHOSTLINK_TEST_NOW"
  else
    date +%s
  fi
}

# The update waiting for a moment without calls, from $PENDING_FILE ("VERSION=<x.y.z>" and
# "SINCE=<unix seconds>", strict key=value parsing, never sourced): sets PENDING_VERSION and
# PENDING_SINCE, both empty when there is none or the file is malformed.
read_pending() {
  local key value
  PENDING_VERSION=""
  PENDING_SINCE=""
  [ -f "$PENDING_FILE" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      VERSION) is_version "$value" && PENDING_VERSION="$value" ;;
      SINCE) [[ "$value" =~ ^[0-9]{1,12}$ ]] && PENDING_SINCE="$value" ;;
    esac
  done <"$PENDING_FILE"
  if [ -z "$PENDING_VERSION" ] || [ -z "$PENDING_SINCE" ]; then
    PENDING_VERSION=""
    PENDING_SINCE=""
  fi
}

write_pending() {
  write_file "$PENDING_FILE" 0644 <<EOF
VERSION=$1
SINCE=$2
EOF
}

clear_pending() {
  if [ "$DRY_RUN" = 1 ] || [ -e "$PENDING_FILE" ] || [ -L "$PENDING_FILE" ]; then run rm -f "$PENDING_FILE"; fi
}

# What the server's status.json says, as "<true|false> <updatedAt in unix seconds>", or
# nothing when it is missing, not a regular file or malformed. The server's user writes it:
# at most 4 KiB is read, and only these two fields come out.
read_status() {
  if [ ! -f "$STATUS_FILE" ] || [ -L "$STATUS_FILE" ]; then return 0; fi
  head -c 4096 "$STATUS_FILE" >"$WORK/status.json" 2>/dev/null || return 0
  node -e '
    try {
      const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const t = typeof s.updatedAt === "string" ? Date.parse(s.updatedAt) : NaN;
      if (typeof s.voiceActive === "boolean" && Number.isFinite(t)) process.stdout.write(String(s.voiceActive) + " " + Math.floor(t / 1000));
    } catch {}' <"$WORK/status.json" 2>/dev/null || true
}

# releases/<version> holds that version, installed by this script after its checks.
is_staged() {
  local dir
  dir="$(releases_dir)/$1"
  [ -f "$dir/dist/cli.js" ] && [ -f "$dir/package.json" ] && [ "$(package_version "$dir/package.json")" = "$1" ]
}

# The LiveKit pins of another install.sh (the one inside a checked release): LIVEKIT_VERSION
# and its SHA-256 per CPU, read with strict patterns (never sourced). Unchanged when the file
# is missing or has no valid pins.
read_livekit_pins() {
  local file="$1" version amd64 arm64
  [ -f "$file" ] || return 0
  version="$(sed -n 's/^LIVEKIT_VERSION="\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)"$/\1/p' "$file" | head -n 1)"
  amd64="$(sed -n 's/^LIVEKIT_SHA256_AMD64="\([0-9a-f]\{64\}\)"$/\1/p' "$file" | head -n 1)"
  arm64="$(sed -n 's/^LIVEKIT_SHA256_ARM64="\([0-9a-f]\{64\}\)"$/\1/p' "$file" | head -n 1)"
  if [ -z "$version" ] || [ -z "$amd64" ] || [ -z "$arm64" ]; then
    warn "$file pins no LiveKit version: keeping LiveKit $LIVEKIT_VERSION"
    return 0
  fi
  LIVEKIT_VERSION="$version"
  LIVEKIT_SHA256_AMD64="$amd64"
  LIVEKIT_SHA256_ARM64="$arm64"
}

# Copies <source> to $UPDATER (what ghostlink-update.service runs), atomically: a running
# copy keeps reading its old file.
install_updater() {
  local source="$1"
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ copy %s to %s (mode 0755)\n' "$source" "$UPDATER"
    return
  fi
  [ -f "$source" ] || die "cannot find install.sh to copy to $UPDATER"
  [ "$(readlink -f "$source")" = "$(readlink -f "$UPDATER")" ] && return 0
  install -d -m 0755 "$INSTALL_DIR"
  cp "$source" "$UPDATER.new"
  chown root:root "$UPDATER.new"
  chmod 0755 "$UPDATER.new"
  mv -f "$UPDATER.new" "$UPDATER"
}

write_update_units() {
  write_file "$UPDATE_SERVICE_FILE" 0644 <<EOF
[Unit]
Description=GhostLink automatic update
Documentation=https://gestao-in7eligente.github.io/ghostlink/hospedar-em-vps
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=/bin/bash $UPDATER --auto-update
TimeoutStartSec=30min
Nice=10
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR
ProtectHome=true
PrivateTmp=true
EOF
  write_file "$UPDATE_TIMER_FILE" 0644 <<EOF
[Unit]
Description=GhostLink automatic update, every hour

[Timer]
OnCalendar=hourly
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

# The updater copy, ghostlink-update.service and its hourly timer, enabled.
install_auto_update() {
  local self
  self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || true)"
  # Run from a pipe (bash <(curl …)): the copy inside the installed package is the same script.
  [ -f "$self" ] || self="$INSTALL_DIR/current/install.sh"
  say "Installing the automatic update (every hour, only when nobody is in a voice call)…"
  install_updater "$self"
  write_update_units
  run systemctl daemon-reload
  run systemctl enable --now ghostlink-update.timer
}

remove_auto_update() {
  if [ "$DRY_RUN" = 0 ] && [ ! -e "$UPDATE_TIMER_FILE" ] && [ ! -e "$UPDATE_SERVICE_FILE" ]; then return 0; fi
  say "Removing the automatic update…"
  run systemctl disable --now ghostlink-update.timer || true
  run rm -f "$UPDATE_TIMER_FILE" "$UPDATE_SERVICE_FILE"
  run systemctl daemon-reload
}

# --auto-update on|off: the units, and the choice in install.conf for the next runs.
set_auto_update() {
  AUTO_UPDATE="$1"
  if [ "$AUTO_UPDATE" = 1 ]; then install_auto_update; else remove_auto_update; fi
  if [ -r "$CONF_FILE" ]; then
    load_conf
    NODE_IP="$OPT_NODE_IP"
    PORT="$OPT_PORT"
    save_conf
  fi
  if [ "$AUTO_UPDATE" = 1 ]; then say "The automatic update is on."; else say "The automatic update is off."; fi
}

# Switches to the prepared $VERSION: LiveKit first when the new release pins another one
# (a failed download stops here, before anything switched), then `current` and the updater,
# then the service restarts.
apply_update() {
  local staged
  staged="$(releases_dir)/$VERSION"
  detect_arch
  read_livekit_pins "$staged/install.sh"
  install_livekit
  switch_current "$VERSION"
  if [ -f "$staged/install.sh" ]; then install_updater "$staged/install.sh"; fi
  run systemctl restart ghostlink.service
  clear_pending
  wait_healthy
  say "GhostLink $VERSION is running."
}

# --auto-update (ghostlink-update.timer, every hour).
auto_update() {
  local installed now since status active updated idle=0
  installed="$(installed_version)"
  [ -n "$installed" ] || die "GhostLink is not installed here: run install.sh first"
  load_conf
  PORT="${OPT_PORT:-7700}"
  resolve_version
  if ! version_lt "$installed" "$VERSION"; then
    say "GhostLink $installed is up to date."
    clear_pending
    return 0
  fi
  say "GhostLink $VERSION is out; this server runs $installed."
  now="$(now_epoch)"
  read_pending
  # The 24 h count from the first newer version seen: a release while one waits does not reset it.
  since="$now"
  if [ -n "$PENDING_VERSION" ] && version_lt "$installed" "$PENDING_VERSION" && [ "$PENDING_SINCE" -le "$now" ]; then
    since="$PENDING_SINCE"
  fi
  if is_staged "$VERSION"; then
    say "GhostLink $VERSION is already prepared."
  else
    fetch_server
    stage_server
    say "GhostLink $VERSION is prepared; the server still runs $installed."
  fi
  if [ "$PENDING_VERSION" != "$VERSION" ] || [ "$PENDING_SINCE" != "$since" ]; then write_pending "$VERSION" "$since"; fi

  status="$(read_status)"
  if [ -n "$status" ]; then
    active="${status%% *}"
    updated="${status##* }"
    # Fresh: written in the last 3 minutes (the server rewrites it every 60 s), and not from the future.
    if [ "$active" = false ] && [ $((now - updated)) -lt "$STATUS_MAX_AGE_S" ] && [ $((updated - now)) -lt 60 ]; then idle=1; fi
  fi
  if [ "$idle" = 1 ]; then
    say "Nobody is in a voice call: switching to GhostLink $VERSION."
  elif [ $((now - since)) -ge "$UPDATE_MAX_WAIT_S" ]; then
    say "GhostLink $VERSION has waited 24 h for a moment without calls: switching now (anyone in a call reconnects)."
  else
    say "Someone is in a voice call (or the server did not say otherwise): GhostLink $VERSION waits; the next run tries again."
    return 0
  fi
  apply_update
}

# One install.sh at a time: the timer's update and one by hand would race on `current`.
lock_install() {
  [ "$DRY_RUN" = 1 ] && return 0
  install -d -m 0755 "$INSTALL_DIR"
  exec 9>"$INSTALL_DIR/.install.lock"
  flock -n 9 && return 0
  if [ "$ACTION" = auto-update ]; then
    say "Another install.sh is running; the next run tries again."
    exit 0
  fi
  die "another install.sh is running (the automatic update?); try again in a few minutes"
}

# Test hooks (GHOSTLINK_TEST_*), honoured only with --dry-run.
apply_test_hooks() {
  [ "$DRY_RUN" = 1 ] || return 0
  if [ -n "${GHOSTLINK_TEST_CONF:-}" ]; then CONF_FILE="$GHOSTLINK_TEST_CONF"; fi
  if [ -n "${GHOSTLINK_TEST_STATUS:-}" ]; then STATUS_FILE="$GHOSTLINK_TEST_STATUS"; fi
  if [ -n "${GHOSTLINK_TEST_PENDING:-}" ]; then PENDING_FILE="$GHOSTLINK_TEST_PENDING"; fi
}

cli() {
  run runuser -u "$SERVICE_USER" -- "$(command -v node 2>/dev/null || echo /usr/bin/node)" --disable-warning=ExperimentalWarning "$INSTALL_DIR/current/dist/cli.js" "$@" --data "$DATA_DIR"
}

print_summary() {
  say ""
  say "GhostLink is running: https://$NODE_IP:$PORT"
  say "Open these ports in your provider's firewall too: TCP $PORT, TCP $MEDIA_TCP_PORT, UDP $MEDIA_UDP_PORT."
  say ""
  cli status
  say ""
  cli setup-code
  say "Use this setup code once, from the app, to become the owner."
  say ""
  cli invite
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --node-ip) OPT_NODE_IP="${2:-}"; shift 2 || die "--node-ip needs a value" ;;
      --port) OPT_PORT="${2:-}"; shift 2 || die "--port needs a value" ;;
      --name) OPT_NAME="${2:-}"; shift 2 || die "--name needs a value" ;;
      --version) OPT_VERSION="${2:-}"; shift 2 || die "--version needs a value" ;;
      --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
      --no-auto-update) AUTO_UPDATE=0; shift ;;
      --auto-update)
        case "${2:-}" in
          off) ACTION=auto-update-off; shift 2 ;;
          on) ACTION=auto-update-on; shift 2 ;;
          *) ACTION=auto-update; shift ;;
        esac
        ;;
      --yes | -y) ASSUME_YES=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option '$1'" ;;
    esac
  done
  [ -z "$OPT_NODE_IP" ] || is_ipv4 "$OPT_NODE_IP" || die "--node-ip must be an IPv4 address"
  [ -z "$OPT_PORT" ] || is_port "$OPT_PORT" || die "--port must be between 1 and 65535"
  [ -z "$OPT_NAME" ] || is_name "$OPT_NAME" || die "--name may use letters, digits, spaces and . _ - (at most 64)"
  [ -z "$OPT_VERSION" ] || is_version "$OPT_VERSION" || die "--version must look like 1.2.3"
  local install_options="${OPT_NODE_IP}${OPT_PORT}${OPT_NAME}${OPT_VERSION}${AUTO_UPDATE}"
  [ "$ALLOW_DOWNGRADE" = 0 ] || install_options+="--allow-downgrade"
  if [ "$ACTION" != install ] && [ -n "$install_options" ]; then
    die "--auto-update takes no other option but --dry-run and --yes"
  fi
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  if [ "$DRY_RUN" = 0 ]; then
    [ "$(id -u)" = 0 ] || die "run as root (sudo bash install.sh)"
  else
    say "Dry run: nothing will be changed."
  fi
  apply_test_hooks
  lock_install

  case "$ACTION" in
    auto-update)
      auto_update
      return
      ;;
    auto-update-off)
      set_auto_update 0
      return
      ;;
    auto-update-on)
      [ -n "$(installed_version)" ] || die "GhostLink is not installed here: run install.sh first"
      set_auto_update 1
      return
      ;;
  esac

  check_os
  detect_arch
  load_conf
  AUTO_UPDATE="${AUTO_UPDATE:-1}"
  resolve_node_ip
  install_packages
  install_node
  create_user
  resolve_version
  check_downgrade
  install_livekit
  install_server
  # Installed by hand: an update the timer prepared is no longer pending.
  clear_pending
  save_conf
  write_unit
  open_firewall
  start_service
  if [ "$AUTO_UPDATE" = 1 ]; then install_auto_update; else remove_auto_update; fi
  print_summary
}

# Sourcing the file (tests) only defines the functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
