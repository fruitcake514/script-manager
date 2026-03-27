import { useState, useEffect, useRef, useCallback } from "react";

// ── Syntax highlighting ──────────────────────────────────────────────────────

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
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightLine(line, tokens) {
  if (!tokens || tokens.length === 0) return escHtml(line);

  // Build flat array of { start, end, color } for all matches
  const spans = [];
  let html = escHtml(line);

  tokens.forEach(({ pattern, color }) => {
    const re = new RegExp(pattern.source, "g");
    let m;
    while ((m = re.exec(html)) !== null) {
      const full = m[0];
      const g1 = m[1];
      if (g1 !== undefined) {
        // Find where g1 starts within the full match in the html string
        const g1InFull = full.indexOf(g1);
        const g1Start = m.index + g1InFull;
        const g1End = g1Start + g1.length;
        spans.push({ start: g1Start, end: g1End, color });
      } else {
        spans.push({ start: m.index, end: m.index + full.length, color });
      }
    }
  });

  if (spans.length === 0) return html;

  // Sort by start position, then by length (longer first for same start)
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  // Remove overlapping spans — keep first match at each position
  const filtered = [];
  let lastEnd = -1;
  for (const sp of spans) {
    if (sp.start >= lastEnd) {
      filtered.push(sp);
      lastEnd = sp.end;
    }
  }

  // Build result string
  let result = "";
  let pos = 0;
  for (const sp of filtered) {
    if (sp.start > pos) result += html.slice(pos, sp.start);
    result += `<span style="color:${sp.color}">` + html.slice(sp.start, sp.end) + `</span>`;
    pos = sp.end;
  }
  if (pos < html.length) result += html.slice(pos);
  return result;
}

function syntaxHighlight(code, lang) {
  const lines = code.split("\n");
  let tokens = null;
  if (lang === "python") {
    tokens = [
      { pattern: /(#[^\n]*)/, color: "#6a9955" },
      { pattern: /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/, color: "#ce9178" },
      { pattern: /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|pass|break|continue|raise|yield|lambda|not|and|or|in|is|None|True|False|global|nonlocal|del|assert|async|await)\b/, color: "#569cd6" },
      { pattern: /\b([A-Z][A-Za-z0-9_]*)\b/, color: "#4ec9b0" },
      { pattern: /\b(\d+\.?\d*)\b/, color: "#b5cea8" },
      { pattern: /\b([a-z_][a-z0-9_]*)\s*(?=\()/, color: "#dcdcaa" },
    ];
  } else if (lang === "json") {
    tokens = [
      { pattern: /("(?:[^"\\]|\\.)*")(\s*:)/, color: "#9cdcfe" },
      { pattern: /:\s*("(?:[^"\\]|\\.)*")/, color: "#ce9178" },
      { pattern: /\b(true|false|null)\b/, color: "#569cd6" },
      { pattern: /\b(\d+\.?\d*)\b/, color: "#b5cea8" },
    ];
  }
  return lines.map((line) => highlightLine(line, tokens)).join("\n");
}

// ── Editor ───────────────────────────────────────────────────────────────────

export default function FileEditor({ scriptName, filename, onClose }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const editorRef = useRef(null);
  const syncRef = useRef(null); // prevents cursor jump during highlight sync
  const lang = getLanguage(filename);

  useEffect(() => {
    fetch(`/api/scripts/${scriptName}/files/${filename}`)
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content || "");
        setLoading(false);
      });
  }, [scriptName, filename]);

  // Render highlighted HTML into the editor div
  const renderHighlight = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const sel = window.getSelection();
    const savedRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

    el.innerHTML = syntaxHighlight(content, lang) + "\n";

    // Restore cursor position after innerHTML replacement
    if (savedRange) {
      try {
        sel.removeAllRanges();
        sel.addRange(savedRange);
      } catch (e) {
        // cursor restore failed — place at end
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, [content, lang]);

  useEffect(() => {
    if (!loading) {
      // Initial render
      const el = editorRef.current;
      if (el) {
        el.textContent = content;
        renderHighlight();
      }
    }
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-highlight on content change (debounced via rAF)
  useEffect(() => {
    if (loading) return;
    if (syncRef.current) cancelAnimationFrame(syncRef.current);
    syncRef.current = requestAnimationFrame(renderHighlight);
  }, [content, renderHighlight, loading]);

  const onInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    // Get plain text from contentEditable
    const text = el.innerText;
    // Remove trailing newline that contentEditable adds
    const clean = text.endsWith("\n") ? text.slice(0, -1) : text;
    setContent(clean);
  }, []);

  const save = async () => {
    setSaving(true);
    const res = await fetch(`/api/scripts/${scriptName}/files/${filename}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    setSaving(false);
    setMsg(res.ok ? "Saved" : "Error");
    setTimeout(() => setMsg(null), 2000);
  };

  const onKeyDown = useCallback(
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
      // Tab inserts 4 spaces
      if (e.key === "Tab") {
        e.preventDefault();
        document.execCommand("insertText", false, "    ");
      }
    },
    [save]
  );

  const lineCount = content.split("\n").length;

  return (
    <div style={S.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: "#666", flexShrink: 0 }}>{scriptName} / </span>
            <span style={{ fontSize: 14, color: "#e0e0e0", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {filename}
            </span>
            <span style={S.badge}>{lang}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            {msg && (
              <span style={{ color: msg === "Saved" ? "#34d399" : "#f87171", fontSize: 13 }}>
                {msg === "Saved" ? "✓" : "✗"} {msg}
              </span>
            )}
            <span style={{ fontSize: 11, color: "#555" }}>Ctrl+S · Tab = 4 spaces</span>
            <button style={S.saveBtn} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button style={S.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Editor body */}
        {loading ? (
          <div style={{ padding: 20, color: "#555", fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={S.body}>
            {/* Line numbers */}
            <div style={S.lineNums}>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} style={S.ln}>{i + 1}</div>
              ))}
            </div>

            {/* Editable code area */}
            <div style={S.codeOuter}>
              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={onInput}
                onKeyDown={onKeyDown}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                style={S.editor}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const F = "'JetBrains Mono', 'Fira Mono', 'Consolas', 'Courier New', monospace";
const FS = 13;
const LH = "20.8px"; // 13 * 1.6 = 20.8 — explicit pixel value for perfect alignment

const S = {
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
    width: "min(960px, 96vw)",
    height: "82vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontFamily: F,
    fontSize: FS,
    color: "#d4d4d4",
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
  badge: {
    fontSize: 10,
    color: "#4a9eff",
    background: "#0d1f35",
    border: "1px solid #1a3a5c",
    borderRadius: 4,
    padding: "2px 7px",
    textTransform: "uppercase",
    fontWeight: 600,
    flexShrink: 0,
  },
  saveBtn: {
    padding: "6px 14px",
    background: "#1a6ef5",
    color: "#fff",
    border: "none",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 12,
    fontFamily: F,
    fontWeight: 600,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "#666",
    cursor: "pointer",
    fontSize: 16,
    fontFamily: F,
  },
  body: {
    flex: 1,
    display: "flex",
    overflow: "hidden",
    background: "#1a1a1a",
  },
  lineNums: {
    padding: "14px 0",
    background: "#161616",
    borderRight: "1px solid #2a2a2a",
    textAlign: "right",
    flexShrink: 0,
    userSelect: "none",
    overflow: "hidden",
    minWidth: 52,
  },
  ln: {
    fontSize: FS,
    lineHeight: LH,
    color: "#444",
    paddingRight: 12,
    paddingLeft: 8,
    fontFamily: F,
  },
  codeOuter: {
    flex: 1,
    overflow: "auto",
    background: "#1a1a1a",
  },
  editor: {
    // contentEditable div — acts as both display and input
    padding: "14px 16px",
    fontFamily: F,
    fontSize: FS,
    lineHeight: LH,
    tabSize: 4,
    MozTabSize: 4,
    whiteSpace: "pre",
    wordWrap: "normal",
    overflowWrap: "normal",
    color: "#d4d4d4",
    background: "transparent",
    border: "none",
    outline: "none",
    minHeight: "100%",
    // Reset anything that might leak from global CSS
    margin: 0,
    letterSpacing: "normal",
    textIndent: 0,
    textAlign: "left",
    textDecoration: "none",
    textTransform: "none",
    listStyleType: "none",
    boxSizing: "content-box",
    resize: "none",
  },
};
