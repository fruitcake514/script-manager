// Central API helper: token auth + safe URL encoding for names/paths.
const KEY = "sm_token";

export function getToken() {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}
export function setToken(t) {
  try { localStorage.setItem(KEY, t); } catch {}
}
export function clearToken() {
  try { localStorage.removeItem(KEY); } catch {}
}

export const encName = (n) => encodeURIComponent(n);
export const encPath = (p) =>
  String(p || "").split("/").map((s) => encodeURIComponent(s)).join("/");

export async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = getToken();
  if (t) headers["X-API-Token"] = t;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    const e = new Error("Unauthorized — check API token");
    e.code = 401;
    throw e;
  }
  if (res.status === 429) throw new Error("Rate limited — slow down");
  return res;
}

export async function apiJson(path, opts = {}) {
  const res = await apiFetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
