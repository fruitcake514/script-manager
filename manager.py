"""pyRunner manager v3 — FastAPI + pluggable execution backends.

Backends (EXEC_BACKEND):
  subprocess : every app = venv + child process, rlimits, log pipes (default;
               zero extra privileges, same as v2).
  auto       : jobs -> subprocess; services -> rootless Podman containers
               *inside* this container when podman works, else subprocess.
  podman     : services must use Podman (401? no — 500 with clear error if
               podman unavailable).

Podman-in-container needs NO docker.sock and NO host mounts. It does need the
manager container started with `security_opt: [seccomp:unconfined]` (stock
seccomp blocks the mount() calls any OCI runtime needs). The host Docker
daemon is never touched.

API shapes are unchanged from v2 so the React frontend works untouched.
Validation errors return {"error": ...} with 400 (not FastAPI's 422).
"""
import os
import re
import sys
import time
import json
import hmac
import hashlib
import shutil
import signal
import resource
import threading
import collections
import subprocess
import uuid as _uuid_mod
from datetime import datetime
from typing import Optional

import psutil
from fastapi import FastAPI, Depends, HTTPException, Request, UploadFile, File as FastFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ── Config ───────────────────────────────────────────────────────────────
SCRIPTS_DIR   = os.environ.get("SCRIPTS_DIR", "/scripts")
DATA_DIR      = os.environ.get("DATA_DIR", "/data")
VENV_DIR_NAME = "venv"
LOG_MAX_LINES = int(os.environ.get("LOG_MAX_LINES", "500"))

SCRIPT_MAX_RAM_MB  = int(os.environ.get("SCRIPT_MAX_RAM_MB", "512"))
SCRIPT_JOB_CPU_SEC = int(os.environ.get("SCRIPT_MAX_CPU_SEC", "3600"))
SCRIPT_MAX_FILES   = int(os.environ.get("SCRIPT_MAX_FILES", "256"))
# Max tasks (processes+threads) for the shared `runner` UID across ALL apps.
# Bounds fork bombs; one generous shared budget (manager itself is root).
SCRIPT_MAX_NPROC   = int(os.environ.get("SCRIPT_MAX_NPROC", "1024"))
SERVICE_CPU_SEC = int(os.environ.get("SERVICE_MAX_CPU_SEC", "31536000"))

EXEC_BACKEND = os.environ.get("EXEC_BACKEND", "subprocess").lower()  # subprocess|auto|podman
PODMAN_BASE_IMAGE = os.environ.get("PODMAN_BASE_IMAGE", "docker.io/library/python:3.12-slim")
PODMAN_MEMORY = os.environ.get("PODMAN_MEMORY", "512m")
PODMAN_CPUS = os.environ.get("PODMAN_CPUS", "1.0")

API_TOKEN = os.environ.get("API_TOKEN", "")
MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", str(2 * 1024 * 1024)))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
CACHE_TTL = 4.0
PORT_START = int(os.environ.get("PORT_START", "9051"))
PORT_END   = int(os.environ.get("PORT_END", "9075"))
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "240"))

SCHEDULES_FILE = os.path.join(DATA_DIR, "schedules.json")
RUNNING_FILE   = os.path.join(DATA_DIR, "running.json")
META_FILE      = os.path.join(DATA_DIR, "meta.json")

SCRIPT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
BLOCKED_PREFIXES = (VENV_DIR_NAME + "/", "__pycache__/", ".git/", ".venv/")
ENTRY_PRIORITY = ["main.py", "app.py", "run.py", "server.py"]

# ── State ────────────────────────────────────────────────────────────────
_schedules = {}
_schedules_lock = threading.Lock()
_meta = {}
_meta_lock = threading.Lock()
processes = {}
_processes_lock = threading.Lock()
log_buffers = collections.defaultdict(lambda: collections.deque(maxlen=LOG_MAX_LINES))
log_locks = collections.defaultdict(threading.Lock)
_stop_events = {}
_stop_lock = threading.Lock()
_req_hash = {}
_stats_cache = {}
_ports_cache = {}
_runtime = {}
_runtime_lock = threading.Lock()
_hits = collections.defaultdict(collections.deque)
_hits_lock = threading.Lock()
_podman_ok = {"ts": 0.0, "ok": False}


def get_stop_event(name):
    with _stop_lock:
        evt = _stop_events.get(name)
        if evt is None:
            evt = threading.Event()
            _stop_events[name] = evt
        return evt


def valid_name(name):
    return isinstance(name, str) and bool(SCRIPT_NAME_RE.match(name))


def err(status: int, msg: str):
    raise HTTPException(status_code=status, detail=msg)


def atomic_write_json(path, obj):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(obj, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        pass


# ── Meta / schedules / running state ─────────────────────────────────────
def load_meta():
    global _meta
    if os.path.exists(META_FILE):
        try:
            with open(META_FILE) as f:
                data = json.load(f)
            _meta = data if isinstance(data, dict) else {}
        except Exception:
            _meta = {}
    else:
        _meta = {}


def save_meta():
    with _meta_lock:
        snapshot = dict(_meta)
    atomic_write_json(META_FILE, snapshot)


def get_meta(name):
    with _meta_lock:
        m = _meta.get(name)
        if isinstance(m, dict):
            return dict(m)
    return {"app_type": "job", "port": None, "entry": None}


def set_meta(name, patch):
    with _meta_lock:
        cur = _meta.get(name) if isinstance(_meta.get(name), dict) else {}
        cur = dict(cur)
        for k in ("app_type", "port", "entry", "backend"):
            if k in patch:
                cur[k] = patch[k]
        _meta[name] = cur
        out = dict(cur)
    atomic_write_json(META_FILE, _meta)
    return out


def allocate_port(exclude_name=None):
    with _meta_lock:
        taken = {m.get("port") for n, m in _meta.items()
                 if isinstance(m, dict) and n != exclude_name}
    try:
        live = set()
        for c in psutil.net_connections(kind="inet"):
            try:
                if c.status == "LISTEN" and c.laddr:
                    live.add(int(c.laddr.port))
            except Exception:
                continue
    except Exception:
        live = set()
    for p in range(PORT_START, PORT_END + 1):
        if p not in taken and p not in live:
            return p
    return None


def find_entry(script_path, preferred=None):
    try:
        files = [f for f in os.listdir(script_path) if f.endswith(".py")]
    except OSError:
        return None
    if not files:
        return None
    if preferred and preferred in files:
        return preferred
    for cand in ENTRY_PRIORITY:
        if cand in files:
            return cand
    return sorted(files)[0]


def load_schedules():
    global _schedules
    os.makedirs(os.path.dirname(SCHEDULES_FILE), exist_ok=True)
    if not os.path.exists(SCHEDULES_FILE):
        atomic_write_json(SCHEDULES_FILE, {})
    try:
        with open(SCHEDULES_FILE) as f:
            data = json.load(f)
        _schedules = data if isinstance(data, dict) else {}
    except Exception:
        _schedules = {}


def save_schedules():
    with _schedules_lock:
        snapshot = {k: list(v) for k, v in _schedules.items()}
    atomic_write_json(SCHEDULES_FILE, snapshot)


def load_running_state():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(RUNNING_FILE):
        return []
    try:
        with open(RUNNING_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _handle_alive(name, h):
    """Liveness of an already-fetched handle. Takes NO locks — callers must
    snapshot the handle first, then evaluate outside the lock."""
    if h is None:
        return False
    if isinstance(h, tuple):
        return podman_alive(name) if h[0] == "podman" else False
    try:
        return h.poll() is None
    except Exception:
        return False


def save_running_state():
    try:
        with _processes_lock:
            items = list(processes.items())
        running = [n for n, p in items if p and _handle_alive(n, p)]
        atomic_write_json(RUNNING_FILE, running)
    except Exception:
        pass


def validate_schedule(data, existing=None):
    base = dict(existing) if existing else {}
    action = data.get("action", base.get("action", "start"))
    if action not in ("start", "stop", "restart"):
        return None, "action must be start|stop|restart"
    t = data.get("time", base.get("time", "08:00"))
    if not isinstance(t, str) or not TIME_RE.match(t):
        return None, "time must be HH:MM (24h)"
    days = data.get("days", base.get("days", list(range(7))))
    if not isinstance(days, list) or not days or not all(isinstance(d, int) and 0 <= d <= 6 for d in days):
        return None, "days must be non-empty list of 0-6"
    try:
        delay = int(data.get("delay_seconds", base.get("delay_seconds", 0)))
        dur = int(data.get("duration_seconds", base.get("duration_seconds", 0)))
    except (TypeError, ValueError):
        return None, "delay/duration must be integers"
    if not (0 <= delay <= 86400 and 0 <= dur <= 86400):
        return None, "delay/duration must be 0..86400"
    sched = dict(base)
    sched.update({
        "action": action, "time": t, "days": sorted(set(days)),
        "delay_seconds": delay, "duration_seconds": dur,
        "enabled": bool(data.get("enabled", base.get("enabled", True))),
        "label": str(data.get("label", base.get("label", "")))[:120],
    })
    return sched, None


def scheduler_loop():
    last_fired = {}
    while True:
        try:
            local = datetime.now()
            hhmm = local.strftime("%H:%M")
            day = local.weekday()
            today = local.strftime("%Y-%m-%d")
            with _schedules_lock:
                snapshot = {k: list(v) for k, v in _schedules.items()}
            for script_name, scheds in snapshot.items():
                if not valid_name(script_name):
                    continue
                if not os.path.isdir(os.path.join(SCRIPTS_DIR, script_name)):
                    continue
                for sched in scheds:
                    if not isinstance(sched, dict):
                        continue
                    if not sched.get("enabled", True):
                        continue
                    if day not in sched.get("days", list(range(7))):
                        continue
                    if sched.get("time") != hhmm:
                        continue
                    sid = sched.get("id", "?")
                    key = "%s:%s:%s" % (script_name, sid, today)
                    if key in last_fired:
                        continue
                    last_fired[key] = True
                    action = sched.get("action", "start")
                    delay = int(sched.get("delay_seconds", 0) or 0)
                    dur = int(sched.get("duration_seconds", 0) or 0)

                    def _fire(sname=script_name, act=action, d=delay, du=dur):
                        if d > 0:
                            time.sleep(min(d, 86400))
                        if act == "start":
                            run_script(sname)
                            if du > 0:
                                time.sleep(min(du, 86400))
                                stop_script(sname)
                        elif act == "stop":
                            stop_script(sname)
                        elif act == "restart":
                            stop_script(sname)
                            time.sleep(1)
                            run_script(sname)
                    threading.Thread(target=_fire, daemon=True).start()
            last_fired = {k: v for k, v in last_fired.items() if k.endswith(today)}
            time.sleep(15)
        except Exception:
            time.sleep(15)


# ═══════════════════════════════════════════════════════════════════════════
#  Execution backends
# ═══════════════════════════════════════════════════════════════════════════
def _append_log(name, line):
    if len(line) > 10000:
        line = line[:10000] + "…[truncated]\n"
    ts = datetime.now().strftime("[%H:%M:%S] ")
    with log_locks[name]:
        log_buffers[name].append(ts + line)


def podman_available():
    now = time.monotonic()
    if now - _podman_ok["ts"] < 60:
        return _podman_ok["ok"]
    ok = False
    if shutil.which("podman"):
        try:
            r = subprocess.run(["podman", "info", "--format", "{{.Store.GraphRoot}}"],
                               capture_output=True, timeout=15)
            ok = r.returncode == 0
        except Exception:
            ok = False
    _podman_ok.update(ts=now, ok=ok)
    return ok


def want_podman(app_type):
    if app_type != "service":
        return False
    if EXEC_BACKEND == "podman":
        return True
    if EXEC_BACKEND == "auto":
        return podman_available()
    return False


def cname(name):
    return "pyrunner-%s" % name


# ── Subprocess backend (jobs, and services when podman off/unavailable) ───
def _runner_ids():
    """(uid, gid) of the unprivileged user, or None (dev runs / no user)."""
    try:
        import pwd as _pwd
        u = _pwd.getpwnam("runner")
        return (u.pw_uid, u.pw_gid, u.pw_dir)
    except (KeyError, ImportError):
        return None


def _as_runner(cmd):
    """Prefix a command so it runs as `runner` when we are root and the user
    exists. setup/pip must NEVER run as root: requirements can execute
    arbitrary code. Falls back to direct execution (dev machines)."""
    if os.geteuid() == 0:
        ids = _runner_ids()
        if ids:
            uid, gid, home = ids
            for tool in ("setpriv", "runuser"):
                if shutil.which(tool):
                    if tool == "setpriv":
                        return (["setpriv", "--reuid", str(uid), "--regid", str(gid),
                                 "--clear-groups", "--"] + cmd, home)
                    return (["runuser", "-u", "runner", "--"] + cmd, home)
    return (list(cmd), None)


def _chown_runner(path):
    """Best-effort: keep app files owned by runner so apps can read/write
    their own tree (manager-created files would otherwise be root-owned)."""
    try:
        if os.geteuid() != 0:
            return
        ids = _runner_ids()
        if not ids:
            return
        uid, gid, _home = ids
        if os.path.isdir(path) and not os.path.islink(path):
            for root, dirs, files in os.walk(path):
                for d in dirs:
                    try:
                        os.chown(os.path.join(root, d), uid, gid)
                    except OSError:
                        pass
                for fn in files:
                    try:
                        os.chown(os.path.join(root, fn), uid, gid)
                    except OSError:
                        pass
        try:
            os.chown(path, uid, gid)
        except OSError:
            pass
    except Exception:
        pass


def child_preexec(cpu_limit):
    def fn():
        try:
            os.setsid()
        except Exception:
            pass
        try:
            ram = SCRIPT_MAX_RAM_MB * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (ram, ram))
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit, cpu_limit + 60))
            resource.setrlimit(resource.RLIMIT_NOFILE, (SCRIPT_MAX_FILES, SCRIPT_MAX_FILES))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            # Shared per-UID budget across all apps (manager is root, unaffected)
            resource.setrlimit(resource.RLIMIT_NPROC, (SCRIPT_MAX_NPROC, SCRIPT_MAX_NPROC))
        except Exception:
            pass
        try:
            import pwd as _pwd
            user = _pwd.getpwnam("runner")
            os.setgid(user.pw_gid)
            os.setuid(user.pw_uid)
        except Exception:
            pass
    return fn


def _runner_env(base=None):
    """Env for setup commands: no bytecode/cache writes outside the app tree."""
    env = dict(base or os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PIP_NO_INPUT"] = "1"
    env["PIP_NO_CACHE_DIR"] = "1"
    ids = _runner_ids()
    if ids and os.geteuid() == 0:
        env["HOME"] = ids[2]  # pip/setuptools expect a writable HOME
    return env


def create_venv(script_path):
    venv_path = os.path.join(script_path, VENV_DIR_NAME)
    if not os.path.exists(os.path.join(venv_path, "bin", "python")):
        # Absolute interpreter: privilege wrappers (setpriv/runuser) must not
        # rely on PATH resolution after the uid switch.
        cmd, _home = _as_runner([sys.executable, "-m", "venv", venv_path])
        r = subprocess.run(cmd, check=False, timeout=300,
                           capture_output=True, text=True,
                           env=_runner_env({"PYTHONDONTWRITEBYTECODE": "1"}))
        if r.returncode != 0:
            _append_log(os.path.basename(script_path),
                        "[manager] venv creation failed: %s\n"
                        % (r.stderr or r.stdout or "rc=%d" % r.returncode)[-1500:])
        _chown_runner(venv_path)
    return venv_path


def install_requirements(venv_path, script_path, script_name):
    req = os.path.join(script_path, "requirements.txt")
    if not os.path.exists(req):
        _req_hash.pop(script_name, None)
        return
    try:
        if os.path.getsize(req) > 1024 * 1024:
            _append_log(script_name, "[manager] requirements.txt too large, skipping install.\n")
            return
        with open(req, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return
    if _req_hash.get(script_name) == digest:
        return
    pip = os.path.join(venv_path, "bin", "pip")
    if not os.path.exists(pip):
        return
    env = _runner_env({"PYTHONDONTWRITEBYTECODE": "1"})
    cmd, _home = _as_runner([pip, "install", "-r", req, "--quiet",
                             "--disable-pip-version-check"])
    try:
        r = subprocess.run(cmd, check=False, timeout=600, capture_output=True,
                           text=True, env=env)
        if r.returncode != 0:
            _append_log(script_name, "[manager] pip install failed: %s\n"
                        % (r.stderr or r.stdout or "rc=%d" % r.returncode)[-1500:])
            return
        _req_hash[script_name] = digest
        _chown_runner(venv_path)  # pip may create root-owned files if fallback ran as root
    except subprocess.TimeoutExpired:
        _append_log(script_name, "[manager] pip install timed out.\n")


def _pipe_output(stream, sname):
    try:
        for line in iter(stream.readline, b""):
            _append_log(sname, line.decode("utf-8", errors="replace"))
    finally:
        try:
            stream.close()
        except Exception:
            pass


def subproc_start(script_name, script_path, script_file, app_type, assigned_port):
    cpu_limit = SERVICE_CPU_SEC if app_type == "service" else SCRIPT_JOB_CPU_SEC
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    if assigned_port:
        env["PORT"] = str(assigned_port)
        env["ASSIGNED_PORT"] = str(assigned_port)
    venv_path = os.path.join(script_path, VENV_DIR_NAME)
    python_path = os.path.join(venv_path, "bin", "python")
    proc = subprocess.Popen(
        [python_path, script_file], cwd=script_path, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        preexec_fn=child_preexec(cpu_limit),
    )
    with _processes_lock:
        processes[script_name] = proc
    save_running_state()
    t = threading.Thread(target=_pipe_output, args=(proc.stdout, script_name), daemon=True)
    t.start()
    return proc, t


def subproc_stop(script_name):
    with _processes_lock:
        proc = processes.pop(script_name, None)
    if proc and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, OSError):
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except OSError:
                    pass


def subproc_alive(script_name):
    with _processes_lock:
        proc = processes.get(script_name)
    return proc is not None and proc.poll() is None


# ── Podman backend (services only; containers live inside this container) ─
def _pod_run(args, timeout=60):
    return subprocess.run(["podman"] + args, capture_output=True, text=True, timeout=timeout)


def podman_ensure_base():
    """Best-effort pull of the service base image (call once at startup)."""
    try:
        _pod_run(["pull", PODMAN_BASE_IMAGE], timeout=600)
    except Exception:
        pass


def podman_start(script_name, script_path, script_file, assigned_port, app_type):
    appdir = os.path.realpath(script_path)
    # Wrapper installs deps then execs the app, so UI file edits apply live.
    boot_sh = (
        "set -e\n"
        "if [ -f /app/requirements.txt ]; then\n"
        "  dh=$(sha256sum /app/requirements.txt | cut -d' ' -f1)\n"
        "  if [ \"$dh\" != \"$REQ_HASH\" ]; then\n"
        "    echo \"[container] pip install requirements...\"\n"
        "    pip install -q -r /app/requirements.txt --disable-pip-version-check\n"
        "  else echo \"[container] requirements unchanged, skipping pip\"\n"
        "  fi\n"
        "fi\n"
        "exec python3 -u /app/%s\n" % script_file
    )
    with open(os.path.join(script_path, ".pyrunner-boot.sh"), "w") as f:
        f.write(boot_sh)
    req = ""
    try:
        with open(os.path.join(script_path, "requirements.txt"), "rb") as f:
            req = hashlib.sha256(f.read()).hexdigest()
    except OSError:
        pass
    args = ["run", "-d", "--replace", "--name", cname(script_name),
            # NOTE: --cgroups=disabled because an inner runtime usually cannot
            # write the host's cgroupfs (ro bind). Namespaces (mnt/pid/net)
            # still isolate fully; hard RSS/CPU caps are applied below via
            # prlimit() on the container init PID (same strength as the
            # subprocess backend's rlimits).
            "--cgroups", "disabled",
            "--stop-timeout", "5",
            "--label", "pyrunner=%s" % script_name,
            # slirp4netns = userspace networking that works rootful-in-container.
            # (pasta requires rootless; bridge/netavark need host net admin.)
            "--network", "slirp4netns",
            "-v", "%s:/app:Z" % appdir,
            "-e", "PORT=%s" % (assigned_port or ""),
            "-e", "ASSIGNED_PORT=%s" % (assigned_port or ""),
            "-e", "REQ_HASH=%s" % req,
            "-e", "PYTHONUNBUFFERED=1",
            "-w", "/app",
            PODMAN_BASE_IMAGE, "sh", "/app/.pyrunner-boot.sh"]
    if assigned_port:
        i = args.index("slirp4netns")
        args[i:i + 1] = ["slirp4netns", "-p", "%d:%d" % (assigned_port, assigned_port)]
    r = _pod_run(args, timeout=120)
    if r.returncode != 0:
        raise RuntimeError("podman run failed: %s" % (r.stderr or r.stdout)[-2000:])
    _podman_prlimit(script_name, app_type)
    with _processes_lock:
        processes[script_name] = ("podman", cname(script_name))
    save_running_state()
    t = threading.Thread(target=_podman_follow_logs, args=(script_name,), daemon=True)
    t.start()
    return t


def _podman_prlimit(script_name, app_type):
    """Apply hard RSS/CPU/fd caps to the container init PID (cgroups
    unavailable to nested runtimes, so prlimit is the enforcement).
    NOTE: no RLIMIT_NPROC here — inner containers run as uid 0, which is
    SHARED with the manager itself; a per-UID task cap would count (and
    throttle) the manager too. Residual risk: fork bombs inside inner
    containers are bounded only by host pid_max. Prefer the subprocess
    backend (per-UID `runner` budget) for untrusted code, or run inner
    containers with --userns=auto so they get their own UID budget."""
    try:
        r = _pod_run(["inspect", "-f", "{{.State.Pid}}", cname(script_name)], timeout=15)
        pid = int((r.stdout or "0").strip() or 0)
        if not pid:
            return
        ram = SCRIPT_MAX_RAM_MB * 1024 * 1024
        cpu = SERVICE_CPU_SEC if app_type == "service" else SCRIPT_JOB_CPU_SEC
        subprocess.run(["prlimit", "--pid", str(pid),
                        "--as=%d:%d" % (ram, ram),
                        "--cpu=%d:%d" % (cpu, cpu + 60),
                        "--nofile=%d:%d" % (SCRIPT_MAX_FILES, SCRIPT_MAX_FILES),
                        "--core=0:0"],
                       capture_output=True, timeout=15)
    except Exception as e:
        _append_log(script_name, "[manager] prlimit skipped: %s\n" % e)


def _podman_follow_logs(script_name):
    try:
        p = subprocess.Popen(["podman", "logs", "-f", "--tail", "200", cname(script_name)],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for line in iter(p.stdout.readline, b""):
            if get_stop_event(script_name).is_set():
                break
            _append_log(script_name, line.decode("utf-8", errors="replace"))
        try:
            p.terminate()
        except Exception:
            pass
    except Exception as e:
        _append_log(script_name, "[manager] log follow failed: %s\n" % e)


def podman_alive(script_name):
    try:
        r = _pod_run(["inspect", "-f", "{{.State.Running}}", cname(script_name)], timeout=15)
        return r.returncode == 0 and "true" in r.stdout.lower()
    except Exception:
        return False


def podman_wait_exit(script_name, timeout=86400):
    """Block until the container exits; returns exit code or None on stop/timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if get_stop_event(script_name).is_set():
            return None
        try:
            r = _pod_run(["wait", "--condition", "exited-or-removed", cname(script_name)],
                         timeout=min(30, max(1, int(deadline - time.time()))))
            if r.returncode == 0:
                try:
                    return int(r.stdout.strip().split()[-1])
                except Exception:
                    return 0
        except subprocess.TimeoutExpired:
            continue
        except Exception:
            time.sleep(2)
    return None


def podman_stop(script_name):
    with _processes_lock:
        processes.pop(script_name, None)
    try:
        _pod_run(["stop", "-t", "5", cname(script_name)], timeout=30)
    except Exception:
        pass
    try:
        _pod_run(["rm", "-f", cname(script_name)], timeout=30)
    except Exception:
        pass


def podman_stats(script_name):
    try:
        r = _pod_run(["stats", "--no-stream", "--format", "json", cname(script_name)], timeout=15)
        if r.returncode != 0:
            return None
        data = json.loads(r.stdout.strip().splitlines()[0] if r.stdout.strip() else "null")
        if isinstance(data, list):
            data = data[0] if data else None
        if not isinstance(data, dict):
            return None
        cpu = float(str(data.get("CPUPerc", "0")).strip().rstrip("%") or 0)
        mem_raw = str(data.get("MemUsage", "0"))
        mem_mb = _parse_mb(mem_raw.split("/")[0].strip())
        return {"cpu": round(cpu, 1), "ram": round(mem_mb, 1)}
    except Exception:
        return None


def _parse_mb(s):
    m = re.match(r"([\d.]+)\s*([KMGT]?i?B)?", s.strip(), re.I)
    if not m:
        return 0.0
    val = float(m.group(1))
    unit = (m.group(2) or "B").upper()
    factor = {"B": 1 / 1048576, "KB": 1 / 1024, "KIB": 1 / 1024, "MB": 1,
              "MIB": 1, "GB": 1024, "GIB": 1024, "TB": 1024 * 1024}.get(unit, 1)
    return val * factor


def podman_ports(script_name):
    try:
        r = _pod_run(["port", cname(script_name)], timeout=15)
        ports = set()
        for line in (r.stdout or "").splitlines():
            m = re.search(r"(\d+)$", line.strip().split("->")[-1].strip())
            if m:
                ports.add(int(m.group(1)))
        if ports:
            return sorted(ports)
        # Fallback: container PID is visible in our own pid namespace
        r2 = _pod_run(["inspect", "-f", "{{.State.Pid}}", cname(script_name)], timeout=15)
        pid = int((r2.stdout or "0").strip() or 0)
        if pid:
            return _ports_for_pids(_tree_pids(pid))
    except Exception:
        pass
    return []


# ── Unified lifecycle ────────────────────────────────────────────────────
def backend_kind(script_name):
    with _processes_lock:
        h = processes.get(script_name)
    if isinstance(h, tuple) and h[0] == "podman":
        return "podman"
    if h is not None:
        return "subprocess"
    m = get_meta(script_name)
    return "podman" if want_podman(m.get("app_type", "job")) else "subprocess"


def backend_running(name):
    with _processes_lock:
        h = processes.get(name)
    return _handle_alive(name, h)


def run_script(script_name):
    if not valid_name(script_name):
        return
    with _processes_lock:
        existing = processes.get(script_name)
    if existing is not None and _handle_alive(script_name, existing):
        return
    script_path = os.path.join(SCRIPTS_DIR, script_name)
    if not os.path.isdir(script_path):
        return
    get_stop_event(script_name).clear()
    meta = get_meta(script_name)
    app_type = meta.get("app_type", "job")
    if app_type not in ("service", "job"):
        app_type = "job"
    use_podman = want_podman(app_type)
    if EXEC_BACKEND == "podman" and app_type == "service" and not podman_available():
        _append_log(script_name, "[manager] EXEC_BACKEND=podman but podman is unavailable.\n")
        return

    def _setup_and_loop():
        try:
            venv_path = create_venv(script_path)
            install_requirements(venv_path, script_path, script_name)
        except Exception as e:
            _append_log(script_name, "[manager] setup failed: %s\n" % e)
            return
        meta_now = get_meta(script_name)
        entry = meta_now.get("entry") if isinstance(meta_now, dict) else None
        script_file = find_entry(script_path, entry)
        python_path = os.path.join(venv_path, "bin", "python")
        if use_podman:
            if not script_file:
                _append_log(script_name, "[manager] No .py file found.\n")
                return
        elif not script_file or not os.path.exists(python_path):
            _append_log(script_name, "[manager] No .py file or venv python missing.\n")
            return
        if script_file and (not entry or entry != script_file):
            try:
                set_meta(script_name, {"entry": script_file})
            except Exception:
                pass
        assigned_port = get_meta(script_name).get("port")
        kind = "podman" if use_podman else "subprocess"
        try:
            set_meta(script_name, {"backend": kind})
        except Exception:
            pass

        attempt = 0
        crashes = 0
        while True:
            if get_stop_event(script_name).is_set():
                break
            attempt += 1
            with _runtime_lock:
                r = _runtime.get(script_name, {})
                r["start_ts"] = time.time()
                r["restarts"] = crashes
                _runtime[script_name] = r
            _append_log(script_name, "[manager] Starting '%s' (attempt %d, type=%s, via=%s)...\n"
                        % (script_file, attempt, app_type, kind))
            code = None
            try:
                if use_podman:
                    podman_start(script_name, script_path, script_file,
                                 assigned_port, app_type)
                    code = podman_wait_exit(script_name)
                else:
                    proc, t = subproc_start(script_name, script_path, script_file,
                                            app_type, assigned_port)
                    try:
                        proc.wait()
                    except Exception:
                        pass
                    t.join(timeout=2)
                    code = proc.returncode
            except Exception as e:
                _append_log(script_name, "[manager] start failed: %s\n" % e)
                code = -1
                time.sleep(5)
            with _runtime_lock:
                r = _runtime.get(script_name, {})
                r["last_exit"] = datetime.now().isoformat(timespec="seconds")
                r["last_code"] = code
                _runtime[script_name] = r
            if get_stop_event(script_name).is_set():
                _append_log(script_name, "[manager] '%s' stopped.\n" % script_name)
                break
            if not use_podman:
                with _processes_lock:
                    cur = processes.get(script_name)
                if cur is not proc:
                    break  # replaced by a newer run, or popped by stop_script
            if code == 0:
                if app_type == "service":
                    _append_log(script_name, "[manager] service exited 0 — restarting in 2s.\n")
                    time.sleep(2)
                    crashes += 1
                    continue
                _append_log(script_name, "[manager] '%s' exited cleanly.\n" % script_name)
                break
            if code is None:  # stopped or wait timed out while stopping
                break
            crashes += 1
            with _runtime_lock:
                _runtime.get(script_name, {})["restarts"] = crashes
            if app_type == "job" and crashes > 5:
                _append_log(script_name, "[manager] job crashed 5+ times — giving up until manual start.\n")
                break
            backoff = 2 if app_type == "service" else min(2 * crashes, 30)
            _append_log(script_name, "[manager] '%s' crashed (exit %s). Restarting in %ss...\n"
                        % (script_name, code, backoff))
            time.sleep(backoff)
        save_running_state()

    threading.Thread(target=_setup_and_loop, daemon=True).start()
    save_running_state()


def stop_script(script_name):
    if not valid_name(script_name):
        return
    get_stop_event(script_name).set()
    kind = backend_kind(script_name)
    if kind == "podman":
        podman_stop(script_name)
    else:
        subproc_stop(script_name)
    _stats_cache.pop(script_name, None)
    _ports_cache.pop(script_name, None)
    save_running_state()


def get_status(script_name):
    return "running" if backend_running(script_name) else "stopped"


# ── Stats / ports (cached, batched) ──────────────────────────────────────
def _psutil_stats(pid):
    """RSS/CPU for a pid tree. Returns None if the process is gone."""
    try:
        p = psutil.Process(pid)
        p.cpu_percent(interval=None)
        mem = p.memory_info().rss / (1024 * 1024)
        cpu = 0.0
        for child in p.children(recursive=True):
            try:
                mem += child.memory_info().rss / (1024 * 1024)
                cpu += child.cpu_percent(interval=None)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        cpu += p.cpu_percent(interval=None)
        return {"cpu": round(cpu, 1), "ram": round(mem, 1)}
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def podman_pid(script_name):
    try:
        r = _pod_run(["inspect", "-f", "{{.State.Pid}}", cname(script_name)], timeout=15)
        return int((r.stdout or "0").strip() or 0)
    except Exception:
        return 0


def _tree_pids(pid):
    out = {pid}
    try:
        for child in psutil.Process(pid).children(recursive=True):
            out.add(child.pid)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return out


def get_stats(script_name):
    now = time.monotonic()
    hit = _stats_cache.get(script_name)
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]
    stats = {"cpu": 0.0, "ram": 0.0}
    if backend_kind(script_name) == "podman":
        # cgroups are off for nested containers, so `podman stats` can't work;
        # measure the container init PID tree directly (same userns).
        s = podman_stats(script_name)
        if s:
            stats = s
        else:
            pid = podman_pid(script_name)
            if pid and podman_alive(script_name):
                m = _psutil_stats(pid)
                if m:
                    stats = m
    else:
        with _processes_lock:
            proc = processes.get(script_name)
            alive = proc is not None and not isinstance(proc, tuple) and proc.poll() is None
            pid = proc.pid if alive else None
        if alive:
            m = _psutil_stats(pid)
            if m:
                stats = m
    _stats_cache[script_name] = (now, stats)
    return stats


def _ports_for_pids(tree_pids, conns=None):
    ports = set()
    try:
        conns = conns if conns is not None else psutil.net_connections(kind="inet")
    except Exception:
        return []
    for c in conns:
        try:
            if c.status == "LISTEN" and c.pid in tree_pids and c.laddr:
                ports.add(int(c.laddr.port))
        except Exception:
            continue
    if ports:
        return sorted(ports)
    try:
        inodes = set()
        for pid in tree_pids:
            fd_dir = "/proc/%d/fd" % pid
            try:
                for fd in os.listdir(fd_dir):
                    try:
                        link = os.readlink(os.path.join(fd_dir, fd))
                        if link.startswith("socket:["):
                            inodes.add(link[8:-1])
                    except (OSError, ValueError):
                        pass
            except (OSError, PermissionError):
                pass
        for path in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                with open(path) as f:
                    for line in f:
                        parts = line.strip().split()
                        if len(parts) < 10 or parts[0] == "sl:":
                            continue
                        if parts[3] == "0A" and parts[9] in inodes:
                            ports.add(int(parts[1].rsplit(":", 1)[-1], 16))
            except OSError:
                continue
    except Exception:
        pass
    return sorted(ports)


def get_ports(script_name, _conns=None):
    now = time.monotonic()
    hit = _ports_cache.get(script_name)
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]
    ports = []
    if backend_kind(script_name) == "podman":
        if podman_alive(script_name):
            ports = podman_ports(script_name)
    else:
        with _processes_lock:
            proc = processes.get(script_name)
            alive = proc is not None and not isinstance(proc, tuple) and proc.poll() is None
            pid = proc.pid if alive else None
        ports = _ports_for_pids(_tree_pids(pid), _conns) if alive else []
    _ports_cache[script_name] = (now, ports)
    return ports


def get_runtime(name):
    with _runtime_lock:
        r = dict(_runtime.get(name, {}))
    uptime = 0
    if backend_running(name) and r.get("start_ts"):
        uptime = int(time.time() - r["start_ts"])
    return {"uptime_s": uptime, "restarts": r.get("restarts", 0),
            "last_exit": r.get("last_exit"), "last_code": r.get("last_code")}


# ── Files ────────────────────────────────────────────────────────────────
def list_files_recursive(base_dir, prefix=""):
    results = []
    skip = {VENV_DIR_NAME, "__pycache__", ".git", ".venv"}
    try:
        with os.scandir(base_dir) as it:
            entries = sorted(it, key=lambda e: (not e.is_dir(follow_symlinks=False), e.name))
        for entry in entries:
            if entry.name in skip or entry.name.startswith("."):
                continue
            rel = os.path.join(prefix, entry.name) if prefix else entry.name
            try:
                if entry.is_symlink():
                    continue
                if entry.is_file(follow_symlinks=False):
                    results.append({"path": rel, "type": "file"})
                elif entry.is_dir(follow_symlinks=False):
                    results.append({"path": rel, "type": "directory"})
                    results.extend(list_files_recursive(entry.path, rel))
                    if len(results) > 5000:
                        break
            except OSError:
                continue
    except OSError:
        pass
    return results


def safe_path(script_name, filename):
    if not valid_name(script_name):
        return None
    scripts_real = os.path.realpath(SCRIPTS_DIR)
    base = os.path.realpath(os.path.join(scripts_real, script_name))
    if base != os.path.join(scripts_real, script_name) and not base.startswith(scripts_real + os.sep):
        return None
    if not base.startswith(scripts_real + os.sep) and base != scripts_real:
        return None
    target = os.path.realpath(os.path.join(base, filename or ""))
    if target != base and not target.startswith(base + os.sep):
        return None
    rel = os.path.relpath(target, base)
    if rel.startswith(BLOCKED_PREFIXES) or rel in (VENV_DIR_NAME, "__pycache__", ".git"):
        return None
    return target


# ═══════════════════════════════════════════════════════════════════════════
#  FastAPI app
# ═══════════════════════════════════════════════════════════════════════════
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "build")

from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(_: FastAPI):
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(SCRIPTS_DIR, exist_ok=True)
    if os.geteuid() == 0:
        # Manager-only state: apps (runner) must not read schedules/meta.
        try:
            os.chmod(DATA_DIR, 0o700)
        except OSError:
            pass
    load_schedules()
    load_meta()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    start_persisted_scripts()
    if EXEC_BACKEND in ("auto", "podman"):
        threading.Thread(target=podman_ensure_base, daemon=True).start()
    yield

app = FastAPI(title="pyRunner", docs_url=None, redoc_url=None, openapi_url=None,
              lifespan=_lifespan)


@app.exception_handler(HTTPException)
async def _http_exc(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(RequestValidationError)
async def _val_exc(request: Request, exc: RequestValidationError):
    try:
        first = exc.errors()[0]
        loc = ".".join(str(x) for x in first.get("loc", []) if x != "body")
        msg = "%s: %s" % (loc, first.get("msg", "invalid")) if loc else str(first.get("msg", "invalid"))
    except Exception:
        msg = "invalid request"
    return JSONResponse(status_code=400, content={"error": msg})


@app.middleware("http")
async def _middleware(request: Request, call_next):
    # Upload size guard
    if request.url.path.startswith("/api/"):
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > MAX_UPLOAD_BYTES + 1024 * 1024:
            return JSONResponse(status_code=413, content={"error": "Request too large"})
        # Rate limit (skip healthz)
        if request.url.path != "/api/healthz":
            ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
            now = time.monotonic()
            with _hits_lock:
                dq = _hits[ip]
                while dq and now - dq[0] > 60:
                    dq.popleft()
                dq.append(now)
                if len(dq) > RATE_LIMIT_PER_MIN:
                    return JSONResponse(status_code=429, content={"error": "rate limited"})
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Content-Security-Policy",
                            "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com")
    return resp


def need_auth(request: Request):
    if API_TOKEN:
        sent = request.headers.get("x-api-token", "")
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            sent = sent or auth[7:]
        if not sent or not hmac.compare_digest(sent, API_TOKEN):
            err(401, "unauthorized")


def need_name(name: str):
    if not valid_name(name):
        err(400, "Invalid name")
    return name


# ── Models ───────────────────────────────────────────────────────────────
class CreateScript(BaseModel):
    name: str
    app_type: str = "job"
    python_content: str = ""
    requirements_content: str = ""


class UpdateMeta(BaseModel):
    app_type: Optional[str] = None
    entry: Optional[str] = None
    port: Optional[int] = None


class FileContent(BaseModel):
    content: str


class MkdirBody(BaseModel):
    path: str


class ScheduleIn(BaseModel):
    action: Optional[str] = None
    time: Optional[str] = None
    days: Optional[list] = None
    delay_seconds: Optional[int] = None
    duration_seconds: Optional[int] = None
    enabled: Optional[bool] = None
    label: Optional[str] = None


# ── Routes ───────────────────────────────────────────────────────────────
@app.get("/api/healthz")
def api_healthz():
    return {"ok": True, "backend": EXEC_BACKEND, "podman": podman_available()}


@app.get("/api/summary")
def api_summary(_: None = Depends(need_auth)):
    try:
        scripts = [d for d in os.listdir(SCRIPTS_DIR)
                   if valid_name(d) and os.path.isdir(os.path.join(SCRIPTS_DIR, d))]
    except OSError:
        scripts = []
    total_cpu = total_ram = 0.0
    running = 0
    for s in scripts:
        st = get_stats(s)
        total_cpu += st.get("cpu", 0.0)
        total_ram += st.get("ram", 0.0)
        if get_status(s) == "running":
            running += 1
    try:
        host_cpu = psutil.cpu_percent(interval=None)
        host_mem = psutil.virtual_memory()
        host = {"cpu_pct": host_cpu, "mem_pct": host_mem.percent,
                "mem_used_mb": round(host_mem.used / 1048576, 1),
                "mem_total_mb": round(host_mem.total / 1048576, 1)}
    except Exception:
        host = {}
    return {"scripts_total": len(scripts), "scripts_running": running,
            "apps_cpu": round(total_cpu, 1), "apps_ram_mb": round(total_ram, 1),
            "host": host, "ports": {"start": PORT_START, "end": PORT_END}}


@app.get("/api/scripts")
def api_list_scripts(_: None = Depends(need_auth)):
    if not os.path.exists(SCRIPTS_DIR):
        return []
    try:
        scripts = sorted(d for d in os.listdir(SCRIPTS_DIR)
                         if valid_name(d) and os.path.isdir(os.path.join(SCRIPTS_DIR, d)))
    except OSError:
        return []
    try:
        conns = psutil.net_connections(kind="inet")
    except Exception:
        conns = []
    return [{"name": s, "status": get_status(s), "ports": get_ports(s, _conns=conns),
             "stats": get_stats(s), "meta": get_meta(s), "runtime": get_runtime(s)}
            for s in scripts]


@app.post("/api/scripts")
def api_create_script(body: CreateScript, _: None = Depends(need_auth)):
    name = body.name.strip().replace(" ", "_")
    if not valid_name(name):
        err(400, "Invalid name (use A-Z a-z 0-9 _ -, max 64)")
    app_type = (body.app_type or "job").lower()
    if app_type not in ("service", "job"):
        app_type = "job"
    py_content = body.python_content or ("# %s\n\nprint('Hello!')\n" % name)
    if len(py_content) > 500_000 or len(body.requirements_content or "") > 200_000:
        err(413, "Content too large")
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if os.path.exists(script_dir):
        err(409, "Script '%s' already exists" % name)
    os.makedirs(script_dir, exist_ok=True)
    try:
        with open(os.path.join(script_dir, "main.py"), "w") as f:
            f.write(py_content)
        with open(os.path.join(script_dir, "requirements.txt"), "w") as f:
            f.write(body.requirements_content or "")
    except OSError as e:
        err(500, str(e))
    port = allocate_port(exclude_name=name)
    set_meta(name, {"app_type": app_type, "port": port, "entry": "main.py"})
    _chown_runner(script_dir)
    return {"status": "created", "name": name, "meta": get_meta(name)}


@app.post("/api/scripts/{name}/start")
def api_start(name: str, _: None = Depends(need_auth)):
    need_name(name)
    run_script(name)
    return {"status": "starting"}


@app.post("/api/scripts/{name}/stop")
def api_stop(name: str, _: None = Depends(need_auth)):
    need_name(name)
    stop_script(name)
    return {"status": "stopped"}


@app.post("/api/scripts/{name}/restart")
def api_restart(name: str, _: None = Depends(need_auth)):
    need_name(name)
    stop_script(name)
    time.sleep(1)
    run_script(name)
    return {"status": "restarting"}


@app.get("/api/scripts/{name}/meta")
def api_get_meta(name: str, _: None = Depends(need_auth)):
    need_name(name)
    return get_meta(name)


@app.put("/api/scripts/{name}/meta")
def api_put_meta(name: str, body: UpdateMeta, _: None = Depends(need_auth)):
    need_name(name)
    patch = {}
    if body.app_type is not None:
        if body.app_type not in ("service", "job"):
            err(400, "app_type must be service|job")
        patch["app_type"] = body.app_type
    if body.entry is not None:
        entry = str(body.entry)[:120]
        if "/" in entry or "\\" in entry or not entry.endswith(".py"):
            err(400, "entry must be a .py filename")
        script_path = os.path.join(SCRIPTS_DIR, name)
        if os.path.isdir(script_path) and not os.path.exists(os.path.join(script_path, entry)):
            err(400, "entry file does not exist")
        patch["entry"] = entry
    if body.port is not None:
        p = body.port
        if not (PORT_START <= p <= PORT_END):
            err(400, "port must be %d..%d" % (PORT_START, PORT_END))
        with _meta_lock:
            for n, m in _meta.items():
                if n != name and isinstance(m, dict) and m.get("port") == p:
                    err(409, "port already assigned to %s" % n)
        patch["port"] = p
    return set_meta(name, patch)


@app.get("/api/scripts/{name}/health")
def api_health(name: str, _: None = Depends(need_auth)):
    need_name(name)
    status_file = os.path.join(SCRIPTS_DIR, name, "health.json")
    if os.path.exists(status_file):
        try:
            if os.path.getsize(status_file) > 1024 * 1024:
                return {"healthy": False, "error": "health.json too large"}
            with open(status_file) as f:
                return json.load(f)
        except Exception:
            return {"healthy": False, "error": "invalid health.json"}
    return {"healthy": get_status(name) == "running"}


@app.get("/api/scripts/{name}/logs")
def api_logs(name: str, _: None = Depends(need_auth)):
    need_name(name)
    with log_locks[name]:
        lines = list(log_buffers[name])
    return {"logs": lines}


@app.delete("/api/scripts/{name}/logs")
def api_clear_logs(name: str, _: None = Depends(need_auth)):
    need_name(name)
    with log_locks[name]:
        log_buffers[name].clear()
    return {"status": "cleared"}


@app.post("/api/scripts/{name}/upload")
async def api_upload(name: str, file: UploadFile = FastFile(...), _: None = Depends(need_auth)):
    need_name(name)
    script_dir = os.path.join(SCRIPTS_DIR, name)
    os.makedirs(script_dir, exist_ok=True)
    filename = os.path.basename(file.filename or "")
    if not filename or filename in (".", ".."):
        err(400, "Invalid filename")
    dest = safe_path(name, filename)
    if not dest:
        err(400, "Invalid path")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        data = await file.read(MAX_UPLOAD_BYTES * 5 + 2)
        if len(data) > MAX_UPLOAD_BYTES * 5:
            err(413, "File too large")
        with open(dest, "wb") as f:
            f.write(data)
    except HTTPException:
        raise
    except Exception as e:
        err(500, str(e))
    _chown_runner(dest)
    return {"status": "uploaded", "filename": filename}


@app.get("/api/scripts/{name}/files")
def api_list_files(name: str, _: None = Depends(need_auth)):
    need_name(name)
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if not os.path.exists(script_dir):
        return {"files": []}
    return {"files": list_files_recursive(script_dir)}


@app.get("/api/scripts/{name}/files/{filename:path}")
def api_get_file(name: str, filename: str, _: None = Depends(need_auth)):
    dest = safe_path(name, filename)
    if not dest or not os.path.isfile(dest):
        err(404, "Not found")
    try:
        if os.path.getsize(dest) > MAX_FILE_BYTES:
            err(413, "File too large to edit (use upload/download)")
        with open(dest, "r", errors="replace") as f:
            content = f.read(MAX_FILE_BYTES + 1)
    except OSError as e:
        err(500, str(e))
    if len(content) > MAX_FILE_BYTES:
        err(413, "File too large")
    return {"filename": filename, "content": content}


@app.put("/api/scripts/{name}/files/{filename:path}")
def api_save_file(name: str, filename: str, body: FileContent, _: None = Depends(need_auth)):
    dest = safe_path(name, filename)
    if not dest:
        err(400, "Invalid path")
    if not isinstance(body.content, str) or len(body.content) > MAX_FILE_BYTES:
        err(413, "Content too large")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        tmp = dest + ".tmp"
        with open(tmp, "w") as f:
            f.write(body.content)
        os.replace(tmp, dest)
        _chown_runner(dest)
        if name in _req_hash and os.path.basename(dest) == "requirements.txt":
            _req_hash.pop(name, None)
    except OSError as e:
        err(500, str(e))
    return {"status": "saved"}


@app.delete("/api/scripts/{name}/files/{filename:path}")
def api_delete_file(name: str, filename: str, _: None = Depends(need_auth)):
    dest = safe_path(name, filename)
    scripts_real = os.path.realpath(SCRIPTS_DIR)
    base = os.path.realpath(os.path.join(scripts_real, name))
    if not dest or dest == base:
        err(404, "Not found")
    if not os.path.exists(dest) and not os.path.islink(dest):
        err(404, "Not found")
    try:
        if os.path.isdir(dest) and not os.path.islink(dest):
            shutil.rmtree(dest)
        else:
            os.remove(dest)
        return {"status": "deleted"}
    except Exception as e:
        err(500, str(e))


@app.post("/api/scripts/{name}/mkdir")
def api_mkdir(name: str, body: MkdirBody, _: None = Depends(need_auth)):
    dest = safe_path(name, str(body.path))
    if not dest:
        err(400, "Invalid path")
    os.makedirs(dest, exist_ok=True)
    _chown_runner(dest)
    return {"status": "created"}


@app.delete("/api/scripts/{name}")
def api_delete_script(name: str, _: None = Depends(need_auth)):
    need_name(name)
    stop_script(name)
    script_dir = os.path.join(SCRIPTS_DIR, name)
    if os.path.isdir(script_dir) and os.path.realpath(script_dir).startswith(
            os.path.realpath(SCRIPTS_DIR) + os.sep):
        shutil.rmtree(script_dir)
    with _schedules_lock:
        _schedules.pop(name, None)
    save_schedules()
    with _meta_lock:
        _meta.pop(name, None)
    atomic_write_json(META_FILE, _meta)
    with log_locks[name]:
        log_buffers.pop(name, None)
    _req_hash.pop(name, None)
    with _runtime_lock:
        _runtime.pop(name, None)
    return {"status": "deleted"}


@app.get("/api/scripts/{name}/schedules")
def api_get_schedules(name: str, _: None = Depends(need_auth)):
    need_name(name)
    with _schedules_lock:
        return list(_schedules.get(name, []))


@app.post("/api/scripts/{name}/schedules")
def api_add_schedule(name: str, body: ScheduleIn, _: None = Depends(need_auth)):
    need_name(name)
    sched, serr = validate_schedule({k: v for k, v in body.model_dump().items() if v is not None})
    if serr:
        err(400, serr)
    sched["id"] = _uuid_mod.uuid4().hex[:8]
    with _schedules_lock:
        _schedules.setdefault(name, []).append(sched)
    save_schedules()
    return sched


@app.put("/api/scripts/{name}/schedules/{sid}")
def api_update_schedule(name: str, sid: str, body: ScheduleIn, _: None = Depends(need_auth)):
    need_name(name)
    if not SID_RE.match(sid or ""):
        err(400, "Invalid id")
    with _schedules_lock:
        scheds = _schedules.get(name, [])
        for i, s in enumerate(scheds):
            if isinstance(s, dict) and s.get("id") == sid:
                base = dict(s)
                incoming = {k: v for k, v in body.model_dump().items() if v is not None}
                base.update(incoming)
                updated, uerr = validate_schedule(base)
                if uerr:
                    err(400, uerr)
                updated["id"] = sid
                scheds[i] = updated
                result = dict(updated)
                break
        else:
            err(404, "Not found")
    save_schedules()
    return result


@app.delete("/api/scripts/{name}/schedules/{sid}")
def api_delete_schedule(name: str, sid: str, _: None = Depends(need_auth)):
    need_name(name)
    with _schedules_lock:
        scheds = _schedules.get(name, [])
        _schedules[name] = [s for s in scheds if not (isinstance(s, dict) and s.get("id") == sid)]
    save_schedules()
    return {"status": "deleted"}


# ── Frontend (static build + SPA fallback; /api/* never falls through) ────
if os.path.isdir(STATIC_DIR):
    _assets = os.path.join(STATIC_DIR, "assets")
    if os.path.isdir(_assets):
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")


@app.get("/", include_in_schema=False)
@app.get("/{path:path}", include_in_schema=False)
def serve_frontend(path: str = ""):
    if path.startswith("api/"):
        err(404, "Not found")
    if path:
        cand = os.path.realpath(os.path.join(STATIC_DIR, path))
        if cand.startswith(os.path.realpath(STATIC_DIR) + os.sep) and os.path.isfile(cand):
            return FileResponse(cand)
    index = os.path.join(STATIC_DIR, "index.html")
    if not os.path.exists(index):
        err(500, "frontend not built")
    return FileResponse(index)


def start_persisted_scripts():
    for s in load_running_state():
        if valid_name(s) and os.path.isdir(os.path.join(SCRIPTS_DIR, s)):
            m = get_meta(s)
            if not m.get("port"):
                try:
                    set_meta(s, {"port": allocate_port(exclude_name=s)})
                except Exception:
                    pass
            get_stop_event(s).clear()
            run_script(s)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
