#!/bin/sh
# Debian-based runtime (useradd/groupadd, NOT Alpine adduser syntax).
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

case "$PUID" in ''|*[!0-9]*) PUID=1000 ;; esac
case "$PGID" in ''|*[!0-9]*) PGID=1000 ;; esac

echo "[entrypoint] Setting up with PUID=$PUID, PGID=$PGID"

if [ -z "${API_TOKEN:-}" ] || [ "$API_TOKEN" = "change-me-to-a-long-random-token" ]; then
  echo "[entrypoint] WARNING: API_TOKEN is not set — the API is unauthenticated. Set API_TOKEN in compose."
fi

# Recreate runner with correct IDs (idempotent)
userdel runner 2>/dev/null || true
groupdel runner 2>/dev/null || true
groupadd -g "$PGID" runner
useradd -m -u "$PUID" -g runner -s /bin/sh runner

mkdir -p /scripts /data /data/containers/run /data/containers/graph
# /scripts is the apps' world (runner-owned). /data is manager-only:
# schedules, meta, running state must NOT be readable by apps (runner).
chown runner:runner /scripts
chmod 755 /scripts
chown root:root /data
chmod 700 /data

# Subordinate IDs so inner containers can use user namespaces later.
grep -q "^runner:" /etc/subuid 2>/dev/null || echo "runner:100000:65536" >> /etc/subuid
grep -q "^runner:" /etc/subgid 2>/dev/null || echo "runner:100000:65536" >> /etc/subgid

echo "[entrypoint] EXEC_BACKEND=${EXEC_BACKEND:-subprocess}"
if [ "${EXEC_BACKEND:-subprocess}" != "subprocess" ]; then
  if ! command -v podman >/dev/null 2>&1 || ! podman info >/dev/null 2>&1; then
    echo "[entrypoint] WARNING: EXEC_BACKEND=$EXEC_BACKEND but podman is not functional."
    echo "[entrypoint] WARNING: inner containers need 'security_opt: [seccomp:unconfined]' on THIS container."
    echo "[entrypoint] WARNING: services will fall back to subprocess if podman stays unavailable."
  else
    echo "[entrypoint] Podman OK — pre-pulling service base image in background..."
    (podman pull "${PODMAN_BASE_IMAGE:-docker.io/library/python:3.12-slim}" >/dev/null 2>&1 || true) &
  fi
fi

id runner
echo "[entrypoint] Setup complete. Starting manager..."
exec "$@"
