import { useState } from "react";

const DEFAULT_PY = `# Your script here
import time

print("Script started!")

# Example: run forever
while True:
    print("Running...")
    time.sleep(10)
`;

export default function CreateScriptModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [pyContent, setPyContent] = useState(DEFAULT_PY);
  const [reqContent, setReqContent] = useState("");
  const [activeTab, setActiveTab] = useState("main");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) { setError("Script name is required."); return; }
    setLoading(true);
    try {
      await onCreate({
        name: name.trim(),
        python_content: pyContent,
        requirements_content: reqContent,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.modal}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>New Script</h2>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Script Name</label>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my_script"
            autoFocus
          />
          <small style={styles.hint}>Spaces will be replaced with underscores. Creates <code>/scripts/{name || "name"}/</code></small>
        </div>

        <div style={styles.tabBar}>
          {[["main", "main.py"], ["req", "requirements.txt"]].map(([t, label]) => (
            <button
              key={t}
              style={{ ...styles.tab, ...(activeTab === t ? styles.tabActive : {}) }}
              onClick={() => setActiveTab(t)}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === "main" && (
          <textarea
            style={styles.editor}
            value={pyContent}
            onChange={(e) => setPyContent(e.target.value)}
            spellCheck={false}
          />
        )}
        {activeTab === "req" && (
          <textarea
            style={styles.editor}
            value={reqContent}
            onChange={(e) => setReqContent(e.target.value)}
            placeholder={"# One package per line\nrequests\nnumpy"}
            spellCheck={false}
          />
        )}

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.actions}>
          <button style={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={styles.createBtn} onClick={handleSubmit} disabled={loading}>
            {loading ? "Creating..." : "Create & Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
  },
  modal: {
    background: "#161616", border: "1px solid #2a2a2a", borderRadius: 10,
    width: "min(680px, 96vw)", display: "flex", flexDirection: "column", gap: 0,
    fontFamily: "'JetBrains Mono', monospace",
  },
  modalHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "16px 20px", borderBottom: "1px solid #222",
  },
  modalTitle: { margin: 0, fontSize: 16, color: "#fff", fontWeight: 700 },
  closeBtn: {
    background: "transparent", border: "none", color: "#555",
    cursor: "pointer", fontSize: 16, fontFamily: "inherit",
  },
  field: { padding: "16px 20px 0" },
  label: { display: "block", fontSize: 11, color: "#666", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" },
  input: {
    width: "100%", padding: "8px 12px", background: "#0f0f0f",
    border: "1px solid #2a2a2a", borderRadius: 6, color: "#e0e0e0",
    fontSize: 13, fontFamily: "inherit", boxSizing: "border-box",
  },
  hint: { color: "#444", fontSize: 11, marginTop: 4, display: "block" },
  tabBar: {
    display: "flex", borderBottom: "1px solid #222", padding: "0 20px", marginTop: 16,
  },
  tab: {
    padding: "8px 14px", background: "transparent", border: "none",
    borderBottom: "2px solid transparent", color: "#555",
    cursor: "pointer", fontSize: 12, fontFamily: "inherit",
  },
  tabActive: { color: "#e0e0e0", borderBottomColor: "#1a6ef5" },
  editor: {
    margin: "0", padding: "14px 20px", background: "#0a0a0a",
    border: "none", borderBottom: "1px solid #1e1e1e",
    color: "#a0d0ff", fontSize: 12, fontFamily: "inherit",
    lineHeight: 1.7, width: "100%", height: 240,
    resize: "vertical", boxSizing: "border-box", outline: "none",
  },
  error: {
    margin: "12px 20px 0", padding: "8px 12px", background: "#2a1010",
    border: "1px solid #5a2020", borderRadius: 6, color: "#f87171", fontSize: 12,
  },
  actions: {
    display: "flex", justifyContent: "flex-end", gap: 8,
    padding: "14px 20px",
  },
  cancelBtn: {
    padding: "8px 16px", background: "transparent", border: "1px solid #333",
    color: "#888", borderRadius: 6, cursor: "pointer", fontSize: 13, fontFamily: "inherit",
  },
  createBtn: {
    padding: "8px 18px", background: "#1a6ef5", color: "#fff",
    border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13,
    fontFamily: "inherit", fontWeight: 600,
  },
};
