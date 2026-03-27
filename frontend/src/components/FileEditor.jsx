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

function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(code, lang) {
  const lines = code.split("\n");
  let tokens = null;
  if (lang === "python") {
    tokens = [
      { re: /(#[^\n]*)/, c: "#6a9955" },
      { re: /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/, c: "#ce9178" },
      { re: /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|pass|break|continue|raise|yield|lambda|not|and|or|in|is|None|True|False|global|nonlocal|del|assert|async|await)\b/, c: "#569cd6" },
      { re: /\b([A-Z][A-Za-z0-9_]*)\b/, c: "#4ec9b0" },
      { re: /\b(\d+\.?\d*)\b/, c: "#b5cea8" },
      { re: /\b([a-z_][a-z0-9_]*)\s*(?=\()/, c: "#dcdcaa" },
    ];
  } else if (lang === "json") {
    tokens = [
      { re: /("(?:[^"\\]|\\.)*")(\s*:)/, c: "#9cdcfe" },
      { re: /:\s*("(?:[^"\\]|\\.)*")/, c: "#ce9178" },
      { re: /\b(true|false|null)\b/, c: "#569cd6" },
      { re: /\b(\d+\.?\d*)\b/, c: "#b5cea8" },
    ];
  }
  return lines.map((line) => hlLine(line, tokens)).join("\n");
}

function hlLine(line, tokens) {
  if (!tokens) return esc(line);
  // Find all matches with positions
  const spans = [];
  const src = esc(line);
  for (const { re, c: color } of tokens) {
    const rx = new RegExp(re.source, "g");
    let m;
    while ((m = rx.exec(src)) !== null) {
      const g = m[1];
      if (g !== undefined) {
        const gi = m[0].indexOf(g);
        spans.push({ s: m.index + gi, e: m.index + gi + g.length, c: color });
      } else {
        spans.push({ s: m.index, e: m.index + m[0].length, c: color });
      }
    }
  }
  if (!spans.length) return src;
  // Sort, deduplicate overlapping
  spans.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
  const kept = [];
  let end = -1;
  for (const sp of spans) {
    if (sp.s >= end) { kept.push(sp); end = sp.e; }
  }
  // Build output
  let out = "", pos = 0;
  for (const sp of kept) {
    if (sp.s > pos) out += src.slice(pos, sp.s);
    out += `<span style="color:${sp.c}">` + src.slice(sp.s, sp.e) + "</span>";
    pos = sp.e;
  }
  if (pos < src.length) out += src.slice(pos);
  return out;
}

// ── Editor ───────────────────────────────────────────────────────────────────

const F = "'JetBrains Mono', 'Fira Mono', 'Consolas', 'Courier New', monospace";
const FS = 13;
const LH = 1.65;

export default function FileEditor({ scriptName, filename, onClose }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const ta = useRef(null);
  const pre = useRef(null);
  const ln = useRef(null);
  const lang = getLanguage(filename);

  useEffect(() => {
    fetch(`/api/scripts/${scriptName}/files/${filename}`)
      .then((r) => r.json())
      .then((d) => { setContent(d.content || ""); setLoading(false); });
  }, [scriptName, filename]);

  // Sync scroll from textarea → pre + line nums
  const syncScroll = useCallback(() => {
    const t = ta.current;
    if (!t) return;
    if (pre.current) { pre.current.scrollTop = t.scrollTop; pre.current.scrollLeft = t.scrollLeft; }
    if (ln.current) ln.current.scrollTop = t.scrollTop;
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

  const onKey = useCallback((e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = e.target.selectionStart, end = e.target.selectionEnd;
      const next = content.substring(0, s) + "    " + content.substring(end);
      setContent(next);
      requestAnimationFrame(() => { ta.current.selectionStart = ta.current.selectionEnd = s + 4; });
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); }
  }, [content, save]);

  const lines = content.split("\n").length;

  return (
    <div style={S.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: "#666", flexShrink: 0 }}>{scriptName} / </span>
            <span style={S.fname}>{filename}</span>
            <span style={S.badge}>{lang}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            {msg && <span style={{ color: msg === "Saved" ? "#34d399" : "#f87171", fontSize: 13 }}>{msg === "Saved" ? "✓" : "✗"} {msg}</span>}
            <span style={{ fontSize: 11, color: "#555" }}>Ctrl+S · Tab=4</span>
            <button style={S.saveBtn} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button style={S.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {loading ? <div style={{ padding: 20, color: "#555", fontSize: 13 }}>Loading…</div> : (
          <div style={S.body}>
            {/* Line numbers — synced scroll via JS */}
            <div ref={ln} style={S.lnCol}>
              {Array.from({ length: lines }, (_, i) => <div key={i} style={S.ln}>{i + 1}</div>)}
            </div>

            {/* Code area */}
            <div style={S.codeWrap}>
              {/* Highlight layer behind */}
              <pre ref={pre} style={S.pre} dangerouslySetInnerHTML={{ __html: highlight(content, lang) + "\n" }} aria-hidden="true" />
              {/* Textarea on top — transparent text, visible caret */}
              <textarea
                ref={ta}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={onKey}
                onScroll={syncScroll}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                style={S.ta}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles — no all:initial, explicit resets on editor elements only ─────────

const S = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
  },
  modal: {
    background: "#1a1a1a", border: "1px solid #333", borderRadius: 10,
    width: "min(960px, 96vw)", height: "82vh",
    display: "flex", flexDirection: "column", overflow: "hidden",
    fontFamily: F, fontSize: FS, color: "#d4d4d4",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 16px", borderBottom: "1px solid #2a2a2a", background: "#222", flexShrink: 0,
  },
  fname: { fontSize: 14, color: "#e0e0e0", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  badge: {
    fontSize: 10, color: "#4a9eff", background: "#0d1f35", border: "1px solid #1a3a5c",
    borderRadius: 4, padding: "2px 7px", textTransform: "uppercase", fontWeight: 600, flexShrink: 0,
  },
  saveBtn: {
    padding: "6px 14px", background: "#1a6ef5", color: "#fff", border: "none",
    borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: F, fontWeight: 600,
  },
  closeBtn: { background: "transparent", border: "none", color: "#666", cursor: "pointer", fontSize: 16, fontFamily: F },
  body: { flex: 1, display: "flex", overflow: "hidden", background: "#1a1a1a" },
  lnCol: {
    padding: "14px 0", background: "#161616", borderRight: "1px solid #2a2a2a",
    textAlign: "right", flexShrink: 0, userSelect: "none", overflow: "hidden", minWidth: 52,
  },
  ln: { fontSize: FS, lineHeight: String(LH), color: "#444", paddingRight: 12, paddingLeft: 8, fontFamily: F },
  codeWrap: { flex: 1, position: "relative", overflow: "hidden" },

  // Shared font properties — textarea and pre MUST match exactly
  pre: {
    position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
    margin: 0, padding: "14px 16px",
    fontFamily: F, fontSize: FS, lineHeight: String(LH), tabSize: 4,
    whiteSpace: "pre", wordWrap: "normal", overflowWrap: "normal",
    color: "#d4d4d4", background: "#1a1a1a",
    pointerEvents: "none", overflow: "hidden", zIndex: 1,
    boxSizing: "border-box", border: "none", outline: "none",
    letterSpacing: "normal", textIndent: 0, textDecoration: "none",
    // Override any leaking global styles
    display: "block", float: "none", clear: "none",
    verticalAlign: "baseline", textAlign: "left",
  },
  ta: {
    position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
    padding: "14px 16px",
    fontFamily: F, fontSize: FS, lineHeight: String(LH), tabSize: 4,
    whiteSpace: "pre", wordWrap: "normal", overflowWrap: "normal",
    color: "transparent", caretColor: "#fff", background: "transparent",
    border: "none", outline: "none", resize: "none",
    overflow: "auto", zIndex: 2,
    boxSizing: "border-box",
    letterSpacing: "normal", textIndent: 0, textDecoration: "none",
    display: "block", float: "none", clear: "none",
    verticalAlign: "baseline", textAlign: "left",
  },
};
