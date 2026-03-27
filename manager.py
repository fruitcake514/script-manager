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
import pwd
import uuid
from datetime import datetime, timezone
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

SCRIPTS_DIR    = "/scripts"
DATA_DIR       = "/data"
VENV_DIR_NAME  = "venv"
LOG_MAX_LINES  = 500

# ── Resource limits applied to each child script process ──────────────────────
SCRIPT_MAX_RAM_MB  = 256
SCRIPT_MAX_CPU_SEC = 3600
SCRIPT_MAX_FILES   = 256

# ── Persistence files ─────────────────────────────────────────────────────────
SCHEDULES_FILE  = os.path.join(DATA_DIR, "schedules.json")
RUNNING_FILE    = os.path.join(DATA_DIR, "running.json")

# ── Scheduler state ──────────────────────────────────────────────────────────
_schedules = {}
_schedules_lock = threading.Lock()

# ── Process tracking ─────────────────────────────────────────────────────────
processes    = {}
log_buffers  = collections.defaultdict(lambda: collections.deque(maxlen=LOG_MAX_LINES))
log_locks    = collections.defaultdict(threading.Lock)
_stop_events = {}  # script_name -> threading.Event (set when explicitly stopped)


# ═══════════════════════════════════════════════════════════════════════════════
#  Scheduler persistence
# ═══════════════════════════════════════════════════════════════════════════════

def load_schedules():
    global _schedules
    os.makedirs(os.path.dirname(SCHEDULES_FILE), exist_ok=True)
    if not os.path.exists(SCHEDULES_FILE):
        with open(SCHEDULES_FILE, "w") as f:
            json.dump({}, f)
    try:
        with open(SCHEDULES_FILE) as f:
            _schedules = json.load(f)
    except Exception:
        _schedules = {}

def save_schedules():
    try:
        os.makedirs(os.path.dirname(SCHEDULES_FILE), exist_ok=True)
        with open(SCHEDULES_FILE, "w") as f:
            json.dump(_schedules, f, indent=2)
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════════
#  Running-state persistence  (survives container restarts)
# ═══════════════════════════════════════════════════════════════════════════════

def load_running_state():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(RUNNING_FILE):
        return []
    try:
        with open(RUNNING_FILE) as f:
            return json.load(f)
    except Exception:
        return []

def save_running_state():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        running = [n for n, p in processes.items() if p and p.poll() is None]
        with open(RUNNING_FILE, "w") as f:
            json.dump(running, f)
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════════
#  Scheduler loop
# ═══════════════════════════════════════════════════════════════════════════════

def scheduler_loop():
    last_fired = {}
    while True:
        local = datetime.now()
        current_hhmm = local.strftime("%H:%M")
        current_day  = local.weekday()

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
                action = sched.get("action", "start")
                delay  = sched.get("delay_seconds", 0)
                dur    = sched.get("duration_seconds", 0)

                def _fire(sname=script_name, act=action, d=delay, dur=dur):
                    if d > 0:
                        time.sleep(d)
                    if act == "start":
                        run_script(sname)
                        if dur > 0:
                            time.sleep(dur)
                            stop_script(sname)
                    elif act == "stop":
                        stop_script(sname)
                    elif act == "restart":
                        stop_script(sname)
                        time.sleep(1)
                        run_script(sname)
                threading.Thread(target=_fire, daemon=True).start()

        today = local.strftime("%Y-%m-%d")
        last_fired = {k: v for k, v in last_fired.items() if k.endswith(today)}
        time.sleep(30)


# ═══════════════════════════════════════════════════════════════════════════════
#  Flask app
# ═══════════════════════════════════════════════════════════════════════════════

app = Flask(
    __name__,
    static_folder=os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "build"),
    static_url_path="",
)
CORS(app)


# ═══════════════════════════════════════════════════════════════════════════════
#  Child-process isolation  (preexec_fn for subprocess.Popen)
# ═══════════════════════════════════════════════════════════════════════════════

def child_preexec(script_path):
    def fn():
        # New session + process group (isolates signals from parent)
        try:
            os.setsid()
            os.setpgrp()
        except Exception:
            pass

        # Resource limits — keep generous so scripts don't get killed
        try:
            ram_bytes = SCRIPT_MAX_RAM_MB * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_DATA, (ram_bytes, ram_bytes))
            resource.setrlimit(resource.RLIMIT_CPU, (SCRIPT_MAX_CPU_SEC, SCRIPT_MAX_CPU_SEC + 60))
            resource.setrlimit(resource.RLIMIT_NOFILE, (SCRIPT_MAX_FILES, SCRIPT_MAX_FILES))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except Exception:
            pass

        # Drop privileges to 'runner' user if it exists — otherwise stay as current user
        try:
            user = pwd.getpwnam("runner")
            os.setgid(user.pw_gid)
            os.setuid(user.pw_uid)
        except Exception:
            pass
    return fn


# ═══════════════════════════════════════════════════════════════════════════════
#  Venv helpers
# ═══════════════════════════════════════════════════════════════════════════════

def create_venv(script_path):
    venv_path = os.path.join(script_path, VENV_DIR_NAME)
    if not os.path.exists(venv_path):
        subprocess.run(
            ["python3", "-m", "venv", venv_path],
            check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
    return venv_path

def install_requirements(venv_path, script_path):
    req_file = os.path.join(script_path, "requirements.txt")
    if os.path.exists(req_file):
        pip = os.path.join(venv_path, "bin", "pip")
        subprocess.run([pip, "install", "--upgrade", "pip"], check=False,
                       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        subprocess.run([pip, "install", "-r", req_file], check=False,
                       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})


# ═══════════════════════════════════════════════════════════════════════════════
#  Logging
# ═══════════════════════════════════════════════════════════════════════════════

def _append_log(name, line):
    ts = datetime.now().strftime("[%H:%M:%S] ")
    with log_locks[name]:
        log_buffers[name].append(ts + line)


# ═══════════════════════════════════════════════════════════════════════════════
#  Script lifecycle
# ═══════════════════════════════════════════════════════════════════════════════

def get_stats(script_name):
    proc = processes.get(script_name)
    stats = {"cpu": 0.0, "ram": 0.0}
    if proc and proc.poll() is None:
        try:
            p = psutil.Process(proc.pid)
            mem = p.memory_info().rss / (1024 * 1024)
            cpu = p.cpu_percent(interval=None)
            for child in p.children(recursive=True):
                try:
                    mem += child.memory_info().rss / (1024 * 1024)
                    cpu += child.cpu_percent(interval=None)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            stats["cpu"] = round(cpu, 1)
            stats["ram"] = round(mem, 1)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return stats


def run_script(script_name):
    # Don't re-start if already running
    existing = processes.get(script_name)
    if existing and existing.poll() is None:
        return

    script_path = os.path.join(SCRIPTS_DIR, script_name)
    if not os.path.isdir(script_path):
        return

    # Clear explicit-stop flag so restart loop is allowed
    if script_name in _stop_events:
        _stop_events[script_name].clear()

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
            # Check explicit-stop flag BEFORE launching
            if script_name in _stop_events and _stop_events[script_name].is_set():
                break

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

            # If explicitly stopped, do NOT restart
            if script_name in _stop_events and _stop_events[script_name].is_set():
                _append_log(script_name, f"[manager] '{script_name}' stopped.\n")
                break

            # If process was replaced by a new one, exit silently
            current = processes.get(script_name)
            if current is not proc:
                break

            if proc.returncode == 0:
                _append_log(script_name, f"[manager] '{script_name}' exited cleanly.\n")
                break

            _append_log(script_name,
                f"[manager] '{script_name}' crashed (exit {proc.returncode}). Restarting in 2s...\n")
            time.sleep(2)

    threading.Thread(target=start_loop, daemon=True).start()
    save_running_state()


def stop_script(script_name):
    # Mark as explicitly stopped so restart loop exits
    evt = _stop_events.get(script_name)
    if evt:
        evt.set()

    proc = processes.pop(script_name, None)
    if proc and proc.poll() is None:
        # Kill the ENTIRE process group — catches all children
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, OSError):
            try:
                proc.kill()
            except OSError:
                pass

    save_running_state()


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
            procs = [p]
            try:
                procs.extend(p.children(recursive=True))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            for child in procs:
                try:
                    for c in child.connections(kind="inet"):
                        if c.status == "LISTEN":
                            ports.append(c.laddr.port)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except Exception:
            pass
    return list(set(ports))


# ═══════════════════════════════════════════════════════════════════════════════
#  File helpers
# ═══════════════════════════════════════════════════════════════════════════════

def list_files_recursive(base_dir, prefix=""):
    results = []
    skip = {VENV_DIR_NAME, "__pycache__", ".git"}
    try:
        for entry in sorted(os.scandir(base_dir), key=lambda e: (not e.is_dir(), e.name)):
            if entry.name in skip or entry.name.startswith("."):
                continue
            rel = os.path.join(prefix, entry.name) if prefix else entry.name
            if entry.is_file():
                results.append({"path": rel, "type": "file"})
            elif entry.is_dir():
                results.append({"path": rel, "type": "directory"})
                results.extend(list_files_recursive(entry.path, rel))
    except PermissionError:
        pass
    return results


def safe_path(script_name, filename):
    base = os.path.realpath(os.path.join(SCRIPTS_DIR, script_name))
    target = os.path.realpath(os.path.join(base, filename))
    if not target.startswith(base + os.sep) and target != base:
        return None
    return target


# ═══════════════════════════════════════════════════════════════════════════════
#  API routes
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/api/scripts", methods=["GET"])
def api_list_scripts():
    if not os.path.exists(SCRIPTS_DIR):
        return jsonify([])
    scripts = sorted(
        d for d in os.listdir(SCRIPTS_DIR)
        if os.path.isdir(os.path.join(SCRIPTS_DIR, d))
    )
    return jsonify([
        {"name": s, "status": get_status(s), "ports": get_ports(s), "stats": get_stats(s)}
        for s in scripts
    ])


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
    with open(os.path.join(script_dir, "main.py"), "w") as f:
        f.write(data.get("python_content", f"# {name}\n\nprint('Hello from {name}!')\n"))
    with open(os.path.join(script_dir, "requirements.txt"), "w") as f:
        f.write(data.get("requirements_content", ""))
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
    time.sleep(1)
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


@app.route("/api/scripts/<name>/files/<path:filename>", methods=["DELETE"])
def api_delete_file(name, filename):
    dest = safe_path(name, filename)
    if not dest or not os.path.exists(dest):
        return jsonify({"error": "Not found"}), 404
    try:
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        else:
            os.remove(dest)
        return jsonify({"status": "deleted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/scripts/<name>/mkdir", methods=["POST"])
def api_mkdir(name):
    data = request.get_json()
    if not data or "path" not in data:
        return jsonify({"error": "Missing path"}), 400
    dest = safe_path(name, data["path"])
    if not dest:
        return jsonify({"error": "Invalid path"}), 400
    os.makedirs(dest, exist_ok=True)
    return jsonify({"status": "created"})


@app.route("/api/scripts/<name>", methods=["DELETE"])
def api_delete_script(name):
    stop_script(name)
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if os.path.exists(script_dir):
        shutil.rmtree(script_dir)
    return jsonify({"status": "deleted"})


# ── Scheduler API ─────────────────────────────────────────────────────────────

@app.route("/api/scripts/<name>/schedules", methods=["GET"])
def api_get_schedules(name):
    with _schedules_lock:
        return jsonify(_schedules.get(name, []))


@app.route("/api/scripts/<name>/schedules", methods=["POST"])
def api_add_schedule(name):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    sched = {
        "id":               str(uuid.uuid4())[:8],
        "action":           data.get("action", "start"),
        "time":             data.get("time", "08:00"),
        "days":             data.get("days", list(range(7))),
        "delay_seconds":    int(data.get("delay_seconds", 0)),
        "duration_seconds": int(data.get("duration_seconds", 0)),
        "enabled":          data.get("enabled", True),
        "label":            data.get("label", ""),
    }
    with _schedules_lock:
        _schedules.setdefault(name, []).append(sched)
        save_schedules()
    return jsonify(sched)


@app.route("/api/scripts/<name>/schedules/<sid>", methods=["PUT"])
def api_update_schedule(name, sid):
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    with _schedules_lock:
        scheds = _schedules.get(name, [])
        for i, s in enumerate(scheds):
            if s["id"] == sid:
                scheds[i].update({
                    "action":           data.get("action", s["action"]),
                    "time":             data.get("time",   s["time"]),
                    "days":             data.get("days",   s["days"]),
                    "delay_seconds":    int(data.get("delay_seconds", s["delay_seconds"])),
                    "duration_seconds": int(data.get("duration_seconds", s.get("duration_seconds", 0))),
                    "enabled":          data.get("enabled", s["enabled"]),
                    "label":            data.get("label",  s.get("label", "")),
                })
                save_schedules()
                return jsonify(scheds[i])
    return jsonify({"error": "Not found"}), 404


@app.route("/api/scripts/<name>/schedules/<sid>", methods=["DELETE"])
def api_delete_schedule(name, sid):
    with _schedules_lock:
        scheds = _schedules.get(name, [])
        _schedules[name] = [s for s in scheds if s["id"] != sid]
        save_schedules()
    return jsonify({"status": "deleted"})


# ── Frontend catch-all ────────────────────────────────────────────────────────

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    if path and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    return send_from_directory(app.static_folder, "index.html")


# ═══════════════════════════════════════════════════════════════════════════════
#  Bootstrap
# ═══════════════════════════════════════════════════════════════════════════════

def start_persisted_scripts():
    """Only re-start scripts that were running when the container last stopped."""
    for s in load_running_state():
        script_dir = os.path.join(SCRIPTS_DIR, s)
        if os.path.isdir(script_dir):
            _stop_events[s] = threading.Event()
            run_script(s)


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(SCRIPTS_DIR, exist_ok=True)
    print(f"[manager] static_folder = {app.static_folder}", flush=True)
    print(f"[manager] Starting Flask on 0.0.0.0:8080", flush=True)
    load_schedules()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    start_persisted_scripts()
    app.run(host="0.0.0.0", port=8080, threaded=True)
