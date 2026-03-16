import { useState, useEffect, useRef } from "react";
import FileEditor from "./FileEditor";
import UploadModal from "./UploadModal";
import NewFileModal from "./NewFileModal";
import SchedulerModal from "./SchedulerModal";

// ── Log line colorizer ────────────────────────────────────────────────────────
function LogLine({ line }) {
  const l = line.toLowerCase();
  let color = "#7a8a9a"; // default grey
  if (l.includes("[manager]"))                                  color = "#4a9eff";
  else if (l.includes("critical") || l.includes("fatal"))       color = "#ff4444";
  else if (l.includes("error") || l.includes("traceback") ||
           l.includes("exception") || l.includes("exit 1"))     color = "#ff6b6b";
  else if (l.includes("warn"))                                   color = "#fbbf24";
  else if (l.includes("debug"))                                  color = "#a78bfa";
  else if (l.includes("info") || l.includes("starting") ||
           l.includes("started") || l.includes("ready"))        color = "#34d399";
  else if (l.includes("success") || l.includes("ok") ||
           l.includes("done") || l.includes("complete"))        color = "#34d399";

  return <span style={{ color, whiteSpace: "pre-wrap", wordBreak: "break-all", display: "block" }}>{line}</span>;
}

// ── File tree helpers ─────────────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = [
  ".py", ".txt", ".json", ".yaml", ".yml", ".env", ".cfg", ".ini",
  ".sh", ".md", ".toml", ".js", ".ts", ".html", ".css", ".xml", ".csv", ".log"
];

function isEditable(filename) {
  return ALLOWED_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

export default function ScriptCard({ script, refresh }) {
  const [expanded, setExpanded]       = useState(false);
  const [tab, setTab]                 = useState("logs");
  const [logs, setLogs]               = useState([]);
  const [files, setFiles]             = useState([]);
  const [editingFile, setEditingFile] = useState(null);
  const [showUpload, setShowUpload]   = useState(false);
  const [showNewFile, setShowNewFile] = useState(false);
  const [actionMsg, setActionMsg]     = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);
  const logsRef    = useRef(null);
  const logPollRef = useRef(null);

  const isRunning = script.status === "running";

  useEffect(() => {
    if (expanded && tab === "logs") {
      fetchLogs();
      logPollRef.current = setInterval(fetchLogs, 2000);
    }
    return () => clearInterval(logPollRef.current);
  }, [expanded, tab]);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  const fetchLogs = async () => {
    const res = await fetch(`/api/scripts/${script.name}/logs`);
    const data = await res.json();
    setLogs(data.logs || []);
  };

  const fetchFiles = async () => {
    const res = await fetch(`/api/scripts/${script.name}/files`);
    const data = await res.json();
    setFiles(data.files || []);
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
    await fetch(`/api/scripts/${script.name}/${endpoint}`, { method: "POST" });
    setTimeout(refresh, 600);
  };

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 3000); return; }
    await fetch(`/api/scripts/${script.name}`, { method: "DELETE" });
    refresh();
  };

  const clearLogs = async () => {
    await fetch(`/api/scripts/${script.name}/logs`, { method: "DELETE" });
    setLogs([]);
  };

  const toggleExpand = () => {
    setExpanded(e => {
      if (!e && tab === "files") fetchFiles();
      return !e;
    });
  };

  return (
    <div style={s.card}>
      {/* ── Header ── */}
      <div style={s.header} onClick={toggleExpand}>
        <div style={s.headerLeft}>
          <span style={{ ...s.dot, background: isRunning ? "#22c55e" : "#ef4444",
            boxShadow: isRunning ? "0 0 6px #22c55e" : "none" }} />
          <span style={s.name}>{script.name}</span>
          {script.ports && script.ports.length > 0 && script.ports.map(p => (
            <span key={p} style={s.portBadge}>:{p}</span>
          ))}
          <span style={{ ...s.statusBadge, color: isRunning ? "#22c55e" : "#ef4444",
            borderColor: isRunning ? "#14532d" : "#450a0a" }}>
            {script.status}
          </span>
          {isRunning && script.stats && (
            <div style={s.statsBox}>
              <span style={s.statItem}>CPU: {script.stats.cpu}%</span>
              <span style={s.statItem}>RAM: {script.stats.ram} MB</span>
            </div>
          )}
        </div>

        <div style={s.headerRight} onClick={e => e.stopPropagation()}>
          {actionMsg && <span style={s.actionMsg}>{actionMsg}</span>}
          {!isRunning &&
            <button style={s.btnGreen} onClick={() => { action("start"); notify("Starting…"); }}>
              ▶ Start
            </button>
          }
          {isRunning && <>
            <button style={s.btnOrange} onClick={() => { action("restart"); notify("Restarting…"); }}>
              ↺ Restart
            </button>
            <button style={s.btnRed} onClick={() => { action("stop"); notify("Stopping…"); }}>
              ■ Stop
            </button>
          </>}
          <button style={s.btnIcon} onClick={() => setShowScheduler(true)} title="Schedules">
            🕐
          </button>
          <button
            style={{ ...s.btnIcon, color: confirmDelete ? "#ff4444" : "#6b7280",
              borderColor: confirmDelete ? "#ff4444" : "#2a2a2a" }}
            onClick={handleDelete}
            title={confirmDelete ? "Click again to confirm delete" : "Delete script"}
          >
            {confirmDelete ? "⚠ Confirm" : "🗑"}
          </button>
          <button style={s.btnIcon} onClick={toggleExpand}>{expanded ? "▲" : "▼"}</button>
        </div>
      </div>

      {/* ── Expanded panel ── */}
      {expanded && (
        <div style={s.panel}>
          <div style={s.tabBar}>
            {["logs", "files"].map(t => (
              <button key={t} style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
                onClick={() => handleTabChange(t)}>
                {t === "logs" ? "📋 Logs" : "📁 Files"}
              </button>
            ))}
            {tab === "logs" &&
              <button style={{ ...s.tab, marginLeft: "auto", color: "#6b7280" }} onClick={clearLogs}>
                Clear
              </button>
            }
            {tab === "files" && <>
              <button style={{ ...s.tab, marginLeft: "auto", color: "#6b7280" }}
                onClick={() => setShowNewFile(true)}>+ New File</button>
              <button style={{ ...s.tab, color: "#6b7280" }}
                onClick={() => setShowUpload(true)}>↑ Upload</button>
            </>}
          </div>

          {/* Logs */}
          {tab === "logs" && (
            <div ref={logsRef} style={s.logBox}>
              {logs.length === 0
                ? <span style={{ color: "#2a2a2a", fontSize: 12 }}>No logs yet.</span>
                : logs.map((line, i) => <LogLine key={i} line={line} />)
              }
            </div>
          )}

          {/* Files */}
          {tab === "files" && (
            <div style={s.fileList}>
              {files.length === 0
                ? <span style={{ color: "#a0a0a0", fontSize: 12 }}>No files found.</span>
                : files.map(f => (
                  <div key={f.path} style={s.fileRow}>
                    <span style={s.fileIcon}>{f.type === "directory" ? "📁" : getFileIcon(f.path)}</span>
                    <span style={{...s.fileName, fontWeight: f.type === "directory" ? 700 : 400}}>{f.path}</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      {f.type === "file" && (
                        isEditable(f.path)
                          ? <button style={s.editBtn} onClick={() => setEditingFile(f.path)}>Edit</button>
                          : <span style={s.noEdit}>binary</span>
                      )}
                      <button style={s.delFileBtn} onClick={async () => {
                        if (confirm(`Delete ${f.type} "${f.path}"?`)) {
                          await fetch(`/api/scripts/${script.name}/files/${f.path}`, { method: "DELETE" });
                          fetchFiles();
                        }
                      }}>🗑</button>
                    </div>
                  </div>
                ))
              }
            </div>
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
      {showScheduler && (
        <SchedulerModal scriptName={script.name} onClose={() => setShowScheduler(false)} />
      )}
      {showNewFile && (
        <NewFileModal scriptName={script.name}
          onClose={() => { setShowNewFile(false); fetchFiles(); }} />
      )}
    </div>
  );
}

function getFileIcon(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const icons = { py:"🐍", txt:"📄", json:"📋", yaml:"⚙️", yml:"⚙️",
    env:"🔑", sh:"⚡", md:"📝", toml:"⚙️", js:"🟨", ts:"🔷",
    html:"🌐", css:"🎨", log:"📜", csv:"📊", xml:"🏷️", cfg:"⚙️", ini:"⚙️" };
  return icons[ext] || "📄";
}

const s = {
  card: {
    background: "#141414",
    border: "1px solid #1e1e1e",
    borderRadius: 8,
    overflow: "hidden",
    transition: "border-color 0.15s",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "11px 16px", cursor: "pointer", userSelect: "none",
    background: "#161616",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" },
  dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  name: { fontWeight: 700, fontSize: 14, color: "#e8e8e8", letterSpacing: "-0.3px" },
  statusBadge: {
    fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
    border: "1px solid", borderRadius: 4, padding: "1px 6px",
  },
  portBadge: {
    fontSize: 11, color: "#fff", background: "#1a6ef5", fontWeight: 700,
    border: "1px solid #1a6ef5", padding: "1px 7px", borderRadius: 4,
  },
  statsBox: { display: "flex", gap: 8, marginLeft: 4 },
  statItem: { fontSize: 10, color: "#a0a0a0", background: "#1a1a1a", padding: "1px 5px", borderRadius: 3, border: "1px solid #2a2a2a" },
  headerRight: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  actionMsg: { fontSize: 11, color: "#4a9eff" },
  btnGreen:  { padding: "5px 12px", background: "#14532d", color: "#86efac", border: "1px solid #166534", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 },
  btnRed:    { padding: "5px 12px", background: "#450a0a", color: "#fca5a5", border: "1px solid #7f1d1d", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 },
  btnOrange: { padding: "5px 12px", background: "#431407", color: "#fdba74", border: "1px solid #7c2d12", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 },
  btnIcon:   { padding: "5px 9px", background: "transparent", border: "1px solid #2a2a2a", color: "#86efac", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  panel: { borderTop: "1px solid #1e1e1e" },
  tabBar: { display: "flex", borderBottom: "1px solid #1e1e1e", padding: "0 12px", background: "#111" },
  tab: { padding: "8px 14px", background: "transparent", border: "none", borderBottom: "2px solid transparent", color: "#808080", cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  tabActive: { color: "#e0e0e0", borderBottomColor: "#4a9eff" },
  logBox: {
    background: "#0a0a0a", padding: "12px 16px", height: 240,
    overflowY: "auto", display: "flex", flexDirection: "column",
    fontFamily: "inherit", fontSize: 12, lineHeight: 1.65,
  },
  fileList: { padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4 },
  fileRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
    background: "#0f0f0f", borderRadius: 5, border: "1px solid #1a1a1a",
  },
  fileIcon: { fontSize: 14, flexShrink: 0 },
  fileName: { fontSize: 13, color: "#c0c0c0", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  editBtn:  { padding: "3px 10px", background: "#0d1f35", color: "#4a9eff", border: "1px solid #1a3a5c", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit" },
  delFileBtn: { padding: "3px 8px", background: "transparent", color: "#6b7280", border: "1px solid #2a2a2a", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit" },
  noEdit:   { fontSize: 10, color: "#808080", fontStyle: "italic" },
};
