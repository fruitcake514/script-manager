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
    shadow \
    tzdata

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

COPY manager.py .
COPY --from=frontend-build /app/frontend/build /app/frontend/build

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]

# Run the manager as root so it can drop privileges for scripts
CMD ["python", "manager.py"]
