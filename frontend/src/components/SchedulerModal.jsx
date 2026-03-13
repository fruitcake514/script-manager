import { useState, useEffect } from "react";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ACTIONS = ["start", "stop", "restart"];

function emptyForm() {
  return {
    label: "",
    action: "start",
    time: "08:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    delay_seconds: 0,
    enabled: true,
  };
}

function fmtDelay(sec) {
  if (!sec || sec === 0) return "No delay";
  if (sec < 60) return `${sec}s delay`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m delay`;
  return `${Math.floor(sec / 3600)}h delay`;
}

function fmtDays(days) {
  if (!days || days.length === 7) return "Every day";
  if (days.length === 0) return "No days";
  if (JSON.stringify(days) === JSON.stringify([0,1,2,3,4])) return "Weekdays";
  if (JSON.stringify(days) === JSON.stringify([5,6])) return "Weekends";
  return days.map(d => DAYS[d]).join(", ");
}

export default function SchedulerModal({ scriptName, onClose }) {
  const [schedules, setSchedules] = useState([]);
  const [editing, setEditing]     = useState(null);   // null | "new" | sched object
  const [form, setForm]           = useState(emptyForm());
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState(null);

  useEffect(() => { fetchSchedules(); }, []);

  const fetchSchedules = async () => {
    const res = await fetch(`/api/scripts/${scriptName}/schedules`);
    setSchedules(await res.json());
  };

  const openNew = () => {
    setForm(emptyForm());
    setEditing("new");
    setError(null);
  };

  const openEdit = (s) => {
    setForm({ ...s });
    setEditing(s);
    setError(null);
  };

  const toggleDay = (d) => {
    setForm(f => ({
      ...f,
      days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d].sort(),
    }));
  };

  const setPreset = (preset) => {
    if (preset === "everyday")  setForm(f => ({ ...f, days: [0,1,2,3,4,5,6] }));
    if (preset === "weekdays")  setForm(f => ({ ...f, days: [0,1,2,3,4] }));
    if (preset === "weekends")  setForm(f => ({ ...f, days: [5,6] }));
  };

  const save = async () => {
    if (!form.time) { setError("Time is required"); return; }
    if (form.days.length === 0) { setError("Select at least one day"); return; }
    setSaving(true);
    setError(null);

    let res;
    if (editing === "new") {
      res = await fetch(`/api/scripts/${scriptName}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    } else {
      res = await fetch(`/api/scripts/${scriptName}/schedules/${editing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    }
    setSaving(false);
    if (res.ok) {
      await fetchSchedules();
      setEditing(null);
    } else {
      const d = await res.json();
      setError(d.error || "Save failed");
    }
  };

  const del = async (id) => {
    await fetch(`/api/scripts/${scriptName}/schedules/${id}`, { method: "DELETE" });
    await fetchSchedules();
  };

  const toggle = async (s) => {
    await fetch(`/api/scripts/${scriptName}/schedules/${s.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...s, enabled: !s.enabled }),
    });
    await fetchSchedules();
  };

  const actionColor = { start: "#22c55e", stop: "#ef4444", restart: "#f97316" };

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>

        {/* Header */}
        <div style={s.header}>
          <div>
            <span style={s.title}>Schedules</span>
            <span style={s.sub}> — {scriptName}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {!editing && (
              <button style={s.addBtn} onClick={openNew}>+ Add Schedule</button>
            )}
            <button style={s.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Edit / New form */}
        {editing && (
          <div style={s.form}>
            <div style={s.formGrid}>

              {/* Label */}
              <div style={s.field}>
                <label style={s.label}>Label (optional)</label>
                <input style={s.input} value={form.label}
                  onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  placeholder="e.g. Morning start" />
              </div>

              {/* Action */}
              <div style={s.field}>
                <label style={s.label}>Action</label>
                <div style={s.btnGroup}>
                  {ACTIONS.map(a => (
                    <button key={a} style={{
                      ...s.toggleBtn,
                      ...(form.action === a ? { background: actionColor[a] + "22", color: actionColor[a], borderColor: actionColor[a] } : {})
                    }} onClick={() => setForm(f => ({ ...f, action: a }))}>
                      {a === "start" ? "▶ Start" : a === "stop" ? "■ Stop" : "↺ Restart"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Time */}
              <div style={s.field}>
                <label style={s.label}>Time (24h, container local time)</label>
                <input style={{ ...s.input, width: 120 }} type="time" value={form.time}
                  onChange={e => setForm(f => ({ ...f, time: e.target.value }))} />
              </div>

              {/* Delay */}
              <div style={s.field}>
                <label style={s.label}>Delay after trigger</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input style={{ ...s.input, width: 80 }} type="number" min="0"
                    value={form.delay_seconds}
                    onChange={e => setForm(f => ({ ...f, delay_seconds: parseInt(e.target.value) || 0 }))} />
                  <span style={{ color: "#555", fontSize: 12 }}>seconds ({fmtDelay(form.delay_seconds)})</span>
                </div>
              </div>

              {/* Days */}
              <div style={{ ...s.field, gridColumn: "1 / -1" }}>
                <label style={s.label}>Days</label>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {DAYS.map((d, i) => (
                    <button key={i} style={{
                      ...s.dayBtn,
                      ...(form.days.includes(i) ? { background: "#0d1f35", color: "#4a9eff", borderColor: "#1a3a5c" } : {})
                    }} onClick={() => toggleDay(i)}>
                      {d}
                    </button>
                  ))}
                  <span style={{ color: "#333", fontSize: 11, margin: "0 4px" }}>|</span>
                  <button style={s.presetBtn} onClick={() => setPreset("everyday")}>Every day</button>
                  <button style={s.presetBtn} onClick={() => setPreset("weekdays")}>Weekdays</button>
                  <button style={s.presetBtn} onClick={() => setPreset("weekends")}>Weekends</button>
                </div>
              </div>

            </div>

            {error && <div style={s.error}>{error}</div>}

            <div style={s.formActions}>
              <button style={s.cancelBtn} onClick={() => setEditing(null)}>Cancel</button>
              <button style={s.saveBtn} onClick={save} disabled={saving}>
                {saving ? "Saving…" : editing === "new" ? "Add Schedule" : "Save Changes"}
              </button>
            </div>
          </div>
        )}

        {/* Schedule list */}
        <div style={s.list}>
          {schedules.length === 0 && !editing && (
            <div style={s.empty}>No schedules yet. Click <strong>+ Add Schedule</strong> to create one.</div>
          )}
          {schedules.map(s2 => (
            <div key={s2.id} style={{ ...s.schedRow, opacity: s2.enabled ? 1 : 0.45 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                {/* Toggle */}
                <button style={{ ...s.togglePill, background: s2.enabled ? "#14532d" : "#1a1a1a",
                  borderColor: s2.enabled ? "#166534" : "#2a2a2a", color: s2.enabled ? "#86efac" : "#555" }}
                  onClick={() => toggle(s2)} title={s2.enabled ? "Disable" : "Enable"}>
                  {s2.enabled ? "ON" : "OFF"}
                </button>

                {/* Action badge */}
                <span style={{ ...s.actionBadge, color: actionColor[s2.action],
                  borderColor: actionColor[s2.action] + "44", background: actionColor[s2.action] + "11" }}>
                  {s2.action}
                </span>

                {/* Time */}
                <span style={s.schedTime}>{s2.time}</span>

                {/* Days */}
                <span style={s.schedDays}>{fmtDays(s2.days)}</span>

                {/* Delay */}
                {s2.delay_seconds > 0 && (
                  <span style={s.schedDelay}>+{fmtDelay(s2.delay_seconds)}</span>
                )}

                {/* Label */}
                {s2.label && <span style={s.schedLabel}>{s2.label}</span>}
              </div>

              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button style={s.editSchedBtn} onClick={() => openEdit(s2)}>Edit</button>
                <button style={s.delSchedBtn} onClick={() => del(s2.id)}>✕</button>
              </div>
            </div>
          ))}
        </div>

        <div style={s.footer}>
          <span style={{ color: "#333", fontSize: 11 }}>
            Schedules use the container's local time. Checked every 30 seconds. Persisted across restarts.
          </span>
        </div>
      </div>
    </div>
  );
}

const FONT = "'JetBrains Mono', monospace";
const s = {
  overlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.82)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:300, fontFamily:FONT },
  modal:   { background:"#141414", border:"1px solid #222", borderRadius:10, width:"min(780px,96vw)", maxHeight:"90vh", display:"flex", flexDirection:"column", overflow:"hidden" },
  header:  { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 18px", borderBottom:"1px solid #1e1e1e", background:"#161616", flexShrink:0 },
  title:   { fontSize:15, fontWeight:700, color:"#e0e0e0" },
  sub:     { fontSize:13, color:"#555" },
  addBtn:  { padding:"6px 14px", background:"#1a6ef5", color:"#fff", border:"none", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:FONT, fontWeight:600 },
  closeBtn:{ background:"transparent", border:"none", color:"#555", cursor:"pointer", fontSize:15, fontFamily:FONT },

  form:     { padding:"16px 18px", borderBottom:"1px solid #1e1e1e", background:"#0f0f0f" },
  formGrid: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:"14px 20px" },
  field:    { display:"flex", flexDirection:"column", gap:6 },
  label:    { fontSize:10, color:"#555", textTransform:"uppercase", letterSpacing:"0.07em" },
  input:    { padding:"7px 10px", background:"#161616", border:"1px solid #2a2a2a", borderRadius:5, color:"#e0e0e0", fontSize:13, fontFamily:FONT, outline:"none" },
  btnGroup: { display:"flex", gap:6 },
  toggleBtn:{ padding:"5px 12px", background:"transparent", border:"1px solid #2a2a2a", color:"#555", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:FONT },
  dayBtn:   { padding:"4px 10px", background:"#111", border:"1px solid #2a2a2a", color:"#555", borderRadius:4, cursor:"pointer", fontSize:12, fontFamily:FONT },
  presetBtn:{ padding:"3px 8px", background:"transparent", border:"1px solid #1e1e1e", color:"#444", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:FONT },
  error:    { marginTop:10, padding:"7px 12px", background:"#2a1010", border:"1px solid #5a2020", borderRadius:5, color:"#f87171", fontSize:12 },
  formActions:{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:14 },
  cancelBtn:{ padding:"7px 14px", background:"transparent", border:"1px solid #2a2a2a", color:"#666", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:FONT },
  saveBtn:  { padding:"7px 16px", background:"#1a6ef5", color:"#fff", border:"none", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:FONT, fontWeight:600 },

  list:     { overflowY:"auto", flex:1, padding:"10px 14px", display:"flex", flexDirection:"column", gap:6 },
  empty:    { color:"#333", fontSize:13, padding:"20px 4px", textAlign:"center" },

  schedRow: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"9px 12px", background:"#0f0f0f", border:"1px solid #1a1a1a", borderRadius:6, gap:10 },
  togglePill:{ padding:"2px 8px", border:"1px solid", borderRadius:10, fontSize:10, fontWeight:700, cursor:"pointer", fontFamily:FONT, background:"transparent" },
  actionBadge:{ fontSize:11, fontWeight:700, textTransform:"uppercase", border:"1px solid", borderRadius:4, padding:"1px 7px" },
  schedTime:{ fontSize:14, fontWeight:700, color:"#e0e0e0", letterSpacing:"0.05em" },
  schedDays:{ fontSize:11, color:"#555" },
  schedDelay:{ fontSize:11, color:"#f97316", background:"#431407", border:"1px solid #7c2d12", borderRadius:4, padding:"1px 6px" },
  schedLabel:{ fontSize:11, color:"#4a4a4a", fontStyle:"italic", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:160 },
  editSchedBtn:{ padding:"3px 10px", background:"#0d1f35", color:"#4a9eff", border:"1px solid #1a3a5c", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:FONT },
  delSchedBtn: { padding:"3px 8px", background:"#2a1010", color:"#f87171", border:"1px solid #5a2020", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:FONT },

  footer: { padding:"10px 18px", borderTop:"1px solid #1a1a1a", background:"#0f0f0f", flexShrink:0 },
};
