/* Pixel Trivia — Bit's brain. Every AI call goes to the bundled "quizmaster" backend tool first
   (anna.tools.invoke → the Go Executa, which asks Anna's LLM through reverse sampling). If the
   tool can't run (not installed yet, not allowed, timed out), the same prompts go straight to
   Anna's AI with anna.llm.complete. Either way, questions pass the same format check here, and
   quizzes get a blind second check that drops any question whose answer key doesn't hold up.
   Prompts live in executas/quizmaster/prompts.json (copied to ./prompts.js). */
import { PROMPTS } from "./prompts.js";

const HANDLE = "quizmaster";                          // app.json bundled_executas handle
const DEV_TOOL = "tool-dev-pixel-trivia-quizmaster";  // only used if anna-tool-ids.js is missing
const TOOL = () => (window.__ANNA_TOOL_IDS__ || {})[HANDLE] || DEV_TOOL;

/* ---------- shared helpers (mirror main.go) ---------- */
const clean = v => String(v == null ? "" : v).replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
const clip = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join("").trim() + "…" : s; };
const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] != null ? String(vars[k]) : m);
const key = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const lines = (v, max) => {
  const list = (Array.isArray(v) ? v : String(v || "").split("\n")).map(clean).filter(Boolean).map(s => "- " + clip(s.replace(/^- /, ""), 200));
  return list.length ? list.slice(-max).join("\n") : "(none)";
};
const levelText = l => (PROMPTS.levels || {})[l] || PROMPTS.levels.medium;
const normLevel = l => ["easy", "medium", "hard"].includes(String(l).toLowerCase()) ? String(l).toLowerCase() : "medium";

export function parseJSON(text){
  const t = String(text || "").trim(), i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i < 0 || j <= i) throw new Error("no JSON object in the reply");
  return JSON.parse(t.slice(i, j + 1));
}

const BANNED = /\b(all|none|both) of the above\b|\b(currently|as of|at present|this year|nowadays|right now)\b|\blatest\b|\bmost recent\b/i;
const containsWord = (q, a) => { const ka = key(a); return Array.from(ka).length >= 3 && (" " + key(q) + " ").includes(" " + ka + " "); };

/* Returns a clean question or null. Same rules as validate() in main.go. */
export function validateQuestion(m){
  if (!m || typeof m !== "object") return null;
  const q = { q: clean(m.q), a: clean(m.a), wrong: [], exp: clip(clean(m.exp), 260), hint: clip(clean(m.hint), 110) };
  if (!q.q || !q.a || Array.from(q.q).length > 220 || Array.from(q.a).length > 90) return null;
  const seen = new Set([key(q.a)]);
  for (const w of Array.isArray(m.wrong) ? m.wrong : []){
    const s = clean(w), k = key(s);
    if (!s || seen.has(k) || Array.from(s).length > 90) continue;
    seen.add(k); q.wrong.push(s);
    if (q.wrong.length === 3) break;
  }
  if (q.wrong.length !== 3) return null;
  if (BANNED.test([q.q, q.a, ...q.wrong].join(" "))) return null;
  if (containsWord(q.q, q.a)) return null;
  return q;
}
export function validateAll(list, avoid = []){
  const av = new Set(avoid.map(key)), seen = new Set(), out = [];
  let dropped = 0;
  for (const it of Array.isArray(list) ? list : []){
    const q = validateQuestion(it);
    if (!q || seen.has(key(q.q)) || av.has(key(q.q))){ dropped++; continue; }
    seen.add(key(q.q)); out.push(q);
  }
  return { questions: out, dropped };
}

export function aiErrorText(e){
  const c = String((e && (e.code || e.name)) || "") + " " + String((e && e.message) || "");
  if (/llm_disabled|not_granted|sampling_disabled|permission|-32003|-32021/i.test(c)) return "Bit isn't allowed to use Anna's AI in this window yet.";
  if (/quota|credit|insufficient|balance|402/i.test(c)) return "Anna's AI credits ran out for now. Your account may need a top-up.";
  if (/rate|429|busy/i.test(c)) return "Bit needs a short breather. Try again in a minute.";
  if (/timed out|timeout/i.test(c)) return "That took too long. Try again?";
  return "Bit lost his train of thought. Try again?";
}

export function createAI(anna){
  const tool = { checked: false, ok: false, version: "", error: "", brokenUntil: 0 };
  const listeners = new Set();
  const note = (ok, err, version) => {
    Object.assign(tool, { checked: true, ok, version: version || tool.version, error: ok ? "" : String((err && (err.message || err.code)) || err || "unknown error") });
    if (!ok){ tool.brokenUntil = Date.now() + 3 * 60e3; console.warn("[pixel-trivia] quizmaster tool failed, using Anna's AI directly:", err); }
    else tool.brokenUntil = 0;
    listeners.forEach(f => f(tool));
  };

  async function callTool(method, args, timeoutMs){
    let out;
    try { out = await anna.tools.invoke({ tool_id: TOOL(), method, args }, { timeoutMs }); }
    catch(e){
      // tool_failed = the tool ran but reported a problem with this request (e.g. the model's reply
      // was unusable). The tool itself is fine; only this call falls back to Anna's AI.
      if (e && e.code === "tool_failed"){ note(true); e.toolContent = true; throw e; }
      note(false, e); throw e;
    }
    if (out && out.success === false){ const err = new Error(out.error || "tool failed"); err.toolContent = true; throw err; }
    note(true);
    return out && (out.data || (out.result && out.result.data) || out.result || out);
  }

  async function llm(system, user, maxTokens, temperature){
    const req = { systemPrompt: system, messages: [{ role: "user", content: { type: "text", text: user } }], maxTokens };
    if (temperature != null) req.temperature = temperature;
    const out = await anna.llm.complete(req, { timeoutMs: 90000 });
    return (out && out.content && (out.content.text ?? (Array.isArray(out.content) ? out.content.map(c => c.text || "").join("") : ""))) || (out && out.text) || "";
  }

  /* Try the tool, then Anna's AI directly. */
  async function both(method, args, timeoutMs, direct){
    if (Date.now() >= tool.brokenUntil){
      try { return await callTool(method, args, timeoutMs); }
      catch(e){ if (e && e.toolContent) console.warn(`[pixel-trivia] ${method} via tool:`, e.message); }
    }
    return await direct(args);
  }

  /* ---------- direct (fallback) implementations, mirroring main.go ---------- */
  async function lessonDirect(a){
    const cards = Math.min(5, Math.max(3, a.cards || 4));
    const vars = { subject: a.subject, topic: a.topic, level: levelText(normLevel(a.level)), cards, avoid: lines(a.avoid, 20) };
    let last;
    for (let i = 0; i < 2; i++){
      try {
        const obj = parseJSON(await llm(fill(PROMPTS.lesson_system, vars), fill(PROMPTS.lesson_user, vars), 900, 0.7));
        const out = (obj.cards || []).map(c => ({ title: clip(clean(c && c.title), 40), fact: clip(clean(c && c.fact), 260), hook: clip(clean(c && c.hook), 140) })).filter(c => c.fact).slice(0, cards);
        if (out.length >= 2) return { title: clip(clean(obj.title), 48) || a.topic, intro: clip(clean(obj.intro), 120), cards: out };
        last = new Error("the lesson came back without enough cards");
      } catch(e){ if (e instanceof SyntaxError || /JSON/.test(e.message)) last = e; else throw e; }
    }
    throw last;
  }
  async function quizDirect(a){
    const count = Math.min(10, Math.max(1, a.count || 5));
    const ask = count >= 8 ? count + 3 : count + 2;
    const lesson = clip(clean(a.lesson), 2400);
    const fromLesson = lesson ? (a.from_lesson || count) : 0;
    const vars = { subject: a.subject, topic: a.topic || "anything in " + a.subject, level: levelText(normLevel(a.level)), count: ask, lesson: lesson || "(no lesson)", from_lesson: fromLesson, avoid: lines(a.avoid, 30) };
    let last;
    for (let i = 0; i < 2; i++){
      try {
        const obj = parseJSON(await llm(fill(PROMPTS.quiz_system, vars), fill(PROMPTS.quiz_user, vars), 260 * ask + 300, 0.6));
        const v = validateAll(obj.questions, a.avoid || []);
        if (v.questions.length) return { ...v, checked: false };
        last = new Error("no usable questions came back");
      } catch(e){ if (e instanceof SyntaxError || /JSON/.test(e.message)) last = e; else throw e; }
    }
    throw last;
  }
  async function checkDirect({ questions }){
    const L = ["A", "B", "C", "D"], correct = [];
    const text = questions.map((q, i) => {
      const opts = [q.a, ...q.wrong].map((o, j) => ({ o, j })).sort(() => Math.random() - 0.5);
      correct[i] = L[opts.findIndex(x => x.j === 0)];
      return `${i + 1}. ${q.q}\n` + opts.map((x, k) => `${L[k]}) ${x.o}`).join("\n");
    }).join("\n\n");
    const obj = parseJSON(await llm(PROMPTS.check_system, text, 40 + 12 * questions.length, 0));
    const ans = Array.isArray(obj.answers) ? obj.answers : [];
    if (ans.length !== questions.length) throw new Error(`the check returned ${ans.length} answers for ${questions.length} questions`);
    const picked = ans.map(x => (String(x).toUpperCase().match(/[A-DX]/) || [""])[0]);
    return { keep: picked.map((p, i) => !!p && p === correct[i]), picked };
  }
  const textOf = raw => { try { const o = parseJSON(raw); if (o.text) return clip(clean(o.text), 420); } catch(e){} return clip(clean(raw).replace(/^["'{ ]+|["'} ]+$/g, ""), 420); };
  async function explainDirect(a){
    return { text: textOf(await llm(PROMPTS.explain_system, fill(PROMPTS.explain_user, { q: a.q, a: a.a, chosen: a.chosen || "(ran out of time)" }), 220, 0.4)) };
  }
  async function recapDirect(a){
    const vars = { name: a.name || "the player", subject: a.subject || "Mixed", topic: a.topic || "Mixed", right: a.right, total: a.total, got: lines(a.got, 12), missed: lines(a.missed, 12) };
    return { text: textOf(await llm(PROMPTS.recap_system, fill(PROMPTS.recap_user, vars), 240, 0.7)) };
  }

  return {
    available: !!anna,
    tool,
    onToolChange(f){ listeners.add(f); },

    async ping(){
      try { const d = await callTool("ping", {}, 20000); note(true, null, d && d.version); return true; }
      catch(e){ return false; }
    },

    async lesson(args){
      const out = await both("make_lesson", args, 90000, lessonDirect);
      const cards = (out.cards || []).map(c => ({ title: clean(c.title), fact: clean(c.fact), hook: clean(c.hook) })).filter(c => c.fact);
      if (cards.length < 2) throw new Error("the lesson came back empty");
      return { title: clean(out.title) || args.topic, intro: clean(out.intro), cards };
    },

    /* Generate, format-check, then blind-check. Resolves to { questions, checked, dropped }. */
    async quiz(args){
      const gen = await both("make_quiz", { ...args, check: false }, 90000, quizDirect);
      let { questions, dropped } = validateAll(gen.questions || [], args.avoid || []);
      dropped += gen.dropped || 0;
      if (!questions.length) throw new Error("no usable questions came back");
      let checked = false;
      try {
        const chk = await both("check_quiz", { questions: questions.map(q => ({ q: q.q, a: q.a, wrong: q.wrong })) }, 90000, checkDirect);
        if (Array.isArray(chk.keep) && chk.keep.length === questions.length){
          checked = true;
          const kept = questions.filter((q, i) => chk.keep[i]);
          dropped += questions.length - kept.length;
          questions = kept;
        }
      } catch(e){ console.warn("[pixel-trivia] second check skipped:", e); }
      return { questions: questions.slice(0, args.count || 5), checked, dropped };
    },

    async explain(args){ return (await both("explain", args, 60000, explainDirect)).text; },
    async recap(args){ return (await both("recap", args, 60000, recapDirect)).text; }
  };
}
