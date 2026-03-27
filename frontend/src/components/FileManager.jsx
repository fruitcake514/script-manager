import { useState, useCallback } from "react";

/* ── Build tree from flat [{path, type}] list ──────────────────────────────── */
function buildTree(files) {
  const root = {};
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const isLast = i === parts.length - 1;
      if (!node[seg]) {
        node[seg] = {
          name: seg,
          relPath: parts.slice(0, i + 1).join("/"),
          type: isLast ? f.type : "directory",
          children: {},
        };
      }
      node = node[seg].children;
    }
  }
  return root;
}

/* ── Icons ─────────────────────────────────────────────────────────────────── */
const EXT_ICONS = {
  py: "🐍", txt: "📄", json: "📋", yaml: "⚙️", yml: "⚙️",
  env: "🔑", sh: "⚡", md: "📝", toml: "⚙️", js: "🟨", ts: "🔷",
  html: "🌐", css: "🎨", log: "📜", csv: "📊", xml: "🏷️", cfg: "⚙️", ini: "⚙️",
};
function iconFor(name) {
  const ext = name.split(".").pop().toLowerCase();
  return EXT_ICONS[ext] || "📄";
}

const ALLOWED_EXT = [
  ".py", ".txt", ".json", ".yaml", ".yml", ".env", ".cfg", ".ini",
  ".sh", ".md", ".toml", ".js", ".ts", ".html", ".css", ".xml", ".csv", ".log",
];
function isEditable(name) {
  return ALLOWED_EXT.some((e) => name.toLowerCase().endsWith(e));
}

/* ── TreeNode (recursive) ──────────────────────────────────────────────────── */
function TreeNode({ node, depth, scriptName, onEdit, onDelete, onRefresh }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newName, setNewName] = useState("");
  const isDir = node.type === "directory";

  const toggle = useCallback(() => {
    if (isDir) setExpanded((e) => !e);
  }, [isDir]);

  const createFile = useCallback(async () => {
    if (!newName.trim()) return;
    const path = node.relPath + "/" + newName.trim();
    await fetch(`/api/scripts/${scriptName}/files/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    setNewName("");
    setShowNewFile(false);
    onRefresh();
  }, [newName, node.relPath, scriptName, onRefresh]);

  const createFolder = useCallback(async () => {
    if (!newName.trim()) return;
    const path = node.relPath + "/" + newName.trim();
    await fetch(`/api/scripts/${scriptName}/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    setNewName("");
    setShowNewFolder(false);
    onRefresh();
  }, [newName, node.relPath, scriptName, onRefresh]);

  const handleDelete = useCallback(async () => {
    const label = isDir ? `folder "${node.relPath}"` : `file "${node.name}"`;
    if (!confirm(`Delete ${label}?`)) return;
    await fetch(`/api/scripts/${scriptName}/files/${node.relPath}`, { method: "DELETE" });
    onRefresh();
  }, [isDir, node, scriptName, onRefresh]);

  const paddingLeft = 14 + depth * 18;

  return (
    <div>
      {/* ── Row ── */}
      <div
        style={{
          ...rowStyle,
          paddingLeft,
          cursor: isDir ? "pointer" : "default",
          background: depth === 0 ? "transparent" : rowStyle.background,
        }}
        onClick={toggle}
      >
        <span style={rowIcon}>
          {isDir ? (expanded ? "▾ " : "▸ ") : "  "}
          {isDir ? (expanded ? "📂 " : "📁 ") : iconFor(node.name) + " "}
        </span>

        <span
          style={{
            ...rowName,
            fontWeight: isDir ? 600 : 400,
            color: isDir ? "#d4d4d4" : "#b0b0b0",
          }}
        >
          {node.name}
        </span>

        {/* ── Actions ── */}
        <div style={rowActions} onClick={(e) => e.stopPropagation()}>
          {isDir && (
            <>
              <button style={actBtn} title="New file" onClick={() => { setShowNewFile((v) => !v); setShowNewFolder(false); setNewName(""); }}>
                + file
              </button>
              <button style={actBtn} title="New subfolder" onClick={() => { setShowNewFolder((v) => !v); setShowNewFile(false); setNewName(""); }}>
                + folder
              </button>
            </>
          )}
          {!isDir && isEditable(node.name) && (
            <button style={editBtnStyle} onClick={() => onEdit(node.relPath)}>
              Edit
            </button>
          )}
          <button style={delBtnStyle} onClick={handleDelete}>
            ✕
          </button>
        </div>
      </div>

      {/* ── Inline new-file input ── */}
      {showNewFile && (
        <div style={{ ...inlineCreate, paddingLeft: paddingLeft + 24 }}>
          <input
            style={inlineInput}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createFile()}
            placeholder="filename.py"
            autoFocus
          />
          <button style={inlineOkBtn} onClick={createFile}>Create</button>
          <button style={inlineCancelBtn} onClick={() => setShowNewFile(false)}>Cancel</button>
        </div>
      )}

      {/* ── Inline new-folder input ── */}
      {showNewFolder && (
        <div style={{ ...inlineCreate, paddingLeft: paddingLeft + 24 }}>
          <input
            style={inlineInput}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createFolder()}
            placeholder="folder name"
            autoFocus
          />
          <button style={inlineOkBtn} onClick={createFolder}>Create</button>
          <button style={inlineCancelBtn} onClick={() => setShowNewFolder(false)}>Cancel</button>
        </div>
      )}

      {/* ── Children ── */}
      {isDir &&
        expanded &&
        Object.values(node.children)
          .sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === "directory" ? -1 : 1;
          })
          .map((child) => (
            <TreeNode
              key={child.relPath}
              node={child}
              depth={depth + 1}
              scriptName={scriptName}
              onEdit={onEdit}
              onDelete={onDelete}
              onRefresh={onRefresh}
            />
          ))}
    </div>
  );
}

/* ── FileManager (public) ──────────────────────────────────────────────────── */
export default function FileManager({ files, scriptName, onEditFile, onDeleteFile, onRefresh }) {
  const tree = buildTree(files);
  const entries = Object.values(tree).sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === "directory" ? -1 : 1;
  });

  if (entries.length === 0) {
    return <div style={emptyStyle}>No files yet.</div>;
  }

  return (
    <div style={containerStyle}>
      {entries.map((node) => (
        <TreeNode
          key={node.relPath}
          node={node}
          depth={0}
          scriptName={scriptName}
          onEdit={onEditFile}
          onDelete={onDeleteFile}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

/* ── Styles ────────────────────────────────────────────────────────────────── */
const containerStyle = {
  padding: "6px 0",
  display: "flex",
  flexDirection: "column",
  gap: 1,
};
const emptyStyle = { color: "#666", fontSize: 12, padding: "16px 14px" };

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 12px",
  borderRadius: 4,
  fontSize: 13,
};
const rowIcon = { flexShrink: 0, fontSize: 12, userSelect: "none" };
const rowName = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#b0b0b0",
  fontSize: 13,
};
const rowActions = { display: "flex", gap: 4, flexShrink: 0, opacity: 0.4, transition: "opacity .15s" };
// show actions on row hover via CSS trick — set opacity to 1 always for simplicity
Object.assign(rowActions, { opacity: 1 });

const actBtn = {
  padding: "1px 7px",
  background: "transparent",
  border: "1px solid #2a2a2a",
  color: "#6b7280",
  borderRadius: 3,
  cursor: "pointer",
  fontSize: 10,
  fontFamily: "inherit",
};
const editBtnStyle = {
  ...actBtn,
  color: "#4a9eff",
  borderColor: "#1a3a5c",
  background: "#0d1f35",
};
const delBtnStyle = {
  ...actBtn,
  color: "#f87171",
  borderColor: "#5a2020",
  background: "transparent",
};

const inlineCreate = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  padding: "4px 0",
};
const inlineInput = {
  padding: "3px 8px",
  background: "#0a0a0a",
  border: "1px solid #333",
  borderRadius: 4,
  color: "#e0e0e0",
  fontSize: 12,
  fontFamily: "inherit",
  outline: "none",
  width: 200,
};
const inlineOkBtn = {
  padding: "2px 10px",
  background: "#1a6ef5",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
};
const inlineCancelBtn = {
  padding: "2px 10px",
  background: "transparent",
  border: "1px solid #2a2a2a",
  color: "#808080",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
};
