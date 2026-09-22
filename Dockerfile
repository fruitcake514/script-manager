# ---- Stage 1: Build React Frontend (Vite) ----
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Runtime (Debian — required for the Podman stack) ----
FROM python:3.12-slim
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Podman + OCI runtime + userns helpers for containers-inside-container.
# No docker.sock mount and no host mounts: everything lives under /data.
RUN apt-get update && apt-get install -y --no-install-recommends \
    podman crun passt slirp4netns uidmap fuse-overlayfs ca-certificates wget \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/containers \
 && printf '[storage]\ndriver = "overlay"\nrunroot = "/data/containers/run"\ngraphroot = "/data/containers/graph"\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n' \
    > /etc/containers/storage.conf

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt \
 && rm -rf /root/.cache

COPY manager.py .
COPY --from=frontend-build /app/frontend/build /app/frontend/build
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/healthz | grep -q '"ok":true' || exit 1

ENTRYPOINT ["/entrypoint.sh"]
# NOTE: exactly 1 worker — app state (processes, logs, caches) is in-memory.
CMD ["uvicorn", "manager:app", "--host", "0.0.0.0", "--port", "8080"]
