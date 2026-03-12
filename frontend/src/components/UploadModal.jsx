import { useState, useRef } from "react";

export default function UploadModal({ scriptName, onClose }) {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef();

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/scripts/${scriptName}/upload`, { method: "POST", body: fd });
    const data = await res.json();
    setUploading(false);
    if (res.ok) {
      setStatus({ ok: true, msg: `Uploaded: ${data.filename}` });
      setFile(null);
    } else {
      setStatus({ ok: false, msg: data.error || "Upload failed." });
    }
  };

  return (
    <div style={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <span style={styles.title}>Upload file to <strong>{scriptName}</strong></span>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={styles.body}>
          <div
            style={styles.dropZone}
            onClick={() => inputRef.current.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); setFile(e.dataTransfer.files[0]); setStatus(null); }}
          >
            {file ? (
              <span style={{ color: "#a0d0ff" }}>📄 {file.name}</span>
            ) : (
              <span style={{ color: "#444" }}>Click or drag & drop a file here</span>
            )}
            <input ref={inputRef} type="file" style={{ display: "none" }}
              onChange={(e) => { setFile(e.target.files[0]); setStatus(null); }} />
          </div>
          {status && (
            <div style={{ ...styles.msg, color: status.ok ? "#22c55e" : "#f87171" }}>{status.msg}</div>
          )}
          <div style={styles.actions}>
            <button style={styles.cancelBtn} onClick={onClose}>Close</button>
            <button style={styles.uploadBtn} onClick={handleUpload} disabled={!file || uploading}>
              {uploading ? "Uploading..." : "Upload"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
  },
  modal: {
    background: "#161616", border: "1px solid #2a2a2a", borderRadius: 10,
    width: "min(480px, 96vw)", fontFamily: "'JetBrains Mono', monospace",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 18px", borderBottom: "1px solid #222",
  },
  title: { fontSize: 13, color: "#888" },
  closeBtn: { background: "transparent", border: "none", color: "#555", cursor: "pointer", fontSize: 15, fontFamily: "inherit" },
  body: { padding: 18, display: "flex", flexDirection: "column", gap: 14 },
  dropZone: {
    border: "2px dashed #2a2a2a", borderRadius: 8, padding: "32px 20px",
    textAlign: "center", cursor: "pointer", fontSize: 13,
    background: "#0f0f0f",
  },
  msg: { fontSize: 12 },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8 },
  cancelBtn: { padding: "7px 14px", background: "transparent", border: "1px solid #333", color: "#777", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  uploadBtn: { padding: "7px 16px", background: "#1a6ef5", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 },
};
