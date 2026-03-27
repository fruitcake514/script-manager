#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Validate that PUID/PGID are numeric
case "$PUID" in ''|*[!0-9]*) PUID=1000 ;; esac
case "$PGID" in ''|*[!0-9]*) PGID=1000 ;; esac

echo "[entrypoint] Setting up with PUID=$PUID, PGID=$PGID"

# Clean up any existing 'runner' user/group
deluser runner 2>/dev/null || true
delgroup runner 2>/dev/null || true

# Create the group with the requested GID
addgroup -g "$PGID" runner 2>/dev/null || addgroup runner 2>/dev/null || true

# Create the user with the requested UID, primary group 'runner'
adduser -D -u "$PUID" -G runner runner 2>/dev/null || adduser -D runner 2>/dev/null || true

# Ensure directories exist with correct ownership
mkdir -p /scripts /data
chown runner:runner /scripts /data 2>/dev/null || true

echo "[entrypoint] Directories configured. PUID=$PUID, PGID=$PGID"
exec "$@"
