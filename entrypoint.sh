#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Validate that PUID/PGID are numeric
case "$PUID" in ''|*[!0-9]*) PUID=1000 ;; esac
case "$PGID" in ''|*[!0-9]*) PGID=1000 ;; esac

echo "[entrypoint] Setting up with PUID=$PUID, PGID=$PGID"

# Remove existing runner so we can recreate with correct IDs
userdel runner 2>/dev/null || true
groupdel runner 2>/dev/null || true

# Create group and user with requested IDs
addgroup -g "$PGID" runner
adduser -D -u "$PUID" -G runner runner

# Ensure directories exist with correct ownership
mkdir -p /scripts /data
chown runner:runner /scripts /data

id runner
echo "[entrypoint] Setup complete. Starting manager..."
exec "$@"
