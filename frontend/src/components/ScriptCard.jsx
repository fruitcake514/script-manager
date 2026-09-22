import { useState, useEffect, useRef } from "react";
import FileEditor from "./FileEditor";
import UploadModal from "./UploadModal";
import NewFileModal from "./NewFileModal";
import SchedulerModal from "./SchedulerModal";
import FileManager from "./FileManager";
import { apiFetch, apiJson, encName, encPath } from "../api";

function LogLine({ line }) {
  const l = line.toLowerCase();
  let color = "#8a9aaa";
  if (l.includes("[manager]")) color = "#4a9eff";
  else if (l.includes("critical") || l.includes("fatal")) color = "#ff4444";
  else if (l.includes("error") || l.includes("traceback") || l.includes("exception") || l.includes("exit 1"))
    color = "#ff6b6b";
  else if (l.includes("warn")) color = "#fbbf24";
  else if (l.includes("debug")) color = "#a78bfa";
  else if (l.includes("info") || l.includes("starting") || l.includes("started") || l.includes("ready"))
    color = "#34d399";
  else if (l.includes("success") || l.includes("ok") || l.includes("done") || l.includes("complete"))
    color = "#34d399";
  return <span style={{ color, whiteSpace: "pre-wrap", wordBreak: "break-all", display: "block" }}>{line}</span>;
}

function fmtUptime(s) {
  if (!s) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function ScriptCard({ script, refresh }) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState("logs");
  const [logs, setLogs] = useState([]);
  const [files, setFiles] = useState([]);
  const [editingFile, setEditingFile] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showNewFile, setShowNewFile] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);
  const logsRef = useRef(null);
  const logPollRef = useRef(null);

  const isRunning = script.status === "running";
  const meta = script.meta || {};
  const runtime = script.runtime || {};
  const n = encName(script.name);

  useEffect(() => {
    if (expanded && tab === "logs") {
      fetchLogs();
      logPollRef.current = setInterval(fetchLogs, 3000);
    }
    return () => clearInterval(logPollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, tab, script.name]);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  const fetchLogs = async () => {
    try {
      const data = await apiJson(`/api/scripts/${n}/logs`);
      setLogs(data.logs || []);
    } catch { /* keep old logs on transient error */ }
  };

  const fetchFiles = async () => {
    try {
      const data = await apiJson(`/api/scripts/${n}/files`);
      setFiles(data.files || []);
    } catch { setFiles([]); }
  };

  const handleTabChange = (t) => {
    setTab(t);
    if (t === "files") fetchFiles();
  };

  const notify = (msg) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 2000);
  };

  const action = async (endpoint) => {
    try {
      await apiFetch(`/api/scripts/${n}/${endpoint}`, { method: "POST" });
    } catch (e) { notify(e.message); }
    setTimeout(refresh, 800);
  };

  const toggleType = async () => {
    const next = (meta.app_type === "service" ? "job" : "service");
    try {
      await apiJson(`/api/scripts/${n}/meta`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_type: next }),
      });
      notify(`Type → ${next} (restart to apply)`);
      refresh();
    } catch (e) { notify(e.message); }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    await apiFetch(`/api/scripts/${n}`, { method: "DELETE" });
    refresh();
  };

  const clearLogs = async () => {
    await apiFetch(`/api/scripts/${n}/logs`, { method: "DELETE" });
    setLogs([]);
  };

  const toggleExpand = () => {
    setExpanded((e) => {
      if (!e && tab === "files") fetchFiles();
      return !e;
    });
  };

  return (
    <div style={s.card}>
      <div style={s.header} onClick={toggleExpand}>
        <div style={s.headerLeft}>
          <span style={{ ...s.dot, background: isRunning ? "#22c55e" : "#ef4444", boxShadow: isRunning ? "0 0 8px #22c55e88" : "none" }} />
          <span style={s.name}>{script.name}</span>
          <button
            style={{ ...s.typeBadge, ...(meta.app_type === "service" ? s.typeService : s.typeJob) }}
            onClick={(e) => { e.stopPropagation(); toggleType(); }}
            title="Click to toggle service/job. Services restart always + no CPU cap + $PORT. Jobs stop on clean exit + CPU cap + max 5 crash retries."
          >
            {meta.app_type === "service" ? "service" : "job"}
          </button>
          {meta.port && <span style={s.portBadge} title="Assigned $PORT">:{meta.port}</span>}
          {script.ports && script.ports.filter((p) => p !== meta.port).map((p) => (
            <span key={p} style={s.livePort} title="Live listener">:{p} live</span>
          ))}
          <span style={{ ...s.statusBadge, color: isRunning ? "#22c55e" : "#f87171", borderColor: isRunning ? "#14532d" : "#450a0a", background: isRunning ? "#0a260a" : "#260a0a" }}>
            {script.status}
          </span>
          {isRunning && script.stats && (
            <div style={s.statsBox}>
              <span style={s.statItem}>CPU {script.stats.cpu}%</span>
              <span style={s.statItem}>RAM {script.stats.ram} MB</span>
              <span style={s.statItem}>up {fmtUptime(runtime.uptime_s)}</span>
              {runtime.restarts > 0 && <span style={s.statItem}>↺ {runtime.restarts}</span>}
            </div>
          )}
          {!isRunning && runtime.last_exit && (
            <span style={s.metaHint}>last exit {runtime.last_exit} ({String(runtime.last_code)})</span>
          )}
        </div>

        <div style={s.headerRight} onClick={(e) => e.stopPropagation()}>
          {actionMsg && <span style={s.actionMsg}>{actionMsg}</span>}
          {!isRunning && (
            <button style={s.btnGreen} onClick={() => { action("start"); notify("Starting…"); }}>▶ Start</button>
          )}
          {isRunning && (
            <>
              <button style={s.btnOrange} onClick={() => { action("restart"); notify("Restarting…"); }}>↺ Restart</button>
              <button style={s.btnRed} onClick={() => { action("stop"); notify("Stopping…"); }}>■ Stop</button>
            </>
          )}
          <button style={s.btnIcon} onClick={() => setShowScheduler(true)} title="Schedules">🕐</button>
          <button
            style={s.btnIcon}
            onClick={() => { action("rebuild-venv"); notify("Rebuilding venv…"); }}
            title="Delete the venv and reinstall from requirements.txt (fixes broken native packages after base-image upgrades)"
          >
            ⟳ venv
          </button>
          <button
            style={{ ...s.btnIcon, color: confirmDelete ? "#ff4444" : "#6b7280", borderColor: confirmDelete ? "#ff4444" : "#2a2a2a" }}
            onClick={handleDelete}
            title={confirmDelete ? "Click again to confirm delete" : "Delete script"}
          >
            {confirmDelete ? "⚠ Confirm" : "🗑"}
          </button>
          <button style={s.btnIcon} onClick={toggleExpand}>{expanded ? "▲" : "▼"}</button>
        </div>
      </div>

      {expanded && (
        <div style={s.panel}>
          <div style={s.metaBar}>
            <span style={s.metaHint}>entry: <code>{meta.entry || "auto"}</code></span>
            <span style={s.metaHint}>$PORT=<code>{meta.port ?? "—"}</code> (use <code>os.environ.get("PORT")</code> in Flask)</span>
          </div>
          <div style={s.tabBar}>
            {["logs", "files"].map((t) => (
              <button key={t} style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }} onClick={() => handleTabChange(t)}>
                {t === "logs" ? "📋 Logs" : "📁 Files"}
              </button>
            ))}
            {tab === "logs" && (
              <button style={{ ...s.tab, marginLeft: "auto", color: "#6b7280" }} onClick={clearLogs}>Clear</button>
            )}
            {tab === "files" && (
              <>
                <button style={{ ...s.tab, marginLeft: "auto", color: "#6b7280" }} onClick={() => setShowNewFile(true)}>+ New File</button>
                <button style={{ ...s.tab, color: "#6b7280" }} onClick={() => setShowUpload(true)}>↑ Upload</button>
              </>
            )}
          </div>

          {tab === "logs" && (
            <div ref={logsRef} style={s.logBox}>
              {logs.length === 0 ? (
                <span style={{ color: "#555", fontSize: 12 }}>No logs yet.</span>
              ) : (
                logs.map((line, i) => <LogLine key={i} line={line} />)
              )}
            </div>
          )}

          {tab === "files" && (
            <FileManager
              files={files}
              scriptName={script.name}
              onEditFile={(path) => setEditingFile(path)}
              onDeleteFile={() => fetchFiles()}
              onRefresh={fetchFiles}
            />
          )}
        </div>
      )}

      {editingFile && (
        <FileEditor scriptName={script.name} filename={editingFile}
          onClose={() => { setEditingFile(null); fetchFiles(); }} />
      )}
      {showUpload && (
        <UploadModal scriptName={script.name}
          onClose={() => { setShowUpload(false); fetchFiles(); }} />
      )}
      {showScheduler && <SchedulerModal scriptName={script.name} onClose={() => setShowScheduler(false)} />}
      {showNewFile && (
        <NewFileModal scriptName={script.name}
          onClose={() => { setShowNewFile(false); fetchFiles(); }} />
      )}
    </div>
  );
}

const s = {
  card: { background: "#161616", border: "1px solid #222", borderRadius: 10, overflow: "hidden" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", cursor: "pointer", userSelect: "none", background: "#1a1a1a" },
  headerLeft: { display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" },
  dot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  name: { fontWeight: 700, fontSize: 15, color: "#eee", letterSpacing: "-0.3px" },
  statusBadge: { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", border: "1px solid", borderRadius: 4, padding: "2px 7px" },
  typeBadge: { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", border: "1px solid #333", borderRadius: 4, padding: "2px 7px", cursor: "pointer", fontFamily: "inherit" },
  typeService: { color: "#93c5fd", borderColor: "#1a3a5c", background: "#0d1f35" },
  typeJob: { color: "#fcd34d", borderColor: "#575043", background: "#221d08" },
  portBadge: { fontSize: 11, color: "#fff", background: "#1a6ef5", fontWeight: 700, border: "1px solid #1a6ef5", padding: "2px 8px", borderRadius: 4 },
  livePort: { fontSize: 11, color: "#86efac", background: "#0a260a", fontWeight: 700, border: "1px solid #14532d", padding: "2px 8px", borderRadius: 4 },
  metaHint: { fontSize: 11, color: "#666" },
  statsBox: { display: "flex", gap: 8, marginLeft: 4 },
  statItem: { fontSize: 11, color: "#aaa", background: "#1a1a1a", padding: "2px 6px", borderRadius: 3, border: "1px solid #2a2a2a" },
  headerRight: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  actionMsg: { fontSize: 12, color: "#4a9eff" },
  btnGreen: { padding: "6px 14px", background: "#14532d", color: "#86efac", border: "1px solid #166534", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 },
  btnRed: { padding: "6px 14px", background: "#450a0a", color: "#fca5a5", border: "1px solid #7f1d1d", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 },
  btnOrange: { padding: "6px 14px", background: "#431407", color: "#fdba74", border: "1px solid #7c2d12", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 },
  btnIcon: { padding: "6px 10px", background: "transparent", border: "1px solid #2a2a2a", color: "#aaa", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  panel: { borderTop: "1px solid #222" },
  metaBar: { display: "flex", gap: 16, padding: "8px 18px", background: "#131313", borderBottom: "1px solid #1c1c1c", fontSize: 11, color: "#777" },
  tabBar: { display: "flex", borderBottom: "1px solid #222", padding: "0 14px", background: "#141414" },
  tab: { padding: "9px 16px", background: "transparent", border: "none", borderBottom: "2px solid transparent", color: "#6b7280", cursor: "pointer", fontSize: 13, fontFamily: "inherit" },
  tabActive: { color: "#e0e0e0", borderBottomColor: "#4a9eff" },
  logBox: { background: "#0c0c0c", padding: "12px 16px", height: 260, overflowY: "auto", display: "flex", flexDirection: "column", fontFamily: "inherit", fontSize: 12, lineHeight: 1.7 },
};
