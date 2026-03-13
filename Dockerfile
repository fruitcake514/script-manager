# ---- Stage 1: Build React Frontend (Vite) ----
FROM node:18-alpine AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json ./
RUN npm install --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Runtime ----
FROM python:3.12-alpine

RUN apk add --no-cache \
    gcc \
    musl-dev \
    python3-dev \
    libffi-dev \
    bash \
    git \
    shadow

# Create a non-privileged user for scripts
RUN useradd -u 1000 -m runner

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

COPY manager.py .
COPY --from=frontend-build /app/frontend/build /app/frontend/build

# Ensure script and data directories exist and are owned by runner
RUN mkdir -p /scripts /data && chown -R runner:runner /scripts /data /app

EXPOSE 8080

# Run the manager as root so it can drop privileges for scripts
CMD ["python", "manager.py"]
