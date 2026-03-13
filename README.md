# Script Manager

A self-hosted Docker application for managing, running, and monitoring Python scripts through a web UI. Scripts are automatically isolated from each other and from your host system.

---

## Features

- **Web UI** — start, stop, restart, and delete scripts from the browser
- **Live log viewer** — color-coded log output streamed in real time
- **File editor** — syntax-highlighted in-browser editor with line numbers (Python, JSON, YAML, shell, env)
- **File manager** — browse, upload, create, and edit any file in a script's folder including subdirectories
- **Script creator** — create new scripts with a `main.py` and `requirements.txt` directly from the UI
- **Auto-restart** — crashed scripts automatically restart with a 2-second delay
- **Auto-start** — all scripts in `/scripts` start automatically when the container starts
- **Auto-join** — scripts are auto-discovered; drop a folder into `/scripts` and it appears in the UI
- **Port display** — if a script opens a port in the allowed range (10000–10010), it shows next to the script name
- **Health checks** — scripts can write a `health.json` file to report their own health status
- **Process isolation** — each script is sandboxed at both the OS and container level (see below)

---

## Quick Start

### 1. Create the directory structure on your NAS

```
/mnt/pool1/appdata/script-manager/
├── scripts/        ← your scripts live here
└── data/           ← persistent data (created automatically)
```

### 2. Create `docker-compose.yml`

```yaml
services:
  script-manager:
    build:
      context: https://github.com/fruitcake514/script-manager.git
    container_name: script-manager
    environment:
      - PUID=568
      - PGID=568
    ports:
      - "9090:8080"
      - "10000:10000"
      - "10001:10001"
      - "10002:10002"
      - "10003:10003"
      - "10004:10004"
      - "10005:10005"
      - "10006:10006"
      - "10007:10007"
      - "10008:10008"
      - "10009:10009"
      - "10010:10010"
    volumes:
      - /mnt/pool1/appdata/script-manager/scripts:/scripts
      - /mnt/pool1/appdata/script-manager/data:/app/data
    restart: unless-stopped
```

Adjust `PUID`/`PGID` to match your user. Adjust the host path `/mnt/pool1/appdata/script-manager` to wherever you want to store data.

### 3. Deploy

Build and start via your container manager UI, or:

```bash
docker compose up -d --build
```

### 4. Access the UI

```
http://your-nas-ip:9090
```

---

## Adding Scripts

Each script lives in its own subdirectory under `/scripts`. The only requirement is a `.py` file inside the directory. A `requirements.txt` is optional but recommended.

### Option A — Create from the UI

Click **+ New Script** in the web UI. Enter a name, write your `main.py` and `requirements.txt` inline, and click **Create & Save**. The script folder is created automatically and the script appears in the list immediately.

### Option B — Drop a folder in manually

```
/scripts/
└── my_script/
    ├── main.py           ← required (any .py file works)
    ├── requirements.txt  ← optional
    └── config.yaml       ← any other files you want
```

The script manager will auto-detect it within 3 seconds and show it in the UI.

### Script requirements

Scripts must be self-contained. The manager:

1. Creates a Python virtual environment inside the script's folder (`venv/`)
2. Installs `requirements.txt` into that venv
3. Runs the first `.py` file found in the directory

If a script needs to serve on a port, use a port in the range **10000–10010**. The UI will detect it and display the port next to the script name.

---

## Script Ports

Only ports 10000–10010 are exposed from the container. Scripts using ports outside this range will run but won't be reachable from outside the container.

Example — to serve a Flask app on port 10000:

```python
app.run(host="0.0.0.0", port=10000)
```

---

## Health Checks

Scripts can report their own health by writing a `health.json` file to their own directory:

```python
import json, pathlib

pathlib.Path("/scripts/my_script/health.json").write_text(
    json.dumps({"healthy": True, "status": "running", "jobs_queued": 5})
)
```

The manager's `/api/scripts/<name>/health` endpoint will return this data.

---

## Log Color Coding

The log viewer color-codes output automatically:

| Color | Meaning |
|-------|---------|
| 🔵 Blue | Manager messages (start, stop, restart events) |
| 🟢 Green | INFO, starting, ready, success, done |
| 🟡 Yellow | WARNING |
| 🟣 Purple | DEBUG |
| 🔴 Red | ERROR, Exception, Traceback |
| ❗ Bright red | CRITICAL, FATAL |

---

## File Editor

Click **▼** to expand a script card, then go to the **Files** tab. Click **Edit** next to any text file to open the editor.

- **Syntax highlighting** for Python, JSON, YAML, shell scripts, and env files
- **Line numbers**
- **Tab** inserts 4 spaces
- **Ctrl+S** saves

Binary files (images, compiled files, etc.) are listed but not editable.

---

## Isolation — How Scripts Are Sandboxed

Scripts are isolated at two levels: the **container level** and the **process level**.

### Level 1 — Docker container isolation (from your host)

The entire script manager runs inside a Docker container. This means:

- **No host filesystem access** — scripts can only read/write within `/scripts` and `/data` inside the container. They cannot touch anything on your NAS outside of what you explicitly mount.
- **No host network namespace** — scripts run in Docker's bridged network. They cannot directly access your host's internal interfaces or other containers unless you expose specific ports.
- **Only ports 10000–10010 are exposed** — any port a script tries to open outside this range is unreachable from outside the container.
- **No privileged access** — the container does not run with `--privileged`. Scripts cannot load kernel modules, modify host networking, or access raw devices.
- **Restart policy** — if a script crashes the whole container (which is nearly impossible given the process-level isolation), Docker will restart it automatically.

### Level 2 — Process-level isolation (scripts from each other)

Each script is launched as a subprocess with the following restrictions applied via Linux `setrlimit` and process group APIs before the script starts executing:

#### New session and process group
```python
os.setsid()   # new session — detaches from the manager's controlling terminal
os.setpgrp()  # new process group — signals sent to one script don't reach others
```
This means a `SIGKILL` or `SIGTERM` sent to one script cannot propagate to other scripts or to the manager itself.

#### Memory limit — `RLIMIT_AS` / `RLIMIT_DATA`
Each script is limited to **256MB of addressable memory** (configurable via `SCRIPT_MAX_RAM_MB` in `manager.py`). If a script tries to allocate beyond this, it receives an `MemoryError` rather than being able to consume all available container RAM and starve other scripts.

#### CPU time limit — `RLIMIT_CPU`
Each script is limited to **3600 CPU seconds** (1 hour of compute time). A runaway loop or stuck computation will be killed by the kernel with `SIGXCPU` after this limit, preventing one script from monopolizing the CPU indefinitely.

#### File descriptor limit — `RLIMIT_NOFILE`
Each script is limited to **256 open file descriptors**. This prevents a poorly written script from exhausting the system's file descriptor table and causing other scripts or the manager itself to fail to open files or network connections.

#### Core dumps disabled — `RLIMIT_CORE`
Core dumps are disabled. A crashing script cannot write a core dump (which could contain sensitive data from memory) to the filesystem.

#### Path traversal protection
All file API endpoints (`/api/scripts/<n>/files/...`) validate that the resolved path stays within the script's own directory using `os.path.realpath`. A request for `../../other_script/secrets.txt` is rejected with a 400 error before any filesystem access occurs.

#### Full process tree cleanup on stop
When a script is stopped (via UI or restart), the manager kills not just the main Python process but all child processes it spawned using `psutil.Process.children(recursive=True)`. This ensures ports are released immediately and no orphan processes linger.

### What isolation does NOT cover

Scripts share the same container network namespace — they can reach each other on `localhost` if they know each other's ports. If you need complete network isolation between scripts, you would need to run each script in its own container instead.

Scripts share the same container filesystem namespace — they can read each other's files in `/scripts` if they hardcode paths. The path traversal protection only applies to the manager's file API, not to what Python code can do directly.

---

## API Reference

All endpoints are served by the manager on port 8080 (mapped to 9090 on the host by default).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/scripts` | List all scripts with status and ports |
| POST | `/api/scripts` | Create a new script |
| POST | `/api/scripts/<n>/start` | Start a script |
| POST | `/api/scripts/<n>/stop` | Stop a script |
| POST | `/api/scripts/<n>/restart` | Restart a script |
| GET | `/api/scripts/<n>/health` | Get health status |
| GET | `/api/scripts/<n>/logs` | Get log buffer (last 500 lines) |
| DELETE | `/api/scripts/<n>/logs` | Clear log buffer |
| GET | `/api/scripts/<n>/files` | List files (recursive) |
| GET | `/api/scripts/<n>/files/<path>` | Read a file |
| PUT | `/api/scripts/<n>/files/<path>` | Write a file |
| POST | `/api/scripts/<n>/upload` | Upload a file |
| DELETE | `/api/scripts/<n>` | Stop and delete a script |

---

## Architecture

```
Container (Docker)
│
├── manager.py  (Flask, port 8080)
│   ├── Serves the React frontend (built by Vite at image build time)
│   ├── Provides the REST API
│   └── Spawns/monitors script subprocesses
│
├── /app/frontend/build/   (static React app)
│
└── /scripts/  (mounted volume)
    ├── script_a/
    │   ├── main.py
    │   ├── requirements.txt
    │   └── venv/            (created automatically)
    └── script_b/
        ├── main.py
        └── venv/
```

**Frontend:** React 18 + Vite, served as static files by Flask. No separate frontend server.

**Backend:** Flask 3, psutil for process inspection, flask-cors for development.

**Build:** Multi-stage Dockerfile — Node 18 Alpine builds the React bundle, Python 3.12 Alpine is the runtime. Final image is ~130–160MB.

---

## Configuration

Edit these constants at the top of `manager.py` to tune behaviour:

| Constant | Default | Description |
|----------|---------|-------------|
| `SCRIPTS_DIR` | `/scripts` | Where script folders are mounted |
| `ALLOWED_PORTS` | 10000–10010 | Ports tracked for display in the UI |
| `LOG_MAX_LINES` | 500 | Rolling log buffer size per script |
| `SCRIPT_MAX_RAM_MB` | 256 | Memory limit per script process |
| `SCRIPT_MAX_CPU_SEC` | 3600 | CPU time limit per script (seconds) |
| `SCRIPT_MAX_FILES` | 256 | Max open file descriptors per script |

---

## Troubleshooting

**Container builds but nothing is served at the port**
Check `docker logs script-manager`. The startup log prints the static folder path and whether `index.html` exists. If the path is wrong, the Vite build output didn't copy correctly.

**Script shows as stopped immediately after starting**
The script likely has a missing dependency or a syntax error. Open the Logs tab to see the traceback. The manager will retry automatically — check attempt 1's output.

**Port is in use error on container start**
Another service on your NAS is using the mapped port. Change the left-hand port number in `docker-compose.yml` (e.g. `"9091:8080"`) and redeploy.

**Script keeps restarting**
Expected behaviour for scripts that exit non-zero. The manager restarts them after 2 seconds. If a script is meant to run once and exit cleanly, it should `sys.exit(0)` — exit code 0 stops the restart loop.

**`ModuleNotFoundError` on first run**
The venv is created and packages installed each time the container starts a script. If pip can't reach PyPI, add a bootstrap installer at the top of your script:

```python
import sys, subprocess
subprocess.check_call([sys.executable, "-m", "pip", "install", "your-package", "--quiet"])
```
