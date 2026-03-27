import { useEffect, useState, useCallback } from "react";
import ScriptCard from "./components/ScriptCard";
import CreateScriptModal from "./components/CreateScriptModal";

export default function App() {
  const [scripts, setScripts] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState(null);

  const fetchScripts = useCallback(async () => {
    try {
      const res = await fetch("/api/scripts");
      if (!res.ok) throw new Error("Failed to fetch scripts");
      setScripts(await res.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetchScripts();
    const interval = setInterval(fetchScripts, 3000);
    return () => clearInterval(interval);
  }, [fetchScripts]);

  const handleCreate = async (scriptData) => {
    const res = await fetch("/api/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scriptData),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create script");
    await fetchScripts();
    setShowCreate(false);
  };

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>pyRunner</h1>
          <p style={styles.subtitle}>
            {scripts.length} script{scripts.length !== 1 ? "s" : ""} · auto-refresh 3s
          </p>
        </div>
        <button style={styles.createBtn} onClick={() => setShowCreate(true)}>
          + New Script
        </button>
      </header>

      {error && <div style={styles.error}>⚠ {error}</div>}

      <main style={styles.main}>
        {scripts.length === 0 && !error ? (
          <div style={styles.empty}>
            <p>
              No scripts found in <code style={styles.code}>/scripts</code>.
            </p>
            <p>
              Click <strong style={{ color: "#ccc" }}>+ New Script</strong> to create one.
            </p>
          </div>
        ) : (
          scripts.map((s) => <ScriptCard key={s.name} script={s} refresh={fetchScripts} />)
        )}
      </main>

      {showCreate && <CreateScriptModal onClose={() => setShowCreate(false)} onCreate={handleCreate} />}
    </div>
  );
}

const styles = {
  app: {
    fontFamily: "'JetBrains Mono', 'Fira Mono', 'Courier New', monospace",
    background: "#0f0f0f",
    minHeight: "100vh",
    color: "#d4d4d4",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 28px 16px",
    borderBottom: "1px solid #1e1e1e",
    background: "#131313",
  },
  title: {
    margin: 0,
    fontSize: 24,
    fontWeight: 700,
    color: "#4a9eff",
    letterSpacing: "-0.5px",
  },
  subtitle: {
    margin: "4px 0 0",
    fontSize: 13,
    color: "#888",
  },
  createBtn: {
    padding: "9px 18px",
    background: "#1a6ef5",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
    fontFamily: "inherit",
    fontWeight: 600,
  },
  main: {
    padding: "20px 28px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  error: {
    margin: "12px 28px 0",
    padding: "10px 14px",
    background: "#2a1010",
    border: "1px solid #5a2020",
    borderRadius: 7,
    color: "#f87171",
    fontSize: 13,
  },
  empty: {
    color: "#777",
    fontSize: 14,
    lineHeight: 1.8,
  },
  code: {
    background: "#1a1a1a",
    padding: "2px 6px",
    borderRadius: 4,
    color: "#aaa",
    fontSize: 13,
  },
};
