import { useState } from "react";

const TEMPLATES = {
  ".py": "# New Python script\n\nprint('Hello!')\n",
  ".json": '{\n  "key": "value"\n}\n',
  ".yaml": "# Config\nkey: value\n",
  ".yml": "# Config\nkey: value\n",
  ".sh": "#!/bin/bash\necho 'Hello'\n",
  ".env": "# Environment variables\nKEY=value\n",
  ".txt": "",
  ".md": "# Title\n\nContent here.\n",
  ".toml": '# Config\n[section]\nkey = "value"\n',
};

export default function NewFileModal({ scriptName, onClose, subDir }) {
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleFilenameChange = (val) => {
    setFilename(val);
    const ext = "." + val.split(".").pop().toLowerCase();
    if (TEMPLATES[ext] !== undefined && content === "") {
      setContent(TEMPLATES[ext]);
    }
  };

  const save = async () => {
    if (!filename.trim()) {
      setError("Filename is required");
      return;
    }
    setSaving(true);
    const path = subDir ? subDir + "/" + filename.trim() : filename.trim();
    const res = await fetch(`/api/scripts/${scriptName}/files/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    setSaving(false);
    if (res.ok) {
      onClose();
    } else {
      setError("Failed to save file");
    }
  };

  return (
    <div style={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.header}>
          <span style={s.title}>
            New file in <strong style={{ color: "#d4d4d4" }}>{scriptName}</strong>
            {subDir && <span style={{ color: "#666" }}> / {subDir}</span>}
          </span>
          <button style={s.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={s.body}>
          <label style={s.label}>Filename</label>
          <input
            style={s.input}
            value={filename}
            onChange={(e) => handleFilenameChange(e.target.value)}
            placeholder="config.yaml"
            autoFocus
          />
          <div style={s.extHints}>
            {Object.keys(TEMPLATES).map((ext) => (
              <button
                key={ext}
                style={s.extBtn}
                onClick={() =>
                  handleFilenameChange(filename.replace(/\.[^.]+$/, "") + ext || "file" + ext)
                }
              >
                {ext}
              </button>
            ))}
          </div>
          <label style={s.label}>Content</label>
          <textarea
            style={s.editor}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
          {error && <div style={s.error}>{error}</div>}
          <div style={s.actions}>
            <button style={s.cancelBtn} onClick={onClose}>
              Cancel
            </button>
            <button style={s.saveBtn} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Create File"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const FONT = "'JetBrains Mono', monospace";
const s = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.8)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 200,
  },
  modal: {
    background: "#181818",
    border: "1px solid #2a2a2a",
    borderRadius: 10,
    width: "min(600px, 96vw)",
    fontFamily: FONT,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 18px",
    borderBottom: "1px solid #222",
  },
  title: { fontSize: 14, color: "#999" },
  closeBtn: { background: "transparent", border: "none", color: "#666", cursor: "pointer", fontSize: 15, fontFamily: FONT },
  body: { padding: 18, display: "flex", flexDirection: "column", gap: 10 },
  label: { fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.07em" },
  input: {
    padding: "9px 12px",
    background: "#111",
    border: "1px solid #333",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 13,
    fontFamily: FONT,
    outline: "none",
  },
  extHints: { display: "flex", flexWrap: "wrap", gap: 5 },
  extBtn: {
    padding: "3px 9px",
    background: "#141414",
    border: "1px solid #2a2a2a",
    color: "#888",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 11,
    fontFamily: FONT,
  },
  editor: {
    padding: "12px",
    background: "#0e0e0e",
    border: "1px solid #222",
    borderRadius: 6,
    color: "#b0d4f1",
    fontSize: 12,
    fontFamily: FONT,
    lineHeight: 1.65,
    height: 200,
    resize: "vertical",
    outline: "none",
  },
  error: {
    padding: "8px 12px",
    background: "#2a1010",
    border: "1px solid #5a2020",
    borderRadius: 6,
    color: "#f87171",
    fontSize: 12,
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8 },
  cancelBtn: {
    padding: "8px 14px",
    background: "transparent",
    border: "1px solid #333",
    color: "#999",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
    fontFamily: FONT,
  },
  saveBtn: {
    padding: "8px 16px",
    background: "#1a6ef5",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
    fontFamily: FONT,
    fontWeight: 600,
  },
};
