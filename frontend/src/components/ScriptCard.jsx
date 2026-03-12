import { useState, useEffect, useRef } from "react";
import FileEditor from "./FileEditor";
import UploadModal from "./UploadModal";

export default function ScriptCard({ script, refresh }) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState("logs"); // "logs" | "files"
  const [logs, setLogs] = useState([]);
  const [files, setFiles] = useState([]);
  const [editingFile, setEditingFile] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const logsRef = useRef(null);
  const logPollRef = useRef(null);

  const isRunning = script.status === "running";

  // Poll logs when expanded & on logs tab
  useEffect(() => {
    if (expanded && tab === "logs") {
      fetchLogs();
      logPollRef.current = setInterval(fetchLogs, 2000);
    }
    return () => clearInterval(logPollRef.current);
  }, [expanded, tab]);

  // Auto-scroll logs
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
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

  const action = async (endpoint, method = "POST") => {
    await fetch(`/api/scripts/${script.name}/${endpoint}`, { method });
    refresh();
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete script "${script.name}"? This cannot be undone.`)) return;
    await fetch(`/api/scripts/${script.name}`, { method: "DELETE" });
    refresh();
  };

  const clearLogs = async () => {
    await fetch(`/api/scripts/${script.name}/logs`, { method: "DELETE" });
    setLogs([]);
  };

  const toggleExpand = () => {
    setExpanded((e) => {
      if (!e && tab === "files") fetchFiles();
      return !e;
    });
  };

  return (
    <div style={styles.card}>
      {/* Card Header */}
      <div style={styles.cardHeader} onClick={toggleExpand}>
        <div style={styles.headerLeft}>
          <span style={{ ...styles.dot, background: isRunning ? "#22c55e" : "#ef4444" }} />
          <span style={styles.scriptName}>{script.name}</span>
          <span style={{ ...styles.badge, color: isRunning ? "#22c55e" : "#ef4444" }}>
            {script.status}
          </span>
          {script.ports.length > 0 && (
            <span style={styles.portBadge}>:{script.ports.join(", :")}</span>
          )}
        </div>
        <div style={styles.headerRight} onClick={(e) => e.stopPropagation()}>
          {actionMsg && <span style={styles.actionMsg}>{actionMsg}</span>}
          {!isRunning && (
            <button style={styles.btnGreen} onClick={() => { action("start"); notify("Starting..."); }}>▶ Start</button>
          )}
          {isRunning && (
            <>
              <button style={styles.btnOrange} onClick={() => { action("restart"); notify("Restarting..."); }}>↺ Restart</button>
              <button style={styles.btnRed} onClick={() => { action("stop"); notify("Stopping..."); }}>■ Stop</button>
            </>
          )}
          <button style={styles.btnGhost} onClick={handleDelete} title="Delete script">🗑</button>
          <button style={styles.btnGhost} onClick={toggleExpand}>{expanded ? "▲" : "▼"}</button>
        </div>
      </div>

      {/* Expanded Panel */}
      {expanded && (
        <div style={styles.panel}>
          {/* Tab Bar */}
          <div style={styles.tabBar}>
            {["logs", "files"].map((t) => (
              <button
                key={t}
                style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}
                onClick={() => handleTabChange(t)}
              >
                {t === "logs" ? "📋 Logs" : "📁 Files"}
              </button>
            ))}
            {tab === "logs" && (
              <button style={{ ...styles.tab, marginLeft: "auto" }} onClick={clearLogs}>
                Clear
              </button>
            )}
            {tab === "files" && (
              <button style={{ ...styles.tab, marginLeft: "auto" }} onClick={() => setShowUpload(true)}>
                Upload
              </button>
            )}
          </div>

          {/* Logs Tab */}
          {tab === "logs" && (
            <div ref={logsRef} style={styles.logBox}>
              {logs.length === 0 ? (
                <span style={styles.noLog}>No logs yet.</span>
              ) : (
                logs.map((line, i) => (
                  <span key={i} style={line.startsWith("[manager]") ? styles.logManager : styles.logLine}>
                    {line}
                  </span>
                ))
              )}
            </div>
          )}

          {/* Files Tab */}
          {tab === "files" && (
            <div style={styles.fileList}>
              {files.length === 0 ? (
                <span style={styles.noLog}>No files found.</span>
              ) : (
                files.map((f) => (
                  <div key={f} style={styles.fileRow}>
                    <span style={styles.fileName}>{f}</span>
                    <button
                      style={styles.editBtn}
                      onClick={() => setEditingFile(f)}
                    >
                      Edit
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* File Editor Modal */}
      {editingFile && (
        <FileEditor
          scriptName={script.name}
          filename={editingFile}
          onClose={() => { setEditingFile(null); fetchFiles(); }}
        />
      )}

      {/* Upload Modal */}
      {showUpload && (
        <UploadModal
          scriptName={script.name}
          onClose={() => { setShowUpload(false); fetchFiles(); }}
        />
      )}
    </div>
  );
}

const styles = {
  card: {
    background: "#161616",
    border: "1px solid #252525",
    borderRadius: 8,
    overflow: "hidden",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    cursor: "pointer",
    userSelect: "none",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  scriptName: {
    fontWeight: 700,
    fontSize: 14,
    color: "#fff",
    letterSpacing: "-0.3px",
  },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
  },
  portBadge: {
    fontSize: 11,
    color: "#6b7280",
    background: "#1f1f1f",
    padding: "2px 6px",
    borderRadius: 4,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  actionMsg: {
    fontSize: 11,
    color: "#6b7280",
    marginRight: 4,
  },
  btnGreen: { padding: "4px 10px", background: "#15803d", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  btnRed: { padding: "4px 10px", background: "#991b1b", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  btnOrange: { padding: "4px 10px", background: "#92400e", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  btnGhost: { padding: "4px 8px", background: "transparent", color: "#555", border: "1px solid #2a2a2a", borderRadius: 4, cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  panel: {
    borderTop: "1px solid #222",
  },
  tabBar: {
    display: "flex",
    gap: 0,
    borderBottom: "1px solid #222",
    padding: "0 12px",
  },
  tab: {
    padding: "8px 14px",
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "#555",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "inherit",
  },
  tabActive: {
    color: "#e0e0e0",
    borderBottomColor: "#1a6ef5",
  },
  logBox: {
    background: "#0a0a0a",
    padding: "12px 16px",
    height: 220,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    fontFamily: "inherit",
    fontSize: 12,
    lineHeight: 1.6,
  },
  logLine: {
    color: "#a0a0a0",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  logManager: {
    color: "#3b82f6",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  noLog: { color: "#333", fontSize: 12 },
  fileList: {
    padding: "10px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  fileRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    background: "#111",
    borderRadius: 4,
    border: "1px solid #1e1e1e",
  },
  fileName: { fontSize: 13, color: "#ccc" },
  editBtn: {
    padding: "3px 10px",
    background: "transparent",
    border: "1px solid #333",
    color: "#888",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "inherit",
  },
};
