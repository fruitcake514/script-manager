import { useEffect, useState, useCallback } from "react";
import ScriptCard from "./components/ScriptCard";
import CreateScriptModal from "./components/CreateScriptModal";
import { getToken, setToken, clearToken, apiFetch, apiJson } from "./api";

export default function App() {
  const [scripts, setScripts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState(null);
  const [token, setTok] = useState(getToken());
  const [tokenInput, setTokenInput] = useState(getToken());

  const authed = token.length > 0;

  const fetchScripts = useCallback(async () => {
    if (!getToken()) return;
    try {
      const data = await apiJson("/api/scripts");
      setScripts(data);
      setError(null);
    } catch (e) {
      if (e.code === 401) setError("Unauthorized — wrong or missing API token.");
      else setError(e.message);
    }
  }, []);

  const fetchSummary = useCallback(async () => {
    if (!getToken()) return;
    try {
      setSummary(await apiJson("/api/summary"));
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetchScripts();
    fetchSummary();
    const i1 = setInterval(fetchScripts, 5000);
    const i2 = setInterval(fetchSummary, 5000);
    return () => { clearInterval(i1); clearInterval(i2); };
  }, [fetchScripts, fetchSummary, authed]);

  const saveToken = () => {
    setToken(tokenInput.trim());
    setTok(tokenInput.trim());
    setError(null);
  };
  const logout = () => {
    clearToken();
    setTok("");
    setTokenInput("");
    setScripts([]);
    setSummary(null);
  };

  const handleCreate = async (scriptData) => {
    await apiJson("/api/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scriptData),
    });
    await fetchScripts();
    setShowCreate(false);
  };

  if (!authed) {
    return (
      <div style={styles.app}>
        <div style={styles.loginWrap}>
          <h1 style={styles.title}>pyRunner</h1>
          <p style={styles.subtitle}>Enter your API token to manage scripts.</p>
          <p style={styles.hint}>Set <code style={styles.code}>API_TOKEN</code> in docker-compose.yml, then paste it here. It is stored only in this browser (localStorage).</p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input
              style={{ ...styles.tokenInput, flex: 1 }}
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveToken()}
              placeholder="paste API_TOKEN"
            />
            <button style={styles.createBtn} onClick={saveToken}>Unlock</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>pyRunner</h1>
          <p style={styles.subtitle}>
            {summary
              ? `${summary.scripts_running}/${summary.scripts_total} running · apps CPU ${summary.apps_cpu}% · RAM ${summary.apps_ram_mb} MB`
              : `${scripts.length} script${scripts.length !== 1 ? "s" : ""}`}
            {summary?.host?.cpu_pct != null &&
              ` · host CPU ${summary.host.cpu_pct}% · MEM ${summary.host.mem_pct}%`}
            {" · refresh 5s"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={styles.ghostBtn} onClick={logout} title="Forget token">Lock</button>
          <button style={styles.createBtn} onClick={() => setShowCreate(true)}>+ New Script</button>
        </div>
      </header>

      {error && <div style={styles.error}>⚠ {error}</div>}

      <main style={styles.main}>
        {scripts.length === 0 && !error ? (
          <div style={styles.empty}>
            <p>No scripts found in <code style={styles.code}>/scripts</code>.</p>
            <p>Click <strong style={{ color: "#ccc" }}>+ New Script</strong> to create one.</p>
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
  loginWrap: { maxWidth: 520, margin: "12vh auto", padding: "28px", background: "#141414", border: "1px solid #222", borderRadius: 10 },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 28px 16px",
    borderBottom: "1px solid #1e1e1e",
    background: "#131313",
  },
  title: { margin: 0, fontSize: 24, fontWeight: 700, color: "#4a9eff", letterSpacing: "-0.5px" },
  subtitle: { margin: "4px 0 0", fontSize: 13, color: "#888" },
  hint: { fontSize: 12, color: "#777", lineHeight: 1.6 },
  tokenInput: { padding: "9px 12px", background: "#0c0c0c", border: "1px solid #333", borderRadius: 6, color: "#e0e0e0", fontSize: 13, fontFamily: "inherit", outline: "none" },
  createBtn: { padding: "9px 18px", background: "#1a6ef5", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600 },
  ghostBtn: { padding: "9px 14px", background: "transparent", color: "#888", border: "1px solid #2a2a2a", borderRadius: 7, cursor: "pointer", fontSize: 13, fontFamily: "inherit" },
  main: { padding: "20px 28px", display: "flex", flexDirection: "column", gap: 12 },
  error: { margin: "12px 28px 0", padding: "10px 14px", background: "#2a1010", border: "1px solid #5a2020", borderRadius: 7, color: "#f87171", fontSize: 13 },
  empty: { color: "#777", fontSize: 14, lineHeight: 1.8 },
  code: { background: "#1a1a1a", padding: "2px 6px", borderRadius: 4, color: "#aaa", fontSize: 13 },
};
