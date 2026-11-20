/* Pixel Trivia — progress rules: XP and player level, subject stars and difficulty, the daily
   streak, badges, personal bests and the spaced-review queue (a simple Leitner system). */
import { SUBJECTS, BADGES } from "./data.js";

const DAY = 864e5;
export const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* ---------- player level ---------- */
/* Level n -> n+1 costs 100 + 50(n-1) XP: 100, 150, 200, … */
export function levelInfo(xp){
  let lvl = 1, base = 0, need = 100;
  while (xp >= base + need){ base += need; lvl++; need = 100 + 50 * (lvl - 1); }
  return { lvl, into: xp - base, need, pct: Math.round((xp - base) / need * 100) };
}

/* ---------- subjects ---------- */
export const STAR_XP = [60, 180, 400, 750, 1200];
export function subj(P, id){
  if (!P.subj[id]) P.subj[id] = { xp: 0, recent: [], lessons: [], correct: 0, answered: 0 };
  return P.subj[id];
}
export const stars = (P, id) => STAR_XP.filter(x => (P.subj[id] ? P.subj[id].xp : 0) >= x).length;

/* Difficulty follows the subject's stars, nudged by the last ten answers in that subject. */
export function tier(P, id){
  const s = subj(P, id);
  // 0-1 stars easy, 2-3 medium, 4-5 hard; the placement round can start a subject at medium.
  let t = Math.max(s.start || 0, Math.min(2, Math.floor(stars(P, id) / 2)));
  const r = s.recent.slice(-10);
  if (r.length >= 6){
    const acc = r.reduce((a, b) => a + b, 0) / r.length;
    if (acc >= 0.85) t = Math.min(2, t + 1);
    else if (acc <= 0.4) t = Math.max(0, t - 1);
  }
  return ["easy", "medium", "hard"][t];
}

/* Next topic to learn: the first one not yet done (after all are done, the least recent). */
export function nextTopic(P, sub){
  const s = subj(P, sub.id);
  const left = sub.topics.filter(t => !s.lessons.includes(t));
  return left.length ? left[0] : s.lessons[0] || sub.topics[0];
}

/* A subject to suggest on the home screen: favourites first, then whichever is least played. */
export function suggestSubject(P, favs){
  const pool = (favs && favs.length ? favs : SUBJECTS.map(s => s.id));
  const today = dayKey();
  return pool.slice().sort((a, b) => {
    const la = (P.subj[a] && P.subj[a].lastDay) === today ? 1 : 0, lb = (P.subj[b] && P.subj[b].lastDay) === today ? 1 : 0;
    return la - lb || (P.subj[a] ? P.subj[a].lessons.length : 0) - (P.subj[b] ? P.subj[b].lessons.length : 0);
  })[0];
}

/* ---------- answers, XP, streak ---------- */
export function recordAnswer(P, subId, correct){
  const s = subj(P, subId);
  s.answered++; if (correct) s.correct++;
  s.recent.push(correct ? 1 : 0); if (s.recent.length > 20) s.recent.splice(0, s.recent.length - 20);
  P.stats.answered++; if (correct) P.stats.correct++;
}
export function addXP(P, subId, n){
  const before = levelInfo(P.xp).lvl, sb = subId ? stars(P, subId) : 0;
  P.xp += n;
  if (subId){ subj(P, subId).xp += n; subj(P, subId).lastDay = dayKey(); }
  return { levelUp: levelInfo(P.xp).lvl > before ? levelInfo(P.xp).lvl : 0, starUp: subId && stars(P, subId) > sb ? stars(P, subId) : 0 };
}
/* Call once per finished lesson or round. Returns true when the streak grew today. */
export function touchStreak(P){
  const today = dayKey(), st = P.streak;
  if (st.last === today) return false;
  const yesterday = dayKey(startOfDay() - DAY / 2);
  st.count = st.last === yesterday ? st.count + 1 : 1;
  st.best = Math.max(st.best, st.count);
  st.last = today;
  return true;
}
export const streakAlive = P => P.streak.last === dayKey() || P.streak.last === dayKey(startOfDay() - DAY / 2);

/* ---------- badges ---------- */
export function award(P, id){
  if (P.badges[id]) return null;
  P.badges[id] = Date.now();
  return BADGES.find(b => b.id === id) || null;
}
/* Check the badges that depend on totals; round-specific ones are awarded where they happen. */
export function checkBadges(P){
  const got = [];
  const give = id => { const b = award(P, id); if (b) got.push(b); };
  if (P.stats.lessons >= 1) give("first_lesson");
  if (P.stats.lessons >= 10) give("scholar");
  if (Object.values(P.subj).filter(s => s.lessons.length).length >= 5) give("polymath");
  if (P.streak.count >= 3) give("streak3");
  if (P.streak.count >= 7) give("streak7");
  if (P.stats.mastered >= 10) give("reviewer");
  if (SUBJECTS.some(s => stars(P, s.id) >= 5)) give("master");
  if (P.stats.bestCombo >= 10) give("combo10");
  return got;
}

/* ---------- personal bests ---------- */
/* Returns the new entry's rank (0 = top) or -1 if it didn't make the top ten. */
export function addBest(P, entry){
  const e = { ...entry, ts: Date.now() };
  P.bests.push(e);
  P.bests.sort((a, b) => b.score - a.score);
  P.bests = P.bests.slice(0, 10);
  return P.bests.indexOf(e);
}

/* ---------- seen questions (no repeats) ---------- */
export const qkey = q => String(q).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function markSeen(P, subId, q){
  const list = P.seen[subId] || (P.seen[subId] = []);
  const k = qkey(q);
  if (!list.includes(k)) list.push(k);
  if (list.length > 60) list.splice(0, list.length - 60);
}
export const seenList = (P, subId) => (P.seen[subId] || []).slice(-30);

/* ---------- spaced review (Leitner boxes) ---------- */
/* A missed question enters box 1 and comes back tomorrow. Each correct review moves it up a box
   (3, 7 and 14 days later); after the fourth correct review it is mastered and leaves the queue.
   A wrong review sends it back to box 1. */
const GAPS = [0, 1, 3, 7, 14];
export function addToReview(R, q, subId){
  const k = qkey(q.q);
  const ex = R.items.find(i => qkey(i.q) === k);
  const due = startOfDay() + DAY + 3600e3 * 4;                 // tomorrow, 4am local
  if (ex){ ex.box = 1; ex.due = due; return; }
  R.items.push({ id: k.slice(0, 40) + ":" + R.items.length, q: q.q, a: q.a, wrong: q.wrong, exp: q.exp || "", hint: q.hint || "", sub: subId, box: 1, due, added: Date.now() });
  if (R.items.length > 150) R.items.splice(0, R.items.length - 150);
}
/* Returns true when the card was mastered (and removed). */
export function reviewResult(R, P, item, correct){
  const it = R.items.find(i => i.id === item.id);
  if (!it) return false;
  if (!correct){ it.box = 1; it.due = startOfDay() + DAY + 3600e3 * 4; return false; }
  it.box++;
  if (it.box >= GAPS.length){ R.items = R.items.filter(i => i !== it); P.stats.mastered++; return true; }
  it.due = startOfDay() + DAY * GAPS[it.box] + 3600e3 * 4;
  return false;
}
export const dueItems = (R, subId) => R.items.filter(i => i.due <= Date.now() && (!subId || i.sub === subId)).sort((a, b) => a.due - b.due);
export const nextDue = R => R.items.reduce((m, i) => Math.min(m, i.due), Infinity);
