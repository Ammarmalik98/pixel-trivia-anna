/* Pixel Trivia — storage. Inside Anna everything is saved to the player's Anna account
   (anna.storage, the app's own bucket), so progress follows them across devices. In a plain
   browser preview the same documents go to localStorage instead.

   Four documents, all under "pixeltrivia/":
     profile   name, avatar, favourite subjects, player id, settings
     progress  XP, per-subject progress, daily streak, badges, stats, personal bests, seen questions
     review    missed questions waiting for spaced review
     social    challenges sent / received and the rivals board                                    */

const PREFIX = "pixeltrivia/";
export const DOCS = ["profile", "progress", "review", "social"];

function annaStore(rt){
  return {
    kind: "anna",
    async get(key){ const r = await rt.storage.get({ key: PREFIX + key }); return r && r.exists !== false && r.value !== undefined ? r.value : null; },
    async set(key, value){ await rt.storage.set({ key: PREFIX + key, value }); },
    async del(key){ try { await rt.storage.delete({ key: PREFIX + key }); } catch(e){ if (!/not.?found|404/i.test(String(e && (e.code || e.message)))) throw e; } }
  };
}
const localStore = {
  kind: "local",
  async get(key){ try { const v = localStorage.getItem(PREFIX + key); return v == null ? null : JSON.parse(v); } catch(e){ return null; } },
  async set(key, value){ try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch(e){ const err = new Error("quota"); err.code = "quota"; throw err; } },
  async del(key){ try { localStorage.removeItem(PREFIX + key); } catch(e){} }
};

const rid = n => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; const b = new Uint8Array(n); crypto.getRandomValues(b); b.forEach(x => s += a[x % a.length]); return s; };
export const newId = rid;

export const defaults = {
  profile: () => ({ v: 1, pid: rid(10), name: "", avatar: "cat", favs: [], setupDone: false, created: Date.now(), sound: true, readAloud: false }),
  progress: () => ({ v: 1, xp: 0, subj: {}, streak: { count: 0, best: 0, last: "" }, badges: {}, stats: { lessons: 0, rounds: 0, perfect: 0, mastered: 0, bestCombo: 0, answered: 0, correct: 0 }, bests: [], seen: {}, learned: {} }),
  review: () => ({ v: 1, items: [] }),
  social: () => ({ v: 1, sent: [], received: [], rivals: {} })
};

/* Fill in any fields a document is missing (older saves, partial writes). */
function normalize(name, doc){
  const d = defaults[name]();
  if (!doc || typeof doc !== "object") return d;
  for (const k of Object.keys(d)) if (doc[k] === undefined || doc[k] === null || typeof doc[k] !== typeof d[k] || Array.isArray(d[k]) !== Array.isArray(doc[k])) doc[k] = d[k];
  if (name === "progress"){ doc.stats = { ...d.stats, ...doc.stats }; doc.streak = { ...d.streak, ...doc.streak }; }
  return doc;
}

export function createStore(anna, onError){
  const backend = anna ? annaStore(anna) : localStore;
  const S = {};
  const timers = {}, dirty = new Set();
  let failing = false;

  async function flush(name){
    clearTimeout(timers[name]);
    if (!dirty.has(name)) return;
    dirty.delete(name);
    try { await backend.set(name, S[name]); if (failing){ failing = false; onError && onError(null); } }
    catch(e){
      dirty.add(name); failing = true;
      onError && onError(e);
      timers[name] = setTimeout(() => flush(name), 8000);   // keep retrying quietly
    }
  }
  return {
    kind: backend.kind,
    S,
    async load(){
      const docs = await Promise.all(DOCS.map(n => backend.get(n)));
      DOCS.forEach((n, i) => { S[n] = normalize(n, docs[i]); });
      return S;
    },
    save(name, now){ dirty.add(name); clearTimeout(timers[name]); if (now) return flush(name); timers[name] = setTimeout(() => flush(name), 500); },
    flushAll(){ return Promise.all(DOCS.map(flush)); },
    async reset(){ for (const n of DOCS){ S[n] = defaults[n](); await backend.del(n); } }
  };
}
