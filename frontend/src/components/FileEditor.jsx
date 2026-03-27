import { useState, useEffect, useRef } from "react";

// ── Syntax token patterns ─────────────────────────────────────────────────────
const PYTHON_TOKENS = [
  { pattern: /(#[^\n]*)/, color: "#6a9955" },
  { pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"""[\s\S]*?"""|'''[\s\S]*?''')/, color: "#ce9178" },
  {
    pattern:
      /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|pass|break|continue|raise|yield|lambda|not|and|or|in|is|None|True|False|global|nonlocal|del|assert|async|await)\b/,
    color: "#569cd6",
  },
  { pattern: /\b([A-Z][A-Za-z0-9_]*)\b/, color: "#4ec9b0" },
  { pattern: /\b(\d+\.?\d*)\b/, color: "#b5cea8" },
  { pattern: /\b([a-z_][a-z0-9_]*)\s*(?=\()/, color: "#dcdcaa" },
];

const JSON_TOKENS = [
  { pattern: /("(?:[^"\\]|\\.)*")(\s*:)/, color: "#9cdcfe" },
  { pattern: /:\s*("(?:[^"\\]|\\.)*")/, color: "#ce9178" },
  { pattern: /\b(true|false|null)\b/, color: "#569cd6" },
  { pattern: /\b(\d+\.?\d*)\b/, color: "#b5cea8" },
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

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function syntaxHighlight(code, lang) {
  if (lang === "text") return escHtml(code);
  const lines = code.split("\n");
  return lines.map((line) => highlightLine(line, lang)).join("\n");
}

function highlightLine(line, lang) {
  const tokens =
    lang === "python" ? PYTHON_TOKENS : lang === "json" ? JSON_TOKENS : [];
  if (!tokens.length) {
    let h = escHtml(line);
    h = h.replace(/(#[^\n]*)/, '<span style="color:#6a9955">$1</span>');
    return h;
  }
  let html = escHtml(line);
  tokens.forEach(({ pattern, color }) => {
    html = html.replace(new RegExp(pattern.source, "g"), (match, g1) => {
      if (g1 !== undefined) {
        return match.replace(
          escHtml(g1),
          `<span style="color:${color}">${escHtml(g1)}</span>`
        );
      }
      return `<span style="color:${color}">${escHtml(match)}</span>`;
    });
  });
  return html;
}

export default function FileEditor({ scriptName, filename, onClose }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const textareaRef = useRef(null);
  const previewRef = useRef(null);
  const lineNumsRef = useRef(null);
  const lang = getLanguage(filename);

  useEffect(() => {
    fetch(`/api/scripts/${scriptName}/files/${filename}`)
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content || "");
        setLoading(false);
      });
  }, [scriptName, filename]);

  // Sync scroll between textarea, highlight preview, and line numbers
  const syncScroll = () => {
    if (textareaRef.current && previewRef.current) {
      previewRef.current.scrollTop = textareaRef.current.scrollTop;
      previewRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
    if (textareaRef.current && lineNumsRef.current) {
      lineNumsRef.current.scrollTop = textareaRef.current.scrollTop;
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

  const handleKeyDown = (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      const next = content.substring(0, start) + "    " + content.substring(end);
      setContent(next);
      requestAnimationFrame(() => {
        textareaRef.current.selectionStart = start + 4;
        textareaRef.current.selectionEnd = start + 4;
      });
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      save();
    }
  };

  const highlighted = syntaxHighlight(content, lang);
  const lineCount = content.split("\n").length;

  return (
    <div style={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        {/* Header */}
        <div style={s.header}>
          <div style={s.headerLeft}>
            <span style={s.path}>{scriptName} / </span>
            <span style={s.fname}>{filename}</span>
            <span style={s.langBadge}>{lang}</span>
          </div>
          <div style={s.headerRight}>
            {msg && (
              <span style={{ color: msg.startsWith("✓") ? "#34d399" : "#f87171", fontSize: 13 }}>
                {msg}
              </span>
            )}
            <span style={s.hint}>Ctrl+S save · Tab = 4 spaces</span>
            <button style={s.saveBtn} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button style={s.closeBtn} onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {/* Editor body — isolated with all:initial to prevent CSS leaking */}
        {loading ? (
          <div style={{ padding: 20, color: "#555", fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={s.editorWrap}>
            {/* Line numbers */}
            <div ref={lineNumsRef} style={s.lineNums}>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} style={s.lineNum}>
                  {i + 1}
                </div>
              ))}
            </div>
            {/* Code area */}
            <div style={s.codeArea}>
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
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                onScroll={syncScroll}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const FONT = "'JetBrains Mono', 'Fira Mono', 'Consolas', monospace";
const FONT_SIZE = 13;
const LINE_H = 1.65;

const s = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.88)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 200,
  },
  modal: {
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: 10,
    width: "min(940px, 96vw)",
    height: "85vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    /* Reset all inherited styles to prevent CSS leaking from parent */
    all: "initial",
    fontFamily: FONT,
    fontSize: FONT_SIZE,
    color: "#d4d4d4",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px",
    borderBottom: "1px solid #2a2a2a",
    background: "#222",
    flexShrink: 0,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 8 },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  path: { fontSize: 12, color: "#666" },
  fname: { fontSize: 14, color: "#e0e0e0", fontWeight: 700 },
  langBadge: {
    fontSize: 10,
    color: "#4a9eff",
    background: "#0d1f35",
    border: "1px solid #1a3a5c",
    borderRadius: 4,
    padding: "2px 7px",
    textTransform: "uppercase",
    fontWeight: 600,
  },
  hint: { fontSize: 11, color: "#555" },
  saveBtn: {
    padding: "6px 14px",
    background: "#1a6ef5",
    color: "#fff",
    border: "none",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 12,
    fontFamily: FONT,
    fontWeight: 600,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "#666",
    cursor: "pointer",
    fontSize: 16,
    fontFamily: FONT,
  },
  editorWrap: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
    background: "#1a1a1a",
    position: "relative",
  },
  lineNums: {
    padding: "14px 0",
    background: "#161616",
    borderRight: "1px solid #2a2a2a",
    textAlign: "right",
    flexShrink: 0,
    userSelect: "none",
    overflowY: "hidden",
    minWidth: 52,
  },
  lineNum: {
    fontSize: FONT_SIZE,
    lineHeight: String(LINE_H),
    color: "#444",
    paddingRight: 12,
    paddingLeft: 8,
    fontFamily: FONT,
  },
  codeArea: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  highlight: {
    position: "absolute",
    inset: 0,
    margin: 0,
    padding: "14px 16px",
    fontSize: FONT_SIZE,
    lineHeight: String(LINE_H),
    fontFamily: FONT,
    color: "#d4d4d4",
    background: "transparent",
    pointerEvents: "none",
    overflow: "hidden",
    whiteSpace: "pre",
    wordBreak: "normal",
    zIndex: 1,
    /* Explicitly prevent CSS leaking */
    boxSizing: "border-box",
    border: "none",
    outline: "none",
    textDecoration: "none",
    textTransform: "none",
    letterSpacing: "normal",
    tabSize: 4,
  },
  textarea: {
    position: "absolute",
    inset: 0,
    padding: "14px 16px",
    fontSize: FONT_SIZE,
    lineHeight: String(LINE_H),
    fontFamily: FONT,
    background: "transparent",
    color: "transparent",
    caretColor: "#fff",
    border: "none",
    outline: "none",
    resize: "none",
    overflow: "auto",
    whiteSpace: "pre",
    wordBreak: "normal",
    zIndex: 2,
    /* Explicitly prevent CSS leaking */
    boxSizing: "border-box",
    textDecoration: "none",
    textTransform: "none",
    letterSpacing: "normal",
    tabSize: 4,
  },
};
