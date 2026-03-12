import os
import subprocess
import threading
import psutil
import time
import json
import collections
import shutil
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

SCRIPTS_DIR = "/scripts"
VENV_DIR_NAME = "venv"
ALLOWED_PORTS = set(range(9051, 9075))
LOG_MAX_LINES = 500

app = Flask(__name__, static_folder=os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "build"), static_url_path="")
CORS(app)

processes = {}
log_buffers = collections.defaultdict(lambda: collections.deque(maxlen=LOG_MAX_LINES))
log_locks = collections.defaultdict(threading.Lock)

# ---------------- Helpers ---------------- #

def create_venv(script_path):
    venv_path = os.path.join(script_path, VENV_DIR_NAME)
    if not os.path.exists(venv_path):
        subprocess.run(["python3", "-m", "venv", venv_path], check=False)
    return venv_path

def install_requirements(venv_path, script_path):
    req_file = os.path.join(script_path, "requirements.txt")
    if os.path.exists(req_file):
        pip_path = os.path.join(venv_path, "bin", "pip")
        subprocess.run([pip_path, "install", "--upgrade", "pip"], check=False)
        subprocess.run([pip_path, "install", "-r", req_file], check=False)

def _append_log(script_name, line):
    with log_locks[script_name]:
        log_buffers[script_name].append(line)

def run_script(script_name):
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    venv_path = create_venv(script_path)
    install_requirements(venv_path, script_path)
    python_path = os.path.join(venv_path, "bin", "python")
    script_file = next((f for f in os.listdir(script_path) if f.endswith(".py")), None)
    if not script_file:
        _append_log(script_name, "[manager] No .py file found in script directory.\n")
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
            proc = subprocess.Popen(
                [python_path, script_file],
                cwd=script_path,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            processes[script_name] = proc
            t = threading.Thread(target=pipe_output, args=(proc.stdout, script_name), daemon=True)
            t.start()
            proc.wait()
            t.join(timeout=2)
            if processes.get(script_name) is not proc:
                _append_log(script_name, f"[manager] '{script_name}' stopped externally.\n")
                break
            if proc.returncode == 0:
                _append_log(script_name, f"[manager] '{script_name}' exited cleanly (code 0).\n")
                break
            _append_log(script_name, f"[manager] '{script_name}' crashed (exit {proc.returncode}). Restarting in 2s...\n")
            time.sleep(2)

    threading.Thread(target=start_loop, daemon=True).start()

def stop_script(script_name):
    proc = processes.pop(script_name, None)
    if proc and proc.poll() is None:
        try:
            # Kill entire process tree so child processes release their ports
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
            for c in p.connections():
                if c.status == "LISTEN":
                    ports.append(c.laddr.port)
        except Exception:
            pass
    return [p for p in ports if p in ALLOWED_PORTS]

# ---------------- API ---------------- #

@app.route("/api/scripts", methods=["GET"])
def api_list_scripts():
    if not os.path.exists(SCRIPTS_DIR):
        return jsonify([])
    scripts = sorted([d for d in os.listdir(SCRIPTS_DIR) if os.path.isdir(os.path.join(SCRIPTS_DIR, d))])
    return jsonify([{"name": s, "status": get_status(s), "ports": get_ports(s)} for s in scripts])

@app.route("/api/scripts", methods=["POST"])
def api_create_script():
    data = request.get_json()
    if not data or "name" not in data:
        return jsonify({"error": "Missing script name"}), 400
    name = data["name"].strip().replace(" ", "_")
    if not name:
        return jsonify({"error": "Invalid script name"}), 400
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if os.path.exists(script_dir):
        return jsonify({"error": f"Script '{name}' already exists"}), 409
    os.makedirs(script_dir, exist_ok=True)
    py_content = data.get("python_content", f"# Script: {name}\n\nprint('Hello from {name}!')\n")
    req_content = data.get("requirements_content", "")
    with open(os.path.join(script_dir, "main.py"), "w") as f:
        f.write(py_content)
    with open(os.path.join(script_dir, "requirements.txt"), "w") as f:
        f.write(req_content)
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
        return jsonify({"error": "No file provided"}), 400
    file.save(os.path.join(script_dir, file.filename))
    return jsonify({"status": "uploaded", "filename": file.filename})

@app.route("/api/scripts/<name>/files", methods=["GET"])
def api_list_files(name):
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if not os.path.exists(script_dir):
        return jsonify({"files": []})
    files = sorted([
        f for f in os.listdir(script_dir)
        if os.path.isfile(os.path.join(script_dir, f)) and f != VENV_DIR_NAME
    ])
    return jsonify({"files": files})

@app.route("/api/scripts/<name>/files/<filename>", methods=["GET"])
def api_get_file(name, filename):
    filepath = os.path.join(SCRIPTS_DIR, name, filename)
    if not os.path.exists(filepath):
        return jsonify({"error": "File not found"}), 404
    with open(filepath, "r", errors="replace") as f:
        content = f.read()
    return jsonify({"filename": filename, "content": content})

@app.route("/api/scripts/<name>/files/<filename>", methods=["PUT"])
def api_save_file(name, filename):
    script_dir = os.path.join(SCRIPTS_DIR, name)
    os.makedirs(script_dir, exist_ok=True)
    data = request.get_json()
    if not data or "content" not in data:
        return jsonify({"error": "Missing content"}), 400
    with open(os.path.join(script_dir, filename), "w") as f:
        f.write(data["content"])
    return jsonify({"status": "saved"})

@app.route("/api/scripts/<name>", methods=["DELETE"])
def api_delete_script(name):
    stop_script(name)
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if os.path.exists(script_dir):
        shutil.rmtree(script_dir)
    return jsonify({"status": "deleted"})

# Serve React frontend
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    if path != "" and os.path.exists(os.path.join(app.static_folder, path)):
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
    start_all_scripts()
    app.run(host="0.0.0.0", port=8080, threaded=True)

