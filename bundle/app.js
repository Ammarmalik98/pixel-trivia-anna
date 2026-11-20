/* Pixel Trivia — Anna Edition.
   A learn-then-quiz arcade game. Bit, the pixel-owl quizmaster, writes a bite-size lesson on a
   topic, then a fact-checked quiz on it (Anna's AI, through the bundled "quizmaster" backend tool).
   Progress (XP, levels, streaks, badges, review pile, rivals) is saved to the player's Anna account.
   Opened outside Anna (a plain browser preview) it saves to this browser and plays the built-in deck.
   CSP-safe: no inline scripts, no inline style attributes. */
import { SUBJECTS, SUBJECT, DECK, BADGES } from "./lib/data.js";
import { bitSVG, avatarSVG, AVATARS } from "./lib/sprites.js";
import { createStore } from "./lib/store.js";
import * as PG from "./lib/progress.js";
import { createAI, aiErrorText } from "./lib/ai.js";
import * as SOC from "./lib/social.js";
import { SFX, setMuted, initFX, burst, haptic } from "./lib/fx.js";

const SDK_URL = "/static/anna-apps/_sdk/latest/index.js";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const app = $("#app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shuf = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--){ const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "S"}`;
const fmt = n => Number(n || 0).toLocaleString("en-US");

let anna = null, ai = null, store = null, S = null;
let G = null, timer = null;          // the current round and its countdown
let screen = "", loadTok = null;     // current screen; token that cancels a pending load
let qlen = 10;                       // quick-quiz length
const P = () => S.progress, R = () => S.review;
const save = (...names) => names.forEach(n => store.save(n));

/* ============ small UI helpers ============ */
function render(html, name = ""){
  if (name !== "quiz") clearInterval(timer);
  app.innerHTML = html; screen = name;
  window.scrollTo(0, 0);
}
function on(sel, fn){ const el = $(sel); if (el) el.addEventListener("click", e => { SFX.click(); fn(e); }); return el; }
function onAll(sel, fn){ $$(sel).forEach(el => el.addEventListener("click", e => { SFX.click(); fn(el, e); })); }
const topbar = (title, back = "BACK") => `<div class="topbar"><button class="back" id="back" type="button">◀ ${back}</button><span class="t">${esc(title)}</span></div>`;
const starsHTML = n => `<span class="stars" aria-label="${n} of 5 stars">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`;
const catBtn = s => `<button class="cat" type="button" data-c="${s.id}"><span class="ic" aria-hidden="true">${s.ic}</span><span class="nm">${esc(s.n)}</span>${starsHTML(PG.stars(P(), s.id))}</button>`;
const spinner = `<div class="spinner" aria-hidden="true"><i></i><i></i><i></i></div>`;

let toastT = 0;
function toast(msg, ms = 2800){
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}

let modalResolve = null;
function modal({ title, body = "", buttons = [{ label: "OK", value: true, cls: "big calm" }] }){
  const box = $("#modalBox");
  box.innerHTML = `<h3 id="modalTitle">${esc(title)}</h3><div class="small">${body}</div><div class="row-btns">${buttons.map((b, i) => `<button type="button" class="${b.cls || "c"}" data-mi="${i}">${esc(b.label)}</button>`).join("")}</div>`;
  $("#modal").hidden = false;
  return new Promise(res => {
    modalResolve = v => { $("#modal").hidden = true; modalResolve = null; res(v); };
    box.querySelectorAll("[data-mi]").forEach(b => b.addEventListener("click", () => { SFX.click(); modalResolve(buttons[+b.dataset.mi].value); }));
    const first = box.querySelector("[data-mi]"); if (first) first.focus();
  });
}
const confirmBox = (title, body, yes = "YES", no = "NO") => modal({ title, body: esc(body), buttons: [{ label: no, value: false }, { label: yes, value: true, cls: "big calm" }] });

function loading(msg, onCancel){
  const tok = {}; loadTok = tok;
  render(`<div class="boot center"><div class="says">${bitSVG("lg bob")}<div class="bubble">${esc(msg)}</div></div>${spinner}
    ${onCancel ? `<div class="row-btns"><button class="ghost" id="cancel" type="button">CANCEL</button></div>` : ""}</div>`, "loading");
  if (onCancel) on("#cancel", () => { loadTok = null; onCancel(); });
  return tok;
}
const live = tok => tok && tok === loadTok;

/* ============ question helpers ============ */
const mkQ = (raw, sub, src) => ({ q: raw.q, a: raw.a, o: shuf([raw.a, ...raw.wrong]), exp: raw.exp || "", hint: raw.hint || "", sub, src });
function deckQs(subId, n, exclude = new Set()){
  const seen = new Set((P().seen[subId] || []));
  const list = (DECK[subId] || []).map(([q, a, wrong]) => ({ q, a, wrong })).filter(q => !exclude.has(PG.qkey(q.q)));
  const fresh = shuf(list.filter(q => !seen.has(PG.qkey(q.q)))), old = shuf(list.filter(q => seen.has(PG.qkey(q.q))));
  return fresh.concat(old).slice(0, n).map(q => mkQ(q, subId, "deck"));
}
const subName = id => (SUBJECT[id] || { n: "Mixed" }).n;
function srcLabel(q){
  return { ai: G && G.checked ? "BY BIT · FACT-CHECKED" : "BY BIT", deck: "BUILT-IN DECK", review: "REVIEW CARD", challenge: "FRIEND'S CHALLENGE" }[q.src] || "";
}

/* ============ onboarding ============ */
function onboardName(editing){
  const pr = S.profile;
  let pick = pr.avatar || "cat";
  render(`${editing ? topbar("NAME & AVATAR") : "<h1>PIXEL<br>TRIVIA</h1>"}
    <div class="says">${bitSVG("lg bob")}<div class="bubble">${editing ? "New look? Pick a name and an avatar." : "Hoot! I'm Bit. I teach you bite-size facts, then quiz you on them. What should I call you?"}</div></div>
    <div class="box">
      <label class="small" for="nm">YOUR NAME (UP TO 10 LETTERS)</label>
      <input id="nm" class="name" maxlength="10" autocomplete="off" spellcheck="false" value="${esc(pr.name)}">
      <h3 class="center">PICK YOUR AVATAR</h3>
      <div class="avatars">${AVATARS.map(a => `<button type="button" data-av="${a.id}" class="${a.id === pick ? "on" : ""}" aria-label="${a.n}" aria-pressed="${a.id === pick}">${avatarSVG(a.id, "av")}</button>`).join("")}</div>
    </div>
    <div class="row-btns"><button class="big calm" id="go" type="button">${editing ? "SAVE" : "NEXT ▶"}</button></div>`, "onboard");
  if (editing) on("#back", profileScreen);
  onAll("[data-av]", b => { pick = b.dataset.av; $$("[data-av]").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }); });
  const nm = $("#nm"); if (!editing) nm.focus();
  const go = () => {
    const name = nm.value.toUpperCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 10);
    if (!name){ toast("Type a name first."); nm.focus(); return; }
    pr.name = name; pr.avatar = pick; save("profile");
    editing ? profileScreen() : onboardSubjects();
  };
  on("#go", go);
  nm.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
}

function onboardSubjects(editing){
  const picked = new Set(S.profile.favs);
  render(`${editing ? topbar("FAVOURITE SUBJECTS") : ""}
    <div class="says">${bitSVG()}<div class="bubble">${editing ? "Your favourites shape Today's Quest." : `Nice to meet you, ${esc(S.profile.name)}! Which subjects do you like? Pick at least three.`}</div></div>
    <div class="grid subs">${SUBJECTS.map(s => `<button class="cat${picked.has(s.id) ? " on" : ""}" type="button" data-c="${s.id}" aria-pressed="${picked.has(s.id)}"><span class="ic" aria-hidden="true">${s.ic}</span><span class="nm">${esc(s.n)}</span></button>`).join("")}</div>
    <div class="row-btns"><button class="big calm" id="go" type="button"></button></div>`, "onboard");
  if (editing) on("#back", profileScreen);
  const upd = () => { const b = $("#go"); b.disabled = picked.size < 3; b.textContent = picked.size < 3 ? `PICK ${3 - picked.size} MORE` : (editing ? "SAVE" : "NEXT ▶"); };
  onAll("[data-c]", b => { const id = b.dataset.c; picked.has(id) ? picked.delete(id) : picked.add(id); b.classList.toggle("on", picked.has(id)); b.setAttribute("aria-pressed", String(picked.has(id))); upd(); });
  upd();
  on("#go", () => { S.profile.favs = SUBJECTS.map(s => s.id).filter(id => picked.has(id)); save("profile"); editing ? profileScreen() : onboardPlacement(); });
}

function onboardPlacement(){
  render(`<div class="says">${bitSVG("lg bob")}<div class="bubble">Last step: a 5-question placement round, so I can pitch lessons at your level. No pressure, and no hints in this one!</div></div>
    <div class="row-btns"><button class="big" id="go" type="button">START ▶</button><button class="c" id="skip" type="button">SKIP</button></div>`, "onboard");
  on("#go", () => {
    const favs = S.profile.favs.length ? S.profile.favs : ["science", "history", "geography"];
    const qs = [], used = new Set();
    for (let i = 0; qs.length < 5 && i < 20; i++){
      const sid = favs[i % favs.length];
      const q = deckQs(sid, 1, used)[0];
      if (q){ used.add(PG.qkey(q.q)); qs.push(q); }
    }
    startRound(newRound({ mode: "placement", label: "Placement", qs, time: 20 }));
  });
  on("#skip", () => finishSetup([]));
}

function finishSetup(lines){
  S.profile.setupDone = true; save("profile", "progress");
  render(`<h1>ALL SET!</h1>
    <div class="says">${bitSVG("lg bob")}<div class="bubble">${lines.length ? esc(lines.join(" ")) : "I'll start everything at EASY and adjust as you play."} Every day there's a quest: a short lesson, then a quiz on it.</div></div>
    <div class="row-btns"><button class="big" id="go" type="button">LET'S PLAY ▶</button></div>`, "onboard");
  on("#go", home);
}

/* ============ home ============ */
function bitLine(due){
  const p = P(), st = p.streak;
  if (due) return `${plural(due, "review card").toLowerCase()} ${due === 1 ? "is" : "are"} due. Quick wins, and they lock facts in for good!`;
  if (st.count > 0 && PG.streakAlive(p) && st.last !== PG.dayKey()) return `Play today to keep your ${st.count}-day streak alive!`;
  if (!p.stats.lessons) return "Start with Today's Quest: a short lesson, then a quiz on what you just learned.";
  const lines = ["Knowledge is the best power-up.", "Every lesson makes the next quiz easier.", "Try a subject you've never played. You might surprise yourself!", "Missed something? It comes back in REVIEW until you master it.", "Beat a friend: finish a quiz and tap CHALLENGE A FRIEND."];
  return lines[Math.random() * lines.length | 0];
}
function home(){
  if (!S.profile.setupDone) return onboardName();
  const p = P(), pr = S.profile, L = PG.levelInfo(p.xp);
  const due = PG.dueItems(R()).length;
  const sid = PG.suggestSubject(p, pr.favs), sub = SUBJECT[sid], topic = PG.nextTopic(p, sub);
  const nb = Object.keys(p.badges).length;
  const streakTxt = p.streak.count && PG.streakAlive(p) ? `STREAK ${plural(p.streak.count, "DAY")}${p.streak.last === PG.dayKey() ? " ✓" : ""}` : "STREAK 0";
  render(`
    <div class="box player">${avatarSVG(pr.avatar, "av lg")}
      <div class="who"><div class="nm">${esc(pr.name)}</div><div class="small">LEVEL ${L.lvl} · ${fmt(p.xp)} XP</div>
        <div class="xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${L.pct}" aria-label="XP to next level"><i id="xpb"></i></div>
        <div class="statline"><span class="pinkc">${streakTxt}</span><span>BADGES ${nb}/${BADGES.length}</span></div></div></div>
    <div class="says">${bitSVG()}<div class="bubble">${esc(bitLine(due))}</div></div>
    <div class="grid"><button class="big" id="quest" type="button">▶ TODAY'S QUEST<br><span class="small">${esc(sub.n)}: ${esc(topic)}</span></button></div>
    <div class="grid three">
      <button class="c" id="review" type="button">REVIEW${due ? ` (${due})` : ""}</button>
      <button class="c" id="quick" type="button">QUICK QUIZ</button>
      <button class="c" id="chal" type="button">CHALLENGES</button>
      <button class="c" id="scores" type="button">SCORES</button>
      <button class="c" id="prof" type="button">PROFILE</button>
      <button class="c" id="help" type="button">HOW TO PLAY</button>
    </div>
    <h2>SUBJECTS</h2>
    <div class="grid subs">${SUBJECTS.map(catBtn).join("")}</div>
    ${ai ? "" : `<p class="tag">PREVIEW MODE: lessons and Bit's questions switch on when Pixel Trivia runs inside Anna. Quizzes here use the built-in deck.</p>`}`, "home");
  $("#xpb").style.width = L.pct + "%";
  on("#quest", () => ai ? learn(sid, topic) : startQuick(sid));
  on("#review", reviewStart);
  on("#quick", () => quickMenu());
  on("#chal", challengesScreen);
  on("#scores", scoresScreen);
  on("#prof", profileScreen);
  on("#help", howTo);
  onAll("[data-c]", b => subjectScreen(b.dataset.c));
}

function howTo(){
  modal({ title: "HOW TO PLAY", body: `<p><span class="gold">LEARN.</span> Bit writes a short lesson: four fact cards, each with a memory trick.</p>
    <p><span class="gold">QUIZ.</span> Then a quiz on what you just read. Answer with a tap or keys 1-4. Fast answers and combos score more. A hint (H) removes two options but halves the points.</p>
    <p><span class="gold">REVIEW.</span> Missed questions come back the next day, then 3, 7 and 14 days later, until you master them.</p>
    <p><span class="gold">GROW.</span> Earn XP, level up, collect stars in each subject and keep a daily streak. Lessons get harder as you improve.</p>
    <p><span class="gold">CHALLENGE.</span> After a quiz, send a friend a code. They play the same questions, and the result lands on both rivals boards.</p>` });
}

/* ============ subject ============ */
function subjectScreen(id){
  const sub = SUBJECT[id], p = P(), s = PG.subj(p, id), nxt = PG.nextTopic(p, sub);
  const acc = s.answered ? Math.round(s.correct / s.answered * 100) + "%" : "-";
  render(`${topbar(sub.n)}
    <div class="box"><div class="player"><span class="cat-ic big-num" aria-hidden="true">${sub.ic}</span><div class="who">${starsHTML(PG.stars(p, id))}
      <div class="statline"><span>${fmt(s.xp)} XP</span><span>LEVEL ${PG.tier(p, id).toUpperCase()}</span><span>ACCURACY ${acc}</span><span>LESSONS ${s.lessons.length}/${sub.topics.length}</span></div></div></div></div>
    <div class="grid two"><button class="big calm" id="learn" type="button"${ai ? "" : " disabled"}>LEARN ▶<br><span class="small">${esc(nxt)}</span></button><button class="c" id="qq" type="button">QUICK QUIZ<br><span class="small dim">${ai ? "fresh questions" : "built-in deck"}</span></button></div>
    ${ai ? "" : `<p class="tag">Lessons need Anna's AI: open Pixel Trivia inside Anna.</p>`}
    <h2>TOPICS</h2>
    <div class="topics">${sub.topics.map(t => `<button class="topic" type="button" data-t="${esc(t)}"${ai ? "" : " disabled"}><span>${esc(t)}</span><span class="tick">${s.lessons.includes(t) ? "✓ DONE" : ""}</span></button>`).join("")}</div>`, "subject");
  on("#back", home);
  on("#learn", () => learn(id, nxt));
  on("#qq", () => startQuick(id));
  onAll("[data-t]", b => learn(id, b.dataset.t));
}

/* ============ learn ============ */
async function learn(subId, topic){
  if (!ai) return toast("Lessons need Anna's AI. Open Pixel Trivia inside Anna.");
  const sub = SUBJECT[subId], p = P(), level = PG.tier(p, subId);
  const tok = loading(`Bit is writing your lesson on ${topic}...`, () => subjectScreen(subId));
  const lkey = subId + "|" + topic;
  let lesson;
  try { lesson = await ai.lesson({ subject: sub.n, topic, level, cards: 4, avoid: (p.learned[lkey] || []).slice(-20) }); }
  catch(e){ if (live(tok)) aiError(e, () => learn(subId, topic), () => subjectScreen(subId), subId); return; }
  if (!live(tok)) return;
  const text = lesson.cards.map(c => `${c.title}: ${c.fact}`).join("\n");
  const quiz = { done: false };
  quiz.p = ai.quiz({ subject: sub.n, topic, level, count: 5, lesson: text, avoid: PG.seenList(p, subId) })
    .then(r => { quiz.done = true; return r; }, e => { quiz.done = true; return { error: e, questions: [] }; });
  showCard({ sub, topic, level, lesson, quiz, i: 0 });
}

function speak(text){
  try { if (!("speechSynthesis" in window)) return false; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1; speechSynthesis.speak(u); return true; } catch(e){ return false; }
}
function showCard(L){
  const { sub, topic, level, lesson, i } = L, n = lesson.cards.length, c = lesson.cards[i], last = i === n - 1;
  const canSpeak = "speechSynthesis" in window;
  render(`${topbar(`${sub.n}: ${topic}`, "LEAVE")}
    ${i === 0 && lesson.intro ? `<div class="says">${bitSVG("sm")}<div class="bubble">${esc(lesson.intro)}</div></div>` : ""}
    <div class="box lesson-card"><div class="n">CARD ${i + 1}/${n} · ${esc(lesson.title)}</div>
      <div class="ttl">${esc(c.title)}</div><div class="fact">${esc(c.fact)}</div>
      ${c.hook ? `<div class="hook"><b>REMEMBER:</b> ${esc(c.hook)}</div>` : ""}</div>
    <div class="dots" aria-hidden="true">${lesson.cards.map((_, j) => `<i class="${j <= i ? "on" : ""}"></i>`).join("")}</div>
    <div class="row-btns">${i > 0 ? `<button class="c" id="prev" type="button">◀ PREV</button>` : ""}${canSpeak ? `<button class="c" id="say" type="button">READ ALOUD</button>` : ""}<button class="big calm" id="next" type="button">${last ? "START QUIZ ▶" : "NEXT ▶"}</button></div>
    <p class="tag">LESSON BY BIT ON ANNA'S AI · LEVEL ${level.toUpperCase()}</p>`, "lesson");
  if (S.profile.readAloud) speak(`${c.title}. ${c.fact} ${c.hook || ""}`);
  on("#back", async () => { if (await confirmBox("LEAVE THE LESSON?", "You can start it again from the subject page.")){ try { speechSynthesis.cancel(); } catch(e){} subjectScreen(sub.id); } });
  on("#prev", () => showCard({ ...L, i: i - 1 }));
  on("#say", () => speak(`${c.title}. ${c.fact} ${c.hook || ""}`));
  on("#next", () => { SFX.page(); last ? lessonQuiz(L) : showCard({ ...L, i: i + 1 }); });
  $("#next").focus();
}

async function lessonQuiz(L){
  try { speechSynthesis.cancel(); } catch(e){}
  const { sub, topic, lesson, quiz } = L, p = P(), s = PG.subj(p, sub.id);
  // The lesson counts as read: record it once (its +20 XP shows on the results screen).
  if (!L.before) L.before = snapshot();
  if (!L.recorded){
    L.recorded = true;
    const lkey = sub.id + "|" + topic;
    p.learned[lkey] = (p.learned[lkey] || []).concat(lesson.cards.map(c => c.title || c.fact.slice(0, 60))).slice(-30);
    if (!s.lessons.includes(topic)) s.lessons.push(topic);
    p.stats.lessons++;
    PG.addXP(p, sub.id, 20);
    save("progress");
  }
  let tok = null;
  if (!quiz.done) tok = loading("Bit is fact-checking your quiz...", () => subjectScreen(sub.id));
  const res = await quiz.p;
  if (tok && !live(tok)) return;
  let qs = (res.questions || []).map(q => mkQ(q, sub.id, "ai"));
  if (qs.length < 3){
    if (res.error) console.warn("[pixel-trivia] lesson quiz failed:", res.error);
    toast("Bit's quiz didn't arrive in time, so some built-in questions fill in.");
    qs = qs.concat(deckQs(sub.id, 5 - qs.length, new Set(qs.map(q => PG.qkey(q.q)))));
  }
  const review = PG.dueItems(R(), sub.id).slice(0, 2).map(it => ({ ...mkQ(it, it.sub, "review"), ref: it }));
  startRound(newRound({ mode: "lesson", label: sub.n, subId: sub.id, topic, qs: qs.concat(review), time: 20, checked: !!res.checked, before: L.before }));
}

function aiError(e, retry, back, subId){
  render(`<div class="boot"><div class="says">${bitSVG("lg")}<div class="bubble">${esc(aiErrorText(e))}</div></div>
    <div class="row-btns"><button class="big calm" id="retry" type="button">TRY AGAIN</button>${subId ? `<button class="c" id="deck" type="button">BUILT-IN QUIZ</button>` : ""}<button class="c" id="bk" type="button">BACK</button></div></div>`, "error");
  on("#retry", retry); on("#bk", back);
  on("#deck", () => startRound(newRound({ mode: "quick", label: subName(subId), subId, qs: deckQs(subId, 8), time: 15 })));
}

/* ============ quick quiz ============ */
function quickMenu(){
  render(`${topbar("QUICK QUIZ")}
    <h2>QUIZ LENGTH</h2><div class="mini" id="lens">${[5, 10, 15].map(n => `<button type="button" data-n="${n}" class="${n === qlen ? "on" : ""}" aria-pressed="${n === qlen}">${n} QS</button>`).join("")}</div>
    <h2>PICK A SUBJECT</h2><div class="grid subs">${SUBJECTS.map(catBtn).join("")}</div>
    <div class="grid"><button class="big" type="button" data-c="random">★ RANDOM MIX ★</button></div>
    <p class="tag">${ai ? "Fresh questions written and fact-checked by Bit." : "Built-in deck (preview mode)."} Faster answers and combos score more.</p>`, "quickmenu");
  on("#back", home);
  onAll("#lens button", b => { qlen = +b.dataset.n; $$("#lens button").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }); });
  onAll("[data-c]", b => startQuick(b.dataset.c));
}

async function startQuick(choice){
  const total = qlen, random = choice === "random";
  const pick = () => random ? SUBJECTS[Math.random() * SUBJECTS.length | 0].id : choice;
  const inRound = new Set();
  let round = null, unchecked = false;
  const fetchChunk = async size => {
    const sid = pick(), sub = SUBJECT[sid];
    if (ai){
      try {
        const r = await ai.quiz({ subject: sub.n, topic: "", level: PG.tier(P(), sid), count: size, avoid: PG.seenList(P(), sid) });
        const qs = r.questions.filter(q => !inRound.has(PG.qkey(q.q))).map(q => mkQ(q, sid, "ai"));
        if (r.checked === false){ unchecked = true; if (round) round.checked = false; }
        if (qs.length){ qs.forEach(q => inRound.add(PG.qkey(q.q))); return qs; }
      } catch(e){ console.warn("[pixel-trivia] quiz chunk failed, using the built-in deck:", e); }
    }
    const qs = deckQs(sid, size, inRound); qs.forEach(q => inRound.add(PG.qkey(q.q)));
    return qs;
  };
  const tok = loading(ai ? "Bit is writing and fact-checking your questions..." : "Shuffling the deck...", quickMenu);
  const first = await fetchChunk(Math.min(5, total));
  if (!live(tok)) return;
  if (!first.length){ toast("No questions available right now."); return quickMenu(); }
  const r = round = newRound({ mode: "quick", label: random ? "Random mix" : subName(choice), subId: random ? null : choice, qs: first, time: 15, total, checked: !unchecked });
  r.fetchChunk = fetchChunk;
  startRound(r);
  prefetch();
}
function prefetch(){
  if (!G || !G.fetchChunk || G.pending || G.qs.length >= G.total) return;
  const g = G;
  g.pending = g.fetchChunk(Math.min(5, g.total - g.qs.length)).then(qs => { g.pending = null; if (!qs.length) g.total = g.qs.length; g.qs.push(...qs.slice(0, g.total - g.qs.length)); if (g === G) prefetch(); });
}

/* ============ review ============ */
function whenText(t){
  const d = Math.round((PG.dayKey(t) === PG.dayKey(Date.now() + 864e5) ? 1 : (t - Date.now()) / 864e5));
  return d <= 1 ? "tomorrow" : `in ${d} days`;
}
function reviewStart(){
  const due = PG.dueItems(R()).slice(0, 10);
  if (!due.length){
    const nd = PG.nextDue(R());
    return modal({ title: "NOTHING DUE", body: esc(nd < Infinity ? `Your next review card is due ${whenText(nd)}. ${R().items.length} card${R().items.length === 1 ? "" : "s"} in your pile.` : "Questions you miss land here, then come back over the following days until you master them.") });
  }
  startRound(newRound({ mode: "review", label: "Review", qs: due.map(it => ({ ...mkQ(it, it.sub, "review"), ref: it })), time: 20 }));
}

/* ============ the round engine ============ */
function newRound(o){
  return { mode: o.mode, label: o.label, subId: o.subId || null, topic: o.topic || "", qs: o.qs, time: o.time || 15, total: o.total || o.qs.length, checked: o.checked !== false,
    challenge: o.challenge || null, i: 0, score: 0, streak: 0, best: 0, right: 0, marks: [], xp: 0, missed: [], got: [], badges: [], mastered: 0,
    cid: Math.random().toString(36).slice(2, 10), ...(o.before || snapshot()) };
}
/* Level and stars before the round, so the results screen can announce level-ups. */
const snapshot = () => ({ lvl0: PG.levelInfo(P().xp).lvl, stars0: Object.fromEntries(SUBJECTS.map(s => [s.id, PG.stars(P(), s.id)])) });
function startRound(r){ G = r; SFX.start(); ask(); }

function ask(){
  const q = G.qs[G.i];
  G.lock = false; G.t = G.time; G.hinted = false;
  const canHint = G.mode !== "placement" && G.mode !== "challenge";
  const label = G.mode === "lesson" ? `${G.label}: ${G.topic}` : q.sub ? subName(q.sub) : G.label;
  render(`
    <div class="hud"><span>Q ${G.i + 1}/${G.total}</span><span class="gold" id="hudScore">${fmt(G.score)}</span><span class="hearts" id="hudCombo">${comboText()}</span></div>
    <div class="bar" id="bar" role="timer" aria-label="Time left"><i id="tb"></i></div>
    <div class="box"><div class="qcat"><span>${esc(label)}</span><span>${srcLabel(q)}</span></div><div class="q" id="qtext">${esc(q.q)}</div><div id="hintline" class="small gold" hidden></div></div>
    <div class="opts">${q.o.map((o, i) => `<button type="button" data-i="${i}"><span class="k">${i + 1}</span>${esc(o)}</button>`).join("")}</div>
    <div class="qtools">${canHint ? `<button type="button" id="hint">HINT (H)</button>` : "<span></span>"}<button type="button" id="quit" class="ghost">QUIT</button></div>
    <div id="fb"></div>`, "quiz");
  $$(".opts button").forEach(b => b.addEventListener("click", () => pick(+b.dataset.i, b)));
  on("#hint", useHint);
  on("#quit", quitRound);
  clearInterval(timer);
  timer = setInterval(tick, 100);
}

const comboText = () => G.streak > 1 ? "x" + Math.min(G.streak, 5) + " COMBO" : "";
function tick(){
  if (document.hidden || !$("#modal").hidden || !G || G.lock) return;   // paused
  G.t -= .1;
  const tb = $("#tb"), bar = $("#bar");
  if (tb){ tb.style.width = Math.max(0, G.t / G.time * 100) + "%"; bar.classList.toggle("warn", G.t < G.time * .6 && G.t >= 5); bar.classList.toggle("danger", G.t < 5); }
  if (G.t <= 5 && G.t > 0 && Math.abs(G.t - Math.round(G.t)) < .05) SFX.tick();
  if (G.t <= 0){ clearInterval(timer); pick(-1); }
}

function useHint(){
  if (G.lock || G.hinted) return;
  const q = G.qs[G.i];
  G.hinted = true;
  const wrong = shuf($$(".opts button").filter(b => q.o[+b.dataset.i] !== q.a)).slice(0, 2);
  wrong.forEach(b => { b.disabled = true; b.classList.add("gone"); });
  if (q.hint){ const h = $("#hintline"); h.textContent = "HINT: " + q.hint; h.hidden = false; }
  const hb = $("#hint"); if (hb) hb.disabled = true;
}

async function quitRound(){
  if (!await confirmBox("QUIT THIS ROUND?", "Answers so far still count toward your progress, but the round won't get a score.")) return;
  clearInterval(timer);
  save("progress", "review");
  G = null; home();
}

function pick(i, btn){
  if (!G || G.lock) return;
  G.lock = true; clearInterval(timer);
  const p = P(), q = G.qs[G.i], ok = i >= 0 && q.o[i] === q.a, secs = G.time - G.t;
  $$(".opts button").forEach(b => { b.disabled = true; if (q.o[+b.dataset.i] === q.a) b.classList.add("ok"); });
  const hb = $("#hint"); if (hb) hb.disabled = true;
  let pts = 0, mastered = false;
  if (ok){
    G.streak++; G.right++; G.best = Math.max(G.best, G.streak);
    pts = (100 + Math.round(G.t * 10)) * Math.min(G.streak, 5);
    let xp = 10 + Math.floor(G.t);
    if (G.hinted){ pts = Math.round(pts / 2); xp = Math.round(xp / 2); }
    G.score += pts; G.xp += xp;
    if (G.mode !== "placement") PG.addXP(p, q.sub, xp);
    if (secs < 3){ const b = PG.award(p, "speedy"); if (b) G.badges.push(b); }
    G.got.push(q.q);
    SFX.good(); haptic(anna, "good");
    const r = (btn || $(".opts button.ok")).getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2);
  } else {
    G.streak = 0; if (btn) btn.classList.add("no");
    G.missed.push({ q: q.q, a: q.a, exp: q.exp, chosen: i >= 0 ? q.o[i] : "" });
    SFX.bad(); haptic(anna, "bad");
  }
  p.stats.bestCombo = Math.max(p.stats.bestCombo, G.streak);
  G.marks.push(ok ? 1 : 0);
  $("#hudScore").textContent = fmt(G.score); $("#hudCombo").textContent = comboText();
  if (q.sub){ PG.recordAnswer(p, q.sub, ok); PG.markSeen(p, q.sub, q.q); }
  if (q.src === "review"){ mastered = PG.reviewResult(R(), p, q.ref, ok); if (mastered) G.mastered++; }
  else if (!ok && G.mode !== "placement") PG.addToReview(R(), { q: q.q, a: q.a, wrong: q.o.filter(o => o !== q.a), exp: q.exp, hint: q.hint }, q.sub);
  save("progress", "review");

  const verdict = ok ? `<div class="verdict good">CORRECT! +${fmt(pts)}${G.hinted ? " (HINT)" : ""}</div>` : `<div class="verdict bad">${i < 0 ? "TIME'S UP!" : "NOT QUITE."}</div><div class="small">ANSWER: <span class="gold">${esc(q.a)}</span></div>`;
  const expl = q.exp ? `<p class="exp">${esc(q.exp)}</p>` : ai ? `<p class="exp" id="exp"><button type="button" id="why" class="ghost">WHY? ASK BIT</button></p>` : "";
  const isLast = G.i + 1 >= G.total;
  $("#fb").innerHTML = `<div class="box cyan feedback">${verdict}${mastered ? `<p class="small good">MASTERED! This card leaves your review pile.</p>` : ""}${!ok && G.mode !== "placement" && q.src !== "review" ? `<p class="tiny dim">Added to your review pile.</p>` : ""}${expl}
    <div class="qtools">${q.src === "ai" ? `<button type="button" id="report" class="ghost">REPORT</button>` : "<span></span>"}<button type="button" class="big calm" id="nextq">${isLast ? "RESULTS ▶" : "NEXT ▶"}</button></div></div>`;
  on("#nextq", nextQ);
  on("#why", async () => {
    const box = $("#exp"); box.textContent = "Bit is thinking...";
    try { q.exp = await ai.explain({ q: q.q, a: q.a, chosen: i >= 0 ? q.o[i] : "" }); if (box.isConnected) box.textContent = q.exp; }
    catch(e){ if (box.isConnected) box.textContent = aiErrorText(e); }
  });
  on("#report", async () => {
    const why = await modal({ title: "REPORT THIS QUESTION?", body: "Bit will drop it from your review pile and steer clear of it in future quizzes. Thanks for keeping the quiz honest!", buttons: [{ label: "CANCEL", value: false }, { label: "REPORT", value: true, cls: "big calm" }] });
    if (!why) return;
    R().items = R().items.filter(it => PG.qkey(it.q) !== PG.qkey(q.q));
    if (q.sub) PG.markSeen(p, q.sub, q.q);
    console.warn("[pixel-trivia] question reported:", q);
    save("review", "progress"); toast("Reported. Thanks!");
    const rb = $("#report"); if (rb) rb.disabled = true;
  });
  $("#nextq").focus();
}

async function nextQ(){
  G.i++;
  if (G.i < G.qs.length) return ask();
  if (G.fetchChunk && G.qs.length < G.total){
    const g = G;
    const tok = loading("Bit is writing more questions...");
    if (!g.pending) prefetch();
    await g.pending;
    if (!live(tok) || g !== G) return;
    if (G.i < G.qs.length) return ask();
  }
  finishRound();
}

/* ============ end of round ============ */
function finishRound(){
  clearInterval(timer); SFX.end();
  const r = G, p = P();
  if (r.mode === "placement") return placementDone(r);
  if (r.mode === "challenge") return challengeDone(r);
  const n = r.qs.length;
  const streakGrew = PG.touchStreak(p);
  p.stats.rounds++;
  if (n >= 5 && r.right === n){ p.stats.perfect++; const b = PG.award(p, "perfect"); if (b) r.badges.push(b); }
  r.badges.push(...PG.checkBadges(p));
  const label = r.mode === "lesson" ? `${r.label}: ${r.topic}` : r.label;
  const rank = PG.addBest(p, { score: r.score, label, n, right: r.right, mode: r.mode });
  save("progress", "review");
  resultsScreen(r, { streakGrew, rank, label });
}

function upsHTML(r){
  const p = P(), out = [];
  const lvl = PG.levelInfo(p.xp).lvl;
  if (lvl > r.lvl0){ out.push(`<p class="good">LEVEL UP! YOU'RE LEVEL ${lvl}.</p>`); SFX.level(); }
  SUBJECTS.forEach(s => { const st = PG.stars(p, s.id); if (st > r.stars0[s.id]) out.push(`<p class="gold">${esc(s.n).toUpperCase()}: ${starsHTML(st).replace('class="stars"', 'class="stars inline"')}</p>`); });
  r.badges.forEach(b => out.push(`<div class="newbadge"><span class="ic" aria-hidden="true">${b.ic}</span><span>NEW BADGE: ${esc(b.n).toUpperCase()}</span></div>`));
  return out.join("");
}
function localRecap(r){
  const n = r.qs.length, pct = r.right / n;
  if (pct === 1) return `A perfect round, ${S.profile.name}! Try a harder topic next.`;
  if (pct >= .6) return `Solid work: ${r.right} of ${n}. The ones you missed are waiting in REVIEW tomorrow.`;
  return `${r.right} of ${n} this time. Read the answers below, and they'll come back in REVIEW so they stick.`;
}
function resultsScreen(r, info){
  const n = r.qs.length, pct = r.right / n;
  const title = n >= 5 && pct === 1 ? "FLAWLESS!" : pct >= .6 ? "ROUND CLEAR!" : "GAME OVER";
  const canChallenge = n >= 3 && (r.mode === "lesson" || r.mode === "quick");
  const st = P().streak;
  render(`<h1>${title}</h1>
    <div class="box center"><div class="sub">SCORE</div><div class="gold big-num">${fmt(r.score)}</div>
      <p>${r.right}/${n} CORRECT · BEST COMBO ${r.best}</p>
      <p class="small">+${fmt(r.xp + (r.mode === "lesson" ? 20 : 0))} XP${info.rank === 0 && P().bests.length > 1 ? ` · <span class="gold">NEW PERSONAL BEST!</span>` : ""}${r.mastered ? ` · MASTERED ${r.mastered}` : ""}</p>
      ${info.streakGrew ? `<p class="pinkc">DAILY STREAK: ${plural(st.count, "DAY")}</p>` : ""}
      ${upsHTML(r)}</div>
    <div class="says">${bitSVG()}<div class="bubble" id="recap">${ai && r.mode !== "review" ? "Bit is thinking..." : esc(localRecap(r))}</div></div>
    ${r.missed.length ? `<details><summary>SEE THE ANSWERS YOU MISSED (${r.missed.length})</summary><div class="box">${r.missed.map(m => `<div class="missed"><div>${esc(m.q)}</div><div class="gold">${esc(m.a)}</div>${m.exp ? `<div class="dim">${esc(m.exp)}</div>` : ""}</div>`).join("")}</div></details>` : ""}
    <div class="row-btns">
      ${canChallenge ? `<button class="big calm" id="chal" type="button">CHALLENGE A FRIEND</button>` : ""}
      ${r.mode === "lesson" ? `<button class="c" id="nextl" type="button">NEXT LESSON ▶</button>` : ""}
      ${r.mode === "quick" ? `<button class="c" id="again" type="button">PLAY AGAIN</button>` : ""}
      ${r.mode === "review" && PG.dueItems(R()).length ? `<button class="c" id="more" type="button">MORE REVIEW</button>` : ""}
      <button class="c" id="home" type="button">HOME</button></div>`, "results");
  burst(innerWidth / 2, innerHeight / 3, null, 60);
  on("#home", home);
  on("#chal", () => sendChallenge(r));
  on("#again", () => startQuick(r.subId || "random"));
  on("#more", reviewStart);
  on("#nextl", () => { const sub = SUBJECT[r.subId]; learn(r.subId, PG.nextTopic(P(), sub)); });
  if (ai && r.mode !== "review"){
    ai.recap({ name: S.profile.name, subject: r.label, topic: r.topic || "Mixed", right: r.right, total: n, got: r.got, missed: r.missed.map(m => `${m.q} -> ${m.a}`) })
      .then(t => { const b = $("#recap"); if (b) b.textContent = t; })
      .catch(() => { const b = $("#recap"); if (b) b.textContent = localRecap(r); });
  }
}

function placementDone(r){
  const p = P(), by = {};
  r.qs.forEach((q, i) => { (by[q.sub] = by[q.sub] || []).push(r.marks[i]); });
  const med = [], easy = [];
  Object.entries(by).forEach(([sid, m]) => {
    const good = m.reduce((a, b) => a + b, 0) / m.length >= .5;
    PG.subj(p, sid).start = good ? 1 : 0;
    (good ? med : easy).push(subName(sid));
  });
  const lines = [`You got ${r.right} of ${r.qs.length}!`];
  if (med.length) lines.push(`I'll start you at MEDIUM in ${med.join(", ")}.`);
  if (easy.length) lines.push(`${med.length ? "And" : "I'll start"} EASY in ${easy.join(", ")}${med.length ? "" : ", and everything else"}.`);
  finishSetup(lines);
}

/* ============ challenges ============ */
async function sendChallenge(r){
  const pr = S.profile, so = S.social;
  const label = r.mode === "lesson" ? `${r.label}: ${r.topic}` : r.label;
  if (!r.code) r.code = await SOC.makeChallenge(pr, { cid: r.cid, label, qs: r.qs, score: r.score, right: r.right, marks: r.marks, time: r.time });
  if (!so.sent.some(x => x.id === r.cid)){
    so.sent.unshift({ id: r.cid, ts: Date.now(), label, n: r.qs.length, score: r.score, right: r.right, marks: r.marks, code: r.code, replies: {} });
    so.sent = so.sent.slice(0, 30);
    const b = PG.award(P(), "challenger"); if (b) toast(`NEW BADGE: ${b.n.toUpperCase()}`);
    save("social", "progress");
  }
  sharePanel("challenge", r.code, { label, n: r.qs.length, score: r.score }, home);
}

function sharePanel(kind, code, info, done){
  const text = SOC.shareText(kind, S.profile, info, code);
  render(`${topbar(kind === "challenge" ? "CHALLENGE A FRIEND" : "SEND YOUR RESULT", "DONE")}
    <div class="says">${bitSVG("sm")}<div class="bubble">${kind === "challenge" ? "Send this message to a friend. They paste it into CHALLENGES and play the exact same questions." : "Send this back to your friend so they can see who won."}</div></div>
    <div class="box"><label class="small" for="code">YOUR MESSAGE</label><textarea class="code" id="code" readonly>${esc(text)}</textarea></div>
    <div class="row-btns"><button class="big calm" id="share" type="button">SHARE</button><button class="c" id="copy" type="button">COPY</button></div>
    <p class="tag">Scores travel inside the code, so play fair!</p>`, "share");
  on("#back", done);
  const doCopy = async () => toast(await SOC.copy(text, $("#code")) ? "Copied! Paste it into any chat." : "Select the message above and copy it.");
  on("#copy", doCopy);
  on("#share", async () => {
    const res = await SOC.share(anna, text);
    if (res === "shared") toast("Sent!");
    else if (res === "unavailable"){ toast("Sharing isn't available here, so use COPY."); doCopy(); }
  });
}

function challengesScreen(){
  const so = S.social, rivals = SOC.rivalsList(so);
  render(`${topbar("CHALLENGES")}
    <div class="box"><h3>GOT A MESSAGE FROM A FRIEND?</h3>
      <label class="small" for="paste">Paste the whole message (a challenge or a reply):</label>
      <textarea id="paste" spellcheck="false" placeholder="PXT1..."></textarea>
      <div class="row-btns"><button class="big calm" id="open" type="button">OPEN</button></div></div>
    <p class="small dim">To challenge someone, finish a lesson quiz or a quick quiz and tap CHALLENGE A FRIEND.</p>
    <h2>RIVALS</h2><div class="box">${rivals.length ? rivals.map(rv => `<div class="row"><span class="l">${avatarSVG(rv.av, "av sm")}${esc(rv.n)}</span><span class="r"><span class="good">${rv.w}W</span> <span class="bad">${rv.l}L</span> <span class="dim">${rv.t}D</span></span></div>`).join("") : `<p class="small dim">No rivals yet. Challenge a friend!</p>`}</div>
    <h2>CHALLENGES YOU SENT</h2><div class="box">${so.sent.length ? so.sent.map((c, i) => `<div class="row"><span class="l small">${esc(c.label)} · ${fmt(c.score)}</span><span class="r small">${Object.keys(c.replies).length ? Object.values(c.replies).map(x => `${esc(x.n)} ${x.res === "w" ? "<span class='good'>WON</span>" : x.res === "l" ? "<span class='bad'>LOST</span>" : "DRAW"}`).join(", ") : "<span class='dim'>NO REPLY YET</span>"} <button type="button" class="ghost" data-again="${i}">SEND AGAIN</button></span></div>`).join("") : `<p class="small dim">None yet.</p>`}</div>
    <h2>CHALLENGES YOU PLAYED</h2><div class="box">${so.received.length ? so.received.map((c, i) => `<div class="row"><span class="l small">${avatarSVG(c.from.av, "av sm")}${esc(c.from.n)} · ${esc(c.label)}</span><span class="r small">${fmt(c.mine)} vs ${fmt(c.theirs)} ${c.res === "w" ? "<span class='good'>WIN</span>" : c.res === "l" ? "<span class='bad'>LOSS</span>" : "DRAW"} <button type="button" class="ghost" data-seen="${i}">VIEW</button></span></div>`).join("") : `<p class="small dim">None yet.</p>`}</div>`, "challenges");
  on("#back", home);
  on("#open", () => openCode($("#paste").value));
  onAll("[data-again]", b => { const c = so.sent[+b.dataset.again]; sharePanel("challenge", c.code, { label: c.label, n: c.n, score: c.score }, challengesScreen); });
  onAll("[data-seen]", b => challengeResultScreen(so.received[+b.dataset.seen]));
}

async function openCode(text){
  if (!text.trim()) return toast("Paste your friend's message first.");
  let res;
  try { res = await SOC.readCode(text); } catch(e){ return toast(e.message, 4200); }
  if (res.kind === "challenge") return challengeIntro(res.c);
  return replyResult(res.r);
}

function challengeIntro(c){
  if (c.from.pid === S.profile.pid) return modal({ title: "THAT'S YOUR CHALLENGE", body: "Send it to a friend. When they play it, they'll send you a reply to paste here." });
  const prior = S.social.received.find(x => x.id === c.id);
  if (prior) return challengeResultScreen(prior);
  render(`${topbar("CHALLENGE")}
    <div class="box center"><div class="player">${avatarSVG(c.from.av, "av lg")}<div class="who"><div class="nm">${esc(c.from.n)}</div><div class="small">CHALLENGES YOU!</div></div></div>
      <p class="small">${esc(c.sub)} · ${c.qs.length} QUESTIONS · ${c.tl}S EACH</p>
      <div class="sub">SCORE TO BEAT</div><div class="gold big-num">${fmt(c.sc)}</div>
      <p class="tiny dim">Same questions, same order, same timer. No hints.</p></div>
    <div class="row-btns"><button class="big" id="go" type="button">ACCEPT ▶</button></div>`, "challenge");
  on("#back", challengesScreen);
  on("#go", () => startRound(newRound({ mode: "challenge", label: c.sub, qs: c.qs.map(q => ({ q: q.q, a: q.a, o: q.o, exp: q.exp, hint: "", sub: null, src: "challenge" })), time: c.tl, challenge: c })));
}

async function challengeDone(r){
  const c = r.challenge, p = P(), so = S.social;
  const res = SOC.recordRival(so, c.from, r.score, c.sc);
  PG.touchStreak(p); p.stats.rounds++;
  if (res === "w"){ const b = PG.award(p, "rival"); if (b) r.badges.push(b); }
  r.badges.push(...PG.checkBadges(p));
  const reply = await SOC.makeReply(S.profile, c, { score: r.score, right: r.right, marks: r.marks });
  const e = { id: c.id, ts: Date.now(), from: c.from, label: c.sub, n: c.qs.length, theirs: c.sc, theirR: c.r, theirMarks: c.rr, mine: r.score, mineR: r.right, myMarks: r.marks, res, reply };
  so.received.unshift(e); so.received = so.received.slice(0, 30);
  save("social", "progress", "review");
  challengeResultScreen(e, upsHTML(r));
}

const marksHTML = m => `<div class="marks" aria-hidden="true">${(m || []).map(x => `<i class="${x ? "y" : ""}"></i>`).join("")}</div>`;
function vsHTML(me, them, total){
  const side = s => `<div class="side">${avatarSVG(s.av, "av lg")}<div>${esc(s.name)}</div><div class="gold">${fmt(s.score)}</div>${s.right != null ? `<div class="small">${s.right}/${total}</div>` : ""}${marksHTML(s.marks)}</div>`;
  return `<div class="box vs">${side(me)}<div class="pinkc big-num">VS</div>${side(them)}</div>`;
}
function challengeResultScreen(e, extra = ""){
  const title = e.res === "w" ? "YOU WIN!" : e.res === "l" ? "SO CLOSE!" : "A DRAW!";
  render(`<h1>${title}</h1>
    ${vsHTML({ av: S.profile.avatar, name: "YOU", score: e.mine, right: e.mineR, marks: e.myMarks }, { av: e.from.av, name: e.from.n, score: e.theirs, right: e.theirR, marks: e.theirMarks }, e.n)}
    ${extra ? `<div class="box center">${extra}</div>` : ""}
    <div class="says">${bitSVG("sm")}<div class="bubble">${e.res === "w" ? `You beat ${esc(e.from.n)}! Send your result back so they know.` : e.res === "l" ? `${esc(e.from.n)} wins this one. Send your result back, then challenge them to a rematch!` : "Dead even! Send your result back."}</div></div>
    <div class="row-btns"><button class="big calm" id="reply" type="button">SEND RESULT BACK</button><button class="c" id="home" type="button">HOME</button></div>`, "challenge");
  on("#reply", () => sharePanel("reply", e.reply, { label: e.label, score: e.mine }, challengesScreen));
  on("#home", home);
}

function replyResult(r){
  const so = S.social;
  if (r.from.pid === S.profile.pid) return modal({ title: "THAT'S YOUR OWN REPLY", body: "Send it to the friend who challenged you." });
  const sent = so.sent.find(s => s.id === r.cid);
  if (!sent) return modal({ title: "UNKNOWN CHALLENGE", body: "This reply is for a challenge sent from a different Anna account, so it can't be scored here." });
  let rep = sent.replies[r.from.pid];
  if (!rep){
    const res = SOC.recordRival(so, r.from, sent.score, r.sc);
    rep = sent.replies[r.from.pid] = { n: r.from.n, av: r.from.av, sc: r.sc, r: r.r, rr: r.rr, res, ts: Date.now() };
    if (res === "w"){ const b = PG.award(P(), "rival"); if (b) toast(`NEW BADGE: ${b.n.toUpperCase()}`); }
    save("social", "progress");
  }
  const title = rep.res === "w" ? "YOU WIN!" : rep.res === "l" ? "THEY WIN!" : "A DRAW!";
  render(`<h1>${title}</h1>
    <p class="center small">${esc(sent.label)} · ${sent.n} QUESTIONS</p>
    ${vsHTML({ av: S.profile.avatar, name: "YOU", score: sent.score, right: sent.right, marks: sent.marks }, { av: r.from.av, name: r.from.n, score: r.sc, right: r.r, marks: r.rr }, sent.n)}
    <div class="row-btns"><button class="c" id="list" type="button">CHALLENGES</button><button class="c" id="home" type="button">HOME</button></div>`, "challenge");
  on("#list", challengesScreen); on("#home", home);
}

/* ============ scores & profile ============ */
function scoresScreen(){
  const p = P(), rivals = SOC.rivalsList(S.social);
  render(`${topbar("SCORES")}
    <h2>MY TOP 10 ROUNDS</h2><div class="box">${p.bests.length ? p.bests.map((b, i) => `<div class="row${i === 0 ? " gold" : ""}"><span class="l small">${i + 1}. ${esc(b.label)}</span><span class="r small">${b.right}/${b.n} · <span class="gold">${fmt(b.score)}</span></span></div>`).join("") : `<p class="small dim">No rounds yet. Play one!</p>`}</div>
    <h2>RIVALS</h2><div class="box">${rivals.length ? rivals.map(rv => `<div class="row"><span class="l">${avatarSVG(rv.av, "av sm")}${esc(rv.n)}</span><span class="r"><span class="good">${rv.w}W</span> <span class="bad">${rv.l}L</span> <span class="dim">${rv.t}D</span></span></div>`).join("") : `<p class="small dim">Rivals appear when you play challenges with friends.</p>`}</div>`, "scores");
  on("#back", home);
}

function profileScreen(){
  const p = P(), pr = S.profile, L = PG.levelInfo(p.xp);
  const acc = p.stats.answered ? Math.round(p.stats.correct / p.stats.answered * 100) : 0;
  render(`${topbar("PROFILE")}
    <div class="box player">${avatarSVG(pr.avatar, "av lg")}<div class="who"><div class="nm">${esc(pr.name)}</div><div class="small">LEVEL ${L.lvl} · ${fmt(p.xp)} XP · ${L.need - L.into} TO GO</div>
      <div class="xpbar"><i id="xpb"></i></div>
      <div class="statline"><span>STREAK ${p.streak.count} (BEST ${p.streak.best})</span><span>LESSONS ${p.stats.lessons}</span><span>ACCURACY ${acc}%</span><span>MASTERED ${p.stats.mastered}</span></div></div></div>
    <div class="row-btns"><button class="c" id="edit" type="button">NAME & AVATAR</button><button class="c" id="favs" type="button">FAVOURITES</button></div>
    <h2>BADGES ${Object.keys(p.badges).length}/${BADGES.length}</h2>
    <div class="badges">${BADGES.map(b => `<div class="badge${p.badges[b.id] ? " got" : ""}"><span class="ic" aria-hidden="true">${b.ic}</span>${esc(b.n).toUpperCase()}<br><span class="dim">${esc(b.d)}</span></div>`).join("")}</div>
    <h2>SUBJECT MASTERY</h2><div class="box">${SUBJECTS.map(s => `<div class="row"><span class="l small"><span class="ic-sm" aria-hidden="true">${s.ic}</span>${esc(s.n)}</span><span class="r small">${starsHTML(PG.stars(p, s.id))}</span></div>`).join("")}</div>
    <h2>SETTINGS</h2><div class="box">
      <div class="switch"><span>SOUND</span><button type="button" id="snd" class="${pr.sound ? "on" : ""}" aria-pressed="${pr.sound}">${pr.sound ? "ON" : "OFF"}</button></div>
      <div class="switch"><span>READ LESSONS ALOUD</span><button type="button" id="ra" class="${pr.readAloud ? "on" : ""}" aria-pressed="${pr.readAloud}">${pr.readAloud ? "ON" : "OFF"}</button></div>
      <div class="switch"><span>BIT'S HELPER TOOL</span><span class="small" id="toolst"></span></div>
      <div class="switch"><span>SAVED TO</span><span class="small">${store.kind === "anna" ? "YOUR ANNA ACCOUNT" : "THIS BROWSER (PREVIEW)"}</span></div></div>
    <div class="row-btns"><button class="ghost" id="reset" type="button">RESET ALL PROGRESS</button></div>
    <p class="tag">PIXEL TRIVIA · Lessons and questions are written by Bit on Anna's AI and fact-checked by a second pass. AI can still slip: tap REPORT on any question that looks wrong. Font: Press Start 2P (SIL Open Font License).</p>`, "profile");
  $("#xpb").style.width = L.pct + "%";
  renderToolStatus();
  on("#back", home);
  on("#edit", () => onboardName(true));
  on("#favs", () => onboardSubjects(true));
  on("#snd", () => { pr.sound = !pr.sound; setMuted(!pr.sound); updateMute(); save("profile"); profileScreen(); });
  on("#ra", () => { pr.readAloud = !pr.readAloud; save("profile"); profileScreen(); });
  on("#reset", async () => {
    if (!await confirmBox("RESET EVERYTHING?", "This deletes your XP, badges, streak, review pile, rivals and profile from your account. It can't be undone.", "RESET", "KEEP")) return;
    if (!await confirmBox("ARE YOU SURE?", "Last chance: all progress will be gone.", "YES, RESET", "NO")) return;
    await store.reset(); S = store.S; setMuted(false); updateMute(); onboardName();
  });
}
function renderToolStatus(){
  const el = $("#toolst"); if (!el) return;
  if (!ai){ el.textContent = "OFF (PREVIEW)"; return; }
  const t = ai.tool;
  el.innerHTML = !t.checked ? "CHECKING..." : t.ok ? `<span class="good">✓ CONNECTED${t.version ? " v" + esc(t.version) : ""}</span>` : `<span class="gold">USING ANNA'S AI DIRECTLY</span>`;
  el.title = t.error || "";
}

/* ============ sound toggle ============ */
function updateMute(){ const b = $("#mute"); const onS = S ? S.profile.sound : true; b.textContent = onS ? "SND ON" : "SND OFF"; b.setAttribute("aria-pressed", String(onS)); }
$("#mute").addEventListener("click", () => { if (!S) return; S.profile.sound = !S.profile.sound; setMuted(!S.profile.sound); updateMute(); save("profile"); SFX.click(); if (screen === "profile") profileScreen(); });

/* ============ keyboard ============ */
function onKey(e){
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$("#modal").hidden){ if (e.key === "Escape" && modalResolve) modalResolve(null); return; }
  const typing = /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || "");
  if (typing) return;
  if (screen === "quiz" && G){
    if (!G.lock && /^[1-4]$/.test(e.key)){ const b = $$(".opts button")[+e.key - 1]; if (b && !b.disabled) b.click(); }
    else if (!G.lock && (e.key === "h" || e.key === "H")){ const hb = $("#hint"); if (hb && !hb.disabled) hb.click(); }
  } else if (screen === "lesson"){
    if (e.key === "ArrowRight"){ const b = $("#next"); if (b) b.click(); }
    else if (e.key === "ArrowLeft"){ const b = $("#prev"); if (b) b.click(); }
  }
}

/* ============ boot ============ */
async function connectAnna(){
  if (window.__PT_TEST_ANNA__) return window.__PT_TEST_ANNA__;   // automated tests only
  const q = new URLSearchParams(location.search);
  if (!q.get("wid") || !q.get("t")) return null;                  // plain browser preview, not an Anna window
  const mod = await import(SDK_URL);
  return await mod.AnnaAppRuntime.connect();
}
function bootError(msg, retry){
  render(`<div class="boot"><h1>PIXEL<br>TRIVIA</h1><div class="says">${bitSVG("lg")}<div class="bubble">${esc(msg)}</div></div><div class="row-btns"><button class="big calm" id="retry" type="button">TRY AGAIN</button></div></div>`, "error");
  on("#retry", retry);
}
let fxStarted = false;
async function boot(){
  if (!fxStarted){ initFX($("#fx")); fxStarted = true; }
  const inAnna = new URLSearchParams(location.search).has("wid");
  try { anna = await connectAnna(); }
  catch(e){ console.warn("[pixel-trivia] Anna connect failed", e); if (inAnna) return bootError("Pixel Trivia couldn't connect to Anna just now. Check your connection and try again.", boot); anna = null; }
  ai = anna ? createAI(anna) : null;
  if (ai) ai.onToolChange(renderToolStatus);
  store = createStore(anna, e => { if (e) toast("Couldn't save just now. Retrying..."); });
  try { S = await store.load(); }
  catch(e){ console.warn("[pixel-trivia] load failed", e); return bootError("Your progress didn't load. Nothing is lost; try again in a moment.", boot); }
  setMuted(!S.profile.sound); updateMute();
  if (anna){ try { anna.window.set_title({ title: "Pixel Trivia" }).catch(() => {}); } catch(e){} }
  if (ai) setTimeout(() => ai.ping(), 1500);    // warm the tool up; Profile shows its state
  document.addEventListener("keydown", onKey);
  addEventListener("pagehide", () => store.flushAll());
  document.addEventListener("visibilitychange", () => { if (document.hidden) store.flushAll(); });
  home();
}
boot();
