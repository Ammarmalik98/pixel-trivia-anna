/* Pixel Trivia — challenges between friends, with no server.
   A challenge code carries the exact quiz (questions in display order) plus the challenger's
   score. The friend pastes it, plays the same questions, and gets a reply code to send back, so
   both players' rivals boards record the result. Codes are compressed JSON in base64url:
     PXT1.<…>  challenge        PXR1.<…>  reply           (…0 = uncompressed, for old browsers)
   Scores in codes can't be verified without a server. That's fine between friends; a future
   server (see README, "Route B") would replace encode/decode with real accounts and boards. */
import { validateQuestion } from "./ai.js";

const MAX_QS = 15;

const b64u = bytes => { let s = ""; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = str => { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); };
const canZip = typeof CompressionStream === "function" && typeof DecompressionStream === "function";

async function pipe(bytes, Stream){
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new Stream("deflate-raw")));
  return new Uint8Array(await out.arrayBuffer());
}
async function encode(kind, obj){
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (canZip){ try { return `${kind}1.` + b64u(await pipe(raw, CompressionStream)); } catch(e){} }
  return `${kind}0.` + b64u(raw);
}
async function decode(text){
  const m = String(text || "").match(/\b(PX[TR])([01])\.([A-Za-z0-9_-]{8,})/);
  if (!m) throw new Error("No Pixel Trivia code found. Paste the whole message your friend sent.");
  let bytes;
  try { bytes = unb64u(m[3]); } catch(e){ throw new Error("That code looks cut off. Ask your friend to send it again."); }
  if (m[2] === "1"){
    if (!canZip) throw new Error("This browser can't open compressed codes. Try Anna's desktop or mobile app.");
    try { bytes = await pipe(bytes, DecompressionStream); } catch(e){ throw new Error("That code looks cut off. Ask your friend to send it again."); }
  }
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(bytes)); } catch(e){ throw new Error("That code is damaged. Ask your friend to send it again."); }
  return { kind: m[1] === "PXT" ? "challenge" : "reply", obj };
}

const s = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
const who = f => ({ pid: s(f && f.pid, 16), n: s(f && f.n, 10).toUpperCase() || "???", av: s(f && f.av, 12) || "cat" });

/* ---------- create ---------- */
export async function makeChallenge(profile, round){
  const qs = round.qs.slice(0, MAX_QS).map(q => ({ q: q.q, a: q.a, o: q.o, e: (q.exp || "").slice(0, 200) }));
  const payload = { v: 1, id: round.cid, from: { pid: profile.pid, n: profile.name, av: profile.avatar }, sub: round.label, qs, sc: round.score, r: round.right, rr: round.marks, tl: round.time, ts: Date.now() };
  return encode("PXT", payload);
}
export async function makeReply(profile, challenge, result){
  return encode("PXR", { v: 1, cid: challenge.id, from: { pid: profile.pid, n: profile.name, av: profile.avatar }, sc: result.score, r: result.right, rr: result.marks, ts: Date.now() });
}
export function shareText(kind, profile, info, code){
  if (kind === "challenge") return `${profile.name} challenged you to Pixel Trivia: ${info.label}, ${info.n} questions. Beat ${info.score.toLocaleString()} points!\nOpen Pixel Trivia on Anna, go to CHALLENGES and paste this message:\n\n${code}`;
  return `${profile.name} played your Pixel Trivia challenge (${info.label}) and scored ${info.score.toLocaleString()}.\nOpen Pixel Trivia on Anna, go to CHALLENGES and paste this message to see who won:\n\n${code}`;
}

/* ---------- read ---------- */
/* Decodes and sanity-checks a pasted code. Returns {kind:"challenge", c} or {kind:"reply", r}. */
export async function readCode(text){
  const { kind, obj } = await decode(text);
  if (!obj || obj.v !== 1) throw new Error("This code comes from a newer Pixel Trivia. Update the app and try again.");
  if (kind === "reply"){
    return { kind, r: { cid: s(obj.cid, 40), from: who(obj.from), sc: num(obj.sc, 0, 1e7), r: num(obj.r, 0, MAX_QS), rr: (Array.isArray(obj.rr) ? obj.rr : []).slice(0, MAX_QS).map(x => x ? 1 : 0), ts: num(obj.ts, 0, 9e15) } };
  }
  const qs = (Array.isArray(obj.qs) ? obj.qs : []).slice(0, MAX_QS).map(q => {
    const o = (Array.isArray(q && q.o) ? q.o : []).map(x => s(x, 90));
    const v = validateQuestion({ q: q && q.q, a: q && q.a, wrong: o.filter(x => x !== s(q && q.a, 90)) });
    if (!v || o.length !== 4 || !o.includes(v.a)) return null;
    return { q: v.q, a: v.a, o, exp: s(q.e, 220) };
  }).filter(Boolean);
  if (qs.length < 3) throw new Error("This challenge doesn't contain enough playable questions.");
  return { kind, c: { id: s(obj.id, 40), from: who(obj.from), sub: s(obj.sub, 60) || "Challenge", qs, sc: num(obj.sc, 0, 1e7), r: num(obj.r, 0, MAX_QS), rr: (Array.isArray(obj.rr) ? obj.rr : []).slice(0, qs.length).map(x => x ? 1 : 0), tl: num(obj.tl, 8, 30) || 15, ts: num(obj.ts, 0, 9e15) } };
}

/* ---------- rivals board ---------- */
export function recordRival(social, other, mine, theirs){
  const r = social.rivals[other.pid] || (social.rivals[other.pid] = { n: other.n, av: other.av, w: 0, l: 0, t: 0, last: 0 });
  r.n = other.n; r.av = other.av; r.last = Date.now();
  const res = mine > theirs ? "w" : mine < theirs ? "l" : "t";
  r[res]++;
  return res;
}
export const rivalsList = social => Object.entries(social.rivals).map(([pid, r]) => ({ pid, ...r })).sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w || b.last - a.last);

/* ---------- share / copy ---------- */
export async function share(anna, text){
  if (anna && anna.mobile && anna.mobile.share){
    try { const r = await anna.mobile.share({ title: "Pixel Trivia challenge", text }); if (r && r.shared !== undefined) return r.shared ? "shared" : "cancelled"; } catch(e){}
  }
  if (navigator.share){
    try { await navigator.share({ title: "Pixel Trivia challenge", text }); return "shared"; } catch(e){ if (e && e.name === "AbortError") return "cancelled"; }
  }
  return "unavailable";
}
export async function copy(text, textarea){
  try { await navigator.clipboard.writeText(text); return true; } catch(e){}
  if (textarea){
    textarea.focus(); textarea.select();
    try { if (document.execCommand("copy")) return true; } catch(e){}
  }
  return false;
}
