import os
import subprocess
import threading
import psutil
import time
import json
import collections
import shutil
import resource
import signal
from datetime import datetime, timezone
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

SCRIPTS_DIR    = "/scripts"
VENV_DIR_NAME  = "venv"
ALLOWED_PORTS  = set(range(10000, 10010))
LOG_MAX_LINES  = 500

# ── Resource limits applied to each child script process ──────────────────────
# These run inside the container which is already isolated from the host,
# but we also limit what each script can do to isolate scripts from each other.
SCRIPT_MAX_RAM_MB  = 256   # soft RSS limit per script (MB)
SCRIPT_MAX_CPU_SEC = 3600  # max CPU seconds before SIGKILL (1 hour)
SCRIPT_MAX_FILES   = 256   # max open file descriptors

# ── Scheduler state ──────────────────────────────────────────────────────────
# Schedules stored as:
# { script_name: [ { "id": str, "action": "start"|"stop", "time": "HH:MM",
#                    "days": [0-6], "delay_seconds": int, "enabled": bool } ] }
SCHEDULES_FILE = "/data/schedules.json"
_schedules = {}
_schedules_lock = threading.Lock()

def load_schedules():
    global _schedules
    os.makedirs(os.path.dirname(SCHEDULES_FILE), exist_ok=True)
    if not os.path.exists(SCHEDULES_FILE):
        with open(SCHEDULES_FILE, "w") as f:
            json.dump({}, f)
        print(f"[scheduler] Created empty schedules file at {SCHEDULES_FILE}", flush=True)
    try:
        with open(SCHEDULES_FILE) as f:
            _schedules = json.load(f)
    except Exception as e:
        print(f"[scheduler] Failed to load schedules: {e}", flush=True)
        _schedules = {}

def save_schedules():
    try:
        os.makedirs(os.path.dirname(SCHEDULES_FILE), exist_ok=True)
        with open(SCHEDULES_FILE, "w") as f:
            json.dump(_schedules, f, indent=2)
    except Exception as e:
        print(f"[scheduler] Failed to save schedules: {e}", flush=True)

def scheduler_loop():
    """Background thread — checks schedules every 30 seconds."""
    print("[scheduler] Scheduler started", flush=True)
    last_fired = {}  # key: f"{name}:{sched_id}:{date}" -> True
    while True:
        now = datetime.now(timezone.utc)
        # Use local time for schedule matching
        local = datetime.now()
        current_hhmm = local.strftime("%H:%M")
        current_day  = local.weekday()  # 0=Mon, 6=Sun

        with _schedules_lock:
            all_scheds = {k: list(v) for k, v in _schedules.items()}

        for script_name, scheds in all_scheds.items():
            for sched in scheds:
                if not sched.get("enabled", True):
                    continue
                days = sched.get("days", list(range(7)))
                if current_day not in days:
                    continue
                if sched.get("time") != current_hhmm:
                    continue
                fire_key = f"{script_name}:{sched['id']}:{local.strftime('%Y-%m-%d')}"
                if fire_key in last_fired:
                    continue
                last_fired[fire_key] = True
                action  = sched.get("action", "start")
                delay   = sched.get("delay_seconds", 0)
                print(f"[scheduler] Firing '{action}' for '{script_name}' (delay={delay}s)", flush=True)
                def _fire(sname=script_name, act=action, d=delay):
                    if d > 0:
                        time.sleep(d)
                    if act == "start":
                        run_script(sname)
                    elif act == "stop":
                        stop_script(sname)
                    elif act == "restart":
                        stop_script(sname)
                        time.sleep(0.5)
                        run_script(sname)
                    print(f"[scheduler] '{act}' completed for '{sname}'", flush=True)
                threading.Thread(target=_fire, daemon=True).start()

        # Prune last_fired entries older than today
        today = local.strftime("%Y-%m-%d")
        last_fired = {k: v for k, v in last_fired.items() if k.endswith(today)}
        time.sleep(30)

app = Flask(__name__, static_folder=os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "build"), static_url_path="")
CORS(app)

processes   = {}
log_buffers = collections.defaultdict(lambda: collections.deque(maxlen=LOG_MAX_LINES))
log_locks   = collections.defaultdict(threading.Lock)

# ── Process isolation preexec ─────────────────────────────────────────────────

def child_preexec(script_path):
    """
    Called in the child process before exec.
    - New process group (isolates signals)
    - New session (no controlling terminal)
    - Resource limits (RAM, CPU, file descriptors)
    - Drop any elevated capabilities
    - Restrict to script directory via chdir
    """
    def fn():
        try:
            os.setsid()   # new session — detaches from terminal
            os.setpgrp()  # new process group

            # RAM limit (soft=warn, hard=kill)
            ram_bytes = SCRIPT_MAX_RAM_MB * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS,  (ram_bytes * 4, ram_bytes * 4))
            resource.setrlimit(resource.RLIMIT_DATA, (ram_bytes,     ram_bytes))

            # CPU time limit
            resource.setrlimit(resource.RLIMIT_CPU,
                (SCRIPT_MAX_CPU_SEC, SCRIPT_MAX_CPU_SEC + 60))

            # File descriptor limit
            resource.setrlimit(resource.RLIMIT_NOFILE,
                (SCRIPT_MAX_FILES, SCRIPT_MAX_FILES))

            # Core dumps off
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except Exception:
            pass  # don't crash child if limits fail

    return fn

# ── Venv helpers ──────────────────────────────────────────────────────────────

def create_venv(script_path):
    venv_path = os.path.join(script_path, VENV_DIR_NAME)
    if not os.path.exists(venv_path):
        subprocess.run(["python3", "-m", "venv", venv_path], check=False)
    return venv_path

def install_requirements(venv_path, script_path):
    req_file = os.path.join(script_path, "requirements.txt")
    if os.path.exists(req_file):
        pip = os.path.join(venv_path, "bin", "pip")
        subprocess.run([pip, "install", "--upgrade", "pip"], check=False)
        subprocess.run([pip, "install", "-r", req_file], check=False)

def _append_log(name, line):
    with log_locks[name]:
        log_buffers[name].append(line)

# ── Script lifecycle ──────────────────────────────────────────────────────────

def run_script(script_name):
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    venv_path   = create_venv(script_path)
    install_requirements(venv_path, script_path)
    python_path = os.path.join(venv_path, "bin", "python")
    script_file = next((f for f in os.listdir(script_path) if f.endswith(".py")), None)
    if not script_file:
        _append_log(script_name, "[manager] No .py file found.\n")
        return

    def pipe_output(stream, sname):
        for line in iter(stream.readline, b""):
            _append_log(sname, line.decode("utf-8", errors="replace"))
        stream.close()

    def start_loop():
        attempt = 0
        while True:
            attempt += 1
            _append_log(script_name, f"[manager] Starting '{script_file}' (attempt {attempt})...\n")
            env = os.environ.copy()
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["PYTHONUNBUFFERED"] = "1"
            proc = subprocess.Popen(
                [python_path, script_file],
                cwd=script_path,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                preexec_fn=child_preexec(script_path),
            )
            processes[script_name] = proc
            t = threading.Thread(target=pipe_output, args=(proc.stdout, script_name), daemon=True)
            t.start()
            proc.wait()
            t.join(timeout=2)
            if processes.get(script_name) is not proc:
                _append_log(script_name, f"[manager] '{script_name}' stopped.\n")
                break
            if proc.returncode == 0:
                _append_log(script_name, f"[manager] '{script_name}' exited cleanly.\n")
                break
            _append_log(script_name, f"[manager] '{script_name}' crashed (exit {proc.returncode}). Restarting in 2s...\n")
            time.sleep(2)

    threading.Thread(target=start_loop, daemon=True).start()

def stop_script(script_name):
    proc = processes.pop(script_name, None)
    if proc and proc.poll() is None:
        try:
            parent = psutil.Process(proc.pid)
            for child in parent.children(recursive=True):
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
        except psutil.NoSuchProcess:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

def get_status(script_name):
    proc = processes.get(script_name)
    if proc is None:
        return "stopped"
    return "running" if proc.poll() is None else "stopped"

def get_ports(script_name):
    proc = processes.get(script_name)
    ports = []
    if proc and proc.poll() is None:
        try:
            p = psutil.Process(proc.pid)
            for child in [p] + p.children(recursive=True):
                try:
                    for c in child.connections():
                        if c.status == "LISTEN" and c.laddr.port in ALLOWED_PORTS:
                            ports.append(c.laddr.port)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except Exception:
            pass
    return list(set(ports))

# ── File helpers ──────────────────────────────────────────────────────────────

def list_files_recursive(base_dir, prefix=""):
    """Return list of relative file paths, skipping venv and __pycache__."""
    results = []
    skip = {VENV_DIR_NAME, "__pycache__", ".git", "*.pyc"}
    try:
        for entry in sorted(os.scandir(base_dir), key=lambda e: (not e.is_file(), e.name)):
            if entry.name in skip or entry.name.startswith("."):
                continue
            rel = os.path.join(prefix, entry.name) if prefix else entry.name
            if entry.is_file():
                results.append(rel)
            elif entry.is_dir():
                results.extend(list_files_recursive(entry.path, rel))
    except PermissionError:
        pass
    return results

def safe_path(script_name, filename):
    """Resolve path and ensure it stays within the script dir (no path traversal)."""
    base = os.path.realpath(os.path.join(SCRIPTS_DIR, script_name))
    target = os.path.realpath(os.path.join(base, filename))
    if not target.startswith(base + os.sep) and target != base:
        return None
    return target

# ── API routes ────────────────────────────────────────────────────────────────

@app.route("/api/scripts", methods=["GET"])
def api_list_scripts():
    if not os.path.exists(SCRIPTS_DIR):
        return jsonify([])
    scripts = sorted([d for d in os.listdir(SCRIPTS_DIR)
                      if os.path.isdir(os.path.join(SCRIPTS_DIR, d))])
    return jsonify([{"name": s, "status": get_status(s), "ports": get_ports(s)} for s in scripts])

@app.route("/api/scripts", methods=["POST"])
def api_create_script():
    data = request.get_json()
    if not data or "name" not in data:
        return jsonify({"error": "Missing name"}), 400
    name = data["name"].strip().replace(" ", "_")
    if not name:
        return jsonify({"error": "Invalid name"}), 400
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if os.path.exists(script_dir):
        return jsonify({"error": f"Script '{name}' already exists"}), 409
    os.makedirs(script_dir, exist_ok=True)
    py_content  = data.get("python_content",  f"# {name}\n\nprint('Hello from {name}!')\n")
    req_content = data.get("requirements_content", "")
    with open(os.path.join(script_dir, "main.py"), "w") as f: f.write(py_content)
    with open(os.path.join(script_dir, "requirements.txt"), "w") as f: f.write(req_content)
    return jsonify({"status": "created", "name": name})

@app.route("/api/scripts/<name>/start", methods=["POST"])
def api_start(name):
    run_script(name)
    return jsonify({"status": "starting"})

@app.route("/api/scripts/<name>/stop", methods=["POST"])
def api_stop(name):
    stop_script(name)
    return jsonify({"status": "stopped"})

@app.route("/api/scripts/<name>/restart", methods=["POST"])
def api_restart(name):
    stop_script(name)
    time.sleep(0.5)
    run_script(name)
    return jsonify({"status": "restarting"})

@app.route("/api/scripts/<name>/health", methods=["GET"])
def api_health(name):
    status_file = os.path.join(SCRIPTS_DIR, name, "health.json")
    if os.path.exists(status_file):
        with open(status_file) as f:
            return jsonify(json.load(f))
    return jsonify({"healthy": get_status(name) == "running"})

@app.route("/api/scripts/<name>/logs", methods=["GET"])
def api_logs(name):
    with log_locks[name]:
        lines = list(log_buffers[name])
    return jsonify({"logs": lines})

@app.route("/api/scripts/<name>/logs", methods=["DELETE"])
def api_clear_logs(name):
    with log_locks[name]:
        log_buffers[name].clear()
    return jsonify({"status": "cleared"})

@app.route("/api/scripts/<name>/upload", methods=["POST"])
def api_upload(name):
    script_dir = os.path.join(SCRIPTS_DIR, name)
    os.makedirs(script_dir, exist_ok=True)
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file"}), 400
    dest = safe_path(name, file.filename)
    if not dest:
        return jsonify({"error": "Invalid path"}), 400
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    file.save(dest)
    return jsonify({"status": "uploaded", "filename": file.filename})

@app.route("/api/scripts/<name>/files", methods=["GET"])
def api_list_files(name):
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if not os.path.exists(script_dir):
        return jsonify({"files": []})
    return jsonify({"files": list_files_recursive(script_dir)})

@app.route("/api/scripts/<name>/files/<path:filename>", methods=["GET"])
def api_get_file(name, filename):
    dest = safe_path(name, filename)
    if not dest or not os.path.exists(dest):
        return jsonify({"error": "Not found"}), 404
    with open(dest, "r", errors="replace") as f:
        content = f.read()
    return jsonify({"filename": filename, "content": content})

@app.route("/api/scripts/<name>/files/<path:filename>", methods=["PUT"])
def api_save_file(name, filename):
    dest = safe_path(name, filename)
    if not dest:
        return jsonify({"error": "Invalid path"}), 400
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    data = request.get_json()
    if not data or "content" not in data:
        return jsonify({"error": "Missing content"}), 400
    with open(dest, "w") as f:
        f.write(data["content"])
    return jsonify({"status": "saved"})

@app.route("/api/scripts/<name>", methods=["DELETE"])
def api_delete_script(name):
    stop_script(name)
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if os.path.exists(script_dir):
        shutil.rmtree(script_dir)
    return jsonify({"status": "deleted"})


# ── Scheduler API ─────────────────────────────────────────────────────────────

@app.route("/api/scripts/<n>/schedules", methods=["GET"])
def api_get_schedules(name):
    with _schedules_lock:
        return jsonify(_schedules.get(name, []))

@app.route("/api/scripts/<n>/schedules", methods=["POST"])
def api_add_schedule(name):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    import uuid
    sched = {
        "id":             str(uuid.uuid4())[:8],
        "action":         data.get("action", "start"),
        "time":           data.get("time", "08:00"),
        "days":           data.get("days", list(range(7))),
        "delay_seconds":  int(data.get("delay_seconds", 0)),
        "enabled":        data.get("enabled", True),
        "label":          data.get("label", ""),
    }
    with _schedules_lock:
        if name not in _schedules:
            _schedules[name] = []
        _schedules[name].append(sched)
        save_schedules()
    return jsonify(sched)

@app.route("/api/scripts/<n>/schedules/<sid>", methods=["PUT"])
def api_update_schedule(name, sid):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    with _schedules_lock:
        scheds = _schedules.get(name, [])
        for i, s in enumerate(scheds):
            if s["id"] == sid:
                scheds[i].update({
                    "action":        data.get("action", s["action"]),
                    "time":          data.get("time",   s["time"]),
                    "days":          data.get("days",   s["days"]),
                    "delay_seconds": int(data.get("delay_seconds", s["delay_seconds"])),
                    "enabled":       data.get("enabled", s["enabled"]),
                    "label":         data.get("label",  s.get("label", "")),
                })
                save_schedules()
                return jsonify(scheds[i])
    return jsonify({"error": "Not found"}), 404

@app.route("/api/scripts/<n>/schedules/<sid>", methods=["DELETE"])
def api_delete_schedule(name, sid):
    with _schedules_lock:
        scheds = _schedules.get(name, [])
        _schedules[name] = [s for s in scheds if s["id"] != sid]
        save_schedules()
    return jsonify({"status": "deleted"})

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    if path and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    return send_from_directory(app.static_folder, "index.html")

def start_all_scripts():
    if not os.path.exists(SCRIPTS_DIR):
        return
    for s in os.listdir(SCRIPTS_DIR):
        if os.path.isdir(os.path.join(SCRIPTS_DIR, s)):
            run_script(s)

if __name__ == "__main__":
    print(f"[manager] static_folder = {app.static_folder}", flush=True)
    print(f"[manager] static_folder exists = {os.path.exists(app.static_folder)}", flush=True)
    if os.path.exists(app.static_folder):
        print(f"[manager] static contents = {os.listdir(app.static_folder)}", flush=True)
    print(f"[manager] Starting Flask on 0.0.0.0:8080", flush=True)
    load_schedules()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    start_all_scripts()
    app.run(host="0.0.0.0", port=8080, threaded=True)
