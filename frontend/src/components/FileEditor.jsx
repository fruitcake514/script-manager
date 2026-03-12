import { useState, useEffect } from "react";

export default function FileEditor({ scriptName, filename, onClose }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch(`/api/scripts/${scriptName}/files/${filename}`)
      .then((r) => r.json())
      .then((d) => { setContent(d.content || ""); setLoading(false); });
  }, [scriptName, filename]);

  const save = async () => {
    setSaving(true);
    const res = await fetch(`/api/scripts/${scriptName}/files/${filename}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    setSaving(false);
    setMsg(res.ok ? "Saved!" : "Error saving.");
    setTimeout(() => setMsg(null), 2000);
  };

  return (
    <div style={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <span style={styles.title}>{scriptName} / <strong>{filename}</strong></span>
          <div style={styles.headerRight}>
            {msg && <span style={{ color: msg.startsWith("Saved") ? "#22c55e" : "#f87171", fontSize: 12 }}>{msg}</span>}
            <button style={styles.saveBtn} onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
            <button style={styles.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>
        {loading ? (
          <div style={styles.loading}>Loading...</div>
        ) : (
          <textarea
            style={styles.editor}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
  },
  modal: {
    background: "#111", border: "1px solid #2a2a2a", borderRadius: 10,
    width: "min(800px, 96vw)", height: "80vh",
    display: "flex", flexDirection: "column",
    fontFamily: "'JetBrains Mono', monospace",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 16px", borderBottom: "1px solid #1e1e1e",
    background: "#161616", borderRadius: "10px 10px 0 0",
  },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  title: { fontSize: 13, color: "#888" },
  saveBtn: {
    padding: "5px 14px", background: "#1a6ef5", color: "#fff",
    border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
  },
  closeBtn: {
    background: "transparent", border: "none", color: "#555",
    cursor: "pointer", fontSize: 15, fontFamily: "inherit",
  },
  editor: {
    flex: 1, padding: "14px 18px", background: "#0a0a0a",
    border: "none", color: "#a0d0ff", fontSize: 12,
    fontFamily: "inherit", lineHeight: 1.7,
    resize: "none", outline: "none", borderRadius: "0 0 10px 10px",
  },
  loading: { padding: 20, color: "#555", fontSize: 13 },
};
