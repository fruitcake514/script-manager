import { useState, useEffect, useRef } from "react";

// ── Syntax token patterns ─────────────────────────────────────────────────────
const PYTHON_TOKENS = [
  { pattern: /(#[^\n]*)/, color: "#6a9955" },                          // comments
  { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"""[\s\S]*?"""|'''[\s\S]*?''')/, color: "#ce9178" }, // strings
  { pattern: /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|pass|break|continue|raise|yield|lambda|not|and|or|in|is|None|True|False|global|nonlocal|del|assert|async|await)\b/, color: "#569cd6" }, // keywords
  { pattern: /\b([A-Z][A-Za-z0-9_]*)\b/, color: "#4ec9b0" },           // classes
  { pattern: /\b(\d+\.?\d*)\b/, color: "#b5cea8" },                    // numbers
  { pattern: /\b([a-z_][a-z0-9_]*)\s*(?=\()/, color: "#dcdcaa" },     // function calls
];

const JSON_TOKENS = [
  { pattern: /("(?:[^"\\]|\\.)*")(\s*:)/, color: "#9cdcfe", groupColor: "#fff" }, // keys
  { pattern: /:\s*("(?:[^"\\]|\\.)*")/, color: "#ce9178" },            // string values
  { pattern: /\b(true|false|null)\b/, color: "#569cd6" },              // literals
  { pattern: /\b(\d+\.?\d*)\b/, color: "#b5cea8" },                    // numbers
];

const YAML_TOKENS = [
  { pattern: /(#[^\n]*)/, color: "#6a9955" },
  { pattern: /^(\s*[\w-]+)\s*:/, color: "#9cdcfe" },
  { pattern: /:\s*(.+)$/, color: "#ce9178" },
];

function getLanguage(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  if (["py"].includes(ext)) return "python";
  if (["json"].includes(ext)) return "json";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (["sh", "bash"].includes(ext)) return "shell";
  if (["env", "cfg", "ini"].includes(ext)) return "ini";
  return "text";
}

function getLineNumbers(content) {
  return content.split("\n").map((_, i) => i + 1);
}

function syntaxHighlight(code, lang) {
  if (lang === "text") return escHtml(code);

  // Simple approach: tokenize line by line
  const lines = code.split("\n");
  return lines.map(line => highlightLine(line, lang)).join("\n");
}

function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function highlightLine(line, lang) {
  const tokens = lang === "python" ? PYTHON_TOKENS : lang === "json" ? JSON_TOKENS : [];
  if (!tokens.length) {
    // shell/ini: just colour comments and strings
    let h = escHtml(line);
    h = h.replace(/(#[^\n]*)/, '<span style="color:#6a9955">$1</span>');
    return h;
  }
  // Build array of {start,end,color} spans, then render
  let html = escHtml(line);
  tokens.forEach(({ pattern, color }) => {
    html = html.replace(new RegExp(pattern.source, "g"), (match, g1) => {
      const text = g1 !== undefined ? g1 : match;
      const full = match;
      if (g1 !== undefined) {
        return full.replace(escHtml(g1), `<span style="color:${color}">${escHtml(g1)}</span>`);
      }
      return `<span style="color:${color}">${escHtml(match)}</span>`;
    });
  });
  return html;
}

export default function FileEditor({ scriptName, filename, onClose }) {
  const [content, setContent]   = useState("");
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState(null);
  const [showPreview, setShowPreview] = useState(true);
  const textareaRef = useRef(null);
  const previewRef  = useRef(null);
  const lang = getLanguage(filename);

  useEffect(() => {
    fetch(`/api/scripts/${scriptName}/files/${filename}`)
      .then(r => r.json())
      .then(d => { setContent(d.content || ""); setLoading(false); });
  }, [scriptName, filename]);

  // Sync scroll between textarea and highlight preview
  const syncScroll = () => {
    if (textareaRef.current && previewRef.current) {
      previewRef.current.scrollTop  = textareaRef.current.scrollTop;
      previewRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  const save = async () => {
    setSaving(true);
    const res = await fetch(`/api/scripts/${scriptName}/files/${filename}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    setSaving(false);
    setMsg(res.ok ? "✓ Saved" : "✗ Error");
    setTimeout(() => setMsg(null), 2000);
  };

  // Tab key inserts spaces
  const handleKeyDown = (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = e.target.selectionStart;
      const end   = e.target.selectionEnd;
      const next  = content.substring(0, start) + "    " + content.substring(end);
      setContent(next);
      requestAnimationFrame(() => {
        textareaRef.current.selectionStart = start + 4;
        textareaRef.current.selectionEnd   = start + 4;
      });
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      save();
    }
  };

  const highlighted = syntaxHighlight(content, lang);
  const lineNums = getLineNumbers(content);

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        {/* Header */}
        <div style={s.header}>
          <div style={s.headerLeft}>
            <span style={s.path}>{scriptName} /</span>
            <span style={s.fname}>{filename}</span>
            <span style={s.langBadge}>{lang}</span>
          </div>
          <div style={s.headerRight}>
            {msg && <span style={{ color: msg.startsWith("✓") ? "#34d399" : "#f87171", fontSize: 12 }}>{msg}</span>}
            <span style={s.hint}>Ctrl+S to save · Tab = 4 spaces</span>
            <button style={s.saveBtn} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button style={s.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Editor body */}
        {loading ? (
          <div style={{ padding: 20, color: "#444", fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={s.editorWrap}>
            {/* Line numbers */}
            <div style={s.lineNums}>
              {lineNums.map(n => <div key={n} style={s.lineNum}>{n}</div>)}
            </div>
            {/* Highlight layer */}
            <pre
              ref={previewRef}
              style={s.highlight}
              dangerouslySetInnerHTML={{ __html: highlighted + "\n" }}
              aria-hidden
            />
            {/* Editable textarea on top */}
            <textarea
              ref={textareaRef}
              style={s.textarea}
              value={content}
              onChange={e => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={syncScroll}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
        )}
      </div>
    </div>
  );
}

const FONT = "'JetBrains Mono', 'Fira Mono', monospace";
const s = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
  },
  modal: {
    background: "#1e1e1e", border: "1px solid #333", borderRadius: 10,
    width: "min(920px, 96vw)", height: "85vh",
    display: "flex", flexDirection: "column",
    fontFamily: FONT, overflow: "hidden",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 16px", borderBottom: "1px solid #2a2a2a",
    background: "#252525", flexShrink: 0,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 6 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  path:  { fontSize: 12, color: "#555" },
  fname: { fontSize: 13, color: "#e0e0e0", fontWeight: 700 },
  langBadge: { fontSize: 10, color: "#4a9eff", background: "#0d1f35", border: "1px solid #1a3a5c", borderRadius: 4, padding: "1px 6px", textTransform: "uppercase" },
  hint:  { fontSize: 10, color: "#333" },
  saveBtn: { padding: "5px 14px", background: "#1a6ef5", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: FONT },
  closeBtn: { background: "transparent", border: "none", color: "#555", cursor: "pointer", fontSize: 15, fontFamily: FONT },
  editorWrap: {
    flex: 1, display: "flex", overflow: "hidden", position: "relative",
    background: "#1e1e1e",
  },
  lineNums: {
    padding: "14px 0", background: "#1a1a1a", borderRight: "1px solid #2a2a2a",
    textAlign: "right", flexShrink: 0, userSelect: "none",
    overflowY: "hidden", minWidth: 48,
  },
  lineNum: { fontSize: 12, lineHeight: "1.65", color: "#3a3a3a", paddingRight: 10, paddingLeft: 8 },
  highlight: {
    position: "absolute", top: 0, left: 48, right: 0, bottom: 0,
    margin: 0, padding: "14px 16px",
    fontSize: 12, lineHeight: "1.65",
    fontFamily: FONT, color: "#d4d4d4",
    background: "transparent", pointerEvents: "none",
    overflow: "auto", whiteSpace: "pre", wordBreak: "break-all",
    zIndex: 1,
  },
  textarea: {
    position: "absolute", top: 0, left: 48, right: 0, bottom: 0,
    padding: "14px 16px",
    fontSize: 12, lineHeight: "1.65",
    fontFamily: FONT,
    background: "transparent", color: "transparent",
    caretColor: "#fff",
    border: "none", outline: "none", resize: "none",
    overflow: "auto", whiteSpace: "pre", wordBreak: "break-all",
    zIndex: 2,
  },
};
