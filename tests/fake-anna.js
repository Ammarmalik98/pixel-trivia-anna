/* Test-only stand-in for Anna's runtime, injected by tests/e2e.py before the app loads.
   It answers storage, tools.invoke (as the quizmaster tool would) and llm.complete (the fallback),
   with realistic canned content for "Norse myths" and generated content for anything else.
   Toggles: window.__TOOL_BROKEN (tool throws → app falls back to llm.complete). */
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("noanna")) return;
  const USER = params.get("user") || "u1";
  const KEY = "fakeanna:" + USER;
  const mem = JSON.parse(localStorage.getItem(KEY) || "{}");
  const persist = () => localStorage.setItem(KEY, JSON.stringify(mem));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  window.__csp = []; window.__calls = [];
  addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + e.blockedURI));

  const NORSE = {
    title: "Gods of Asgard",
    intro: "Hoot! Today we visit the Norse gods. Four quick cards, then a quiz.",
    cards: [
      { title: "Odin's sacrifice", fact: "Odin, chief of the Norse gods, gave up one of his eyes to drink from Mimir's well and gain wisdom.", hook: "One eye for all the wisdom: a fair trade for the god of knowledge." },
      { title: "Thor's hammer", fact: "Thor's hammer, Mjolnir, was forged by dwarves and always flew back to his hand after he threw it.", hook: "Mjolnir boomerangs home, like thunder that always comes back." },
      { title: "The eight-legged horse", fact: "Odin rides Sleipnir, an eight-legged horse said to be the fastest of all steeds.", hook: "Eight legs means double the gallop." },
      { title: "The world tree", fact: "Yggdrasil is the vast ash tree whose branches and roots link the nine worlds of Norse myth.", hook: "Nine worlds hang on one giant tree." }
    ]
  };
  const NORSE_Q = [
    { q: "Who forged Thor's hammer, Mjolnir?", a: "Dwarves", wrong: ["Giants", "Elves", "Valkyries"], exp: "In the myths, the dwarf brothers Brokkr and Eitri forged Mjolnir in their smithy.", hint: "Master smiths who live underground." },
    { q: "What did Odin give up to drink from Mimir's well?", a: "One of his eyes", wrong: ["His spear", "His horse", "His voice"], exp: "Odin traded an eye for a drink of wisdom from Mimir's well.", hint: "Look closely at his portraits." },
    { q: "How many legs does Odin's horse Sleipnir have?", a: "Eight", wrong: ["Four", "Six", "Twelve"], exp: "Sleipnir's eight legs made him the fastest horse in the myths.", hint: "Double the usual number." },
    { q: "What kind of tree is Yggdrasil usually described as?", a: "An ash", wrong: ["An oak", "A pine", "A birch"], exp: "The Eddas describe Yggdrasil as a giant ash tree.", hint: "Its name sounds like what's left after a fire." },
    { q: "How many worlds does Yggdrasil connect?", a: "Nine", wrong: ["Three", "Seven", "Twelve"], exp: "Yggdrasil links the nine worlds, from Asgard to Hel.", hint: "Three times three." },
    { q: "Which god is the shape-shifting trickster of Norse myth?", a: "Loki", wrong: ["Baldur", "Heimdall", "Tyr"], exp: "Loki is the trickster who both helps and harms the gods.", hint: "His name has four letters." },
    { q: "What is the home of the Aesir gods called?", a: "Asgard", wrong: ["Midgard", "Jotunheim", "Vanaheim"], exp: "The Aesir live in Asgard; humans live in Midgard.", hint: "It starts with an A." }
  ];
  const DISAGREE = "Which god is the shape-shifting trickster of Norse myth?";   // the blind check "drops" this one
  const bank = {};
  NORSE_Q.forEach(q => bank[q.q] = q.a);
  let n = 0;
  function genQs(topic, count){
    if (/norse/i.test(topic)) return NORSE_Q.slice(0, Math.max(count, 7));
    return Array.from({ length: count }, () => {
      n++;
      const q = { q: `Test question ${n} about ${topic}?`, a: `Right ${n}`, wrong: [`Wrong ${n}a`, `Wrong ${n}b`, `Wrong ${n}c`], exp: `Because ${n} is right.`, hint: `Hint for ${n}.` };
      bank[q.q] = q.a; return q;
    });
  }
  function lesson(topic){ return /norse/i.test(topic) ? NORSE : { title: topic, intro: "Test intro.", cards: [1, 2, 3, 4].map(i => ({ title: `Fact ${i}`, fact: `Fact number ${i} about ${topic}.`, hook: `Hook ${i}.` })) }; }
  function check(qs){ return { keep: qs.map(q => q.q !== DISAGREE), picked: qs.map(() => "A") }; }
  const recapText = name => `Great run, ${name}! You knew who forged Mjolnir. Have another look at Sleipnir's legs, then try Egyptian myths next.`;

  /* llm.complete: answer by prompt type, like a real model would */
  function llmReply(req){
    const sys = req.systemPrompt || "", user = req.messages[0].content.text;
    const field = k => ((user.match(new RegExp("^" + k + ": (.*)$", "m")) || [])[1] || "").trim();
    if (sys.includes("bite-size lesson")) return JSON.stringify(lesson(field("Topic")));
    if (sys.includes("You write multiple-choice questions")) return JSON.stringify({ questions: genQs(field("Topic"), +field("Number of questions") || 5) });
    if (sys.includes("fact-checker")){
      const answers = user.trim().split("\n\n").map(block => {
        const rows = block.trim().split("\n"), q = rows[0].replace(/^\d+\.\s*/, "");
        const opts = rows.slice(1).map(r => [r[0], r.slice(3)]);
        const want = bank[q];
        const hit = opts.find(([L, o]) => q === DISAGREE ? o !== want : o === want);
        return hit ? hit[0] : "X";
      });
      return JSON.stringify({ answers });
    }
    if (sys.includes("Explain the answer")) return JSON.stringify({ text: `${field("Correct answer")} is right. Bit double-checked it.` });
    if (sys.includes("end-of-round recap")) return JSON.stringify({ text: recapText(field("Player")) });
    return "{}";
  }

  window.__PT_TEST_ANNA__ = {
    theme: "dark",
    storage: {
      async get({ key }){ await sleep(5); return key in mem ? { exists: true, value: JSON.parse(JSON.stringify(mem[key])) } : { exists: false }; },
      async set({ key, value }){ await sleep(5); mem[key] = JSON.parse(JSON.stringify(value)); persist(); return {}; },
      async delete({ key }){ delete mem[key]; persist(); return {}; },
      async list(){ return { items: Object.keys(mem).map(key => ({ key })) }; }
    },
    window: { async set_title(){ return {}; } },
    mobile: { async share(){ throw Object.assign(new Error("mobile only"), { code: "not_supported" }); }, async haptics(){ return {}; } },
    llm: {
      async complete(req){ window.__calls.push("llm:" + (req.systemPrompt || "").slice(0, 60)); await sleep(150); return { role: "assistant", content: { type: "text", text: llmReply(req) } }; }
    },
    tools: {
      async invoke({ tool_id, method, args }){
        window.__calls.push("tool:" + method);
        await sleep(120);
        if (window.__TOOL_BROKEN) throw Object.assign(new Error("tool not installed"), { code: "tool_not_found" });
        if (tool_id !== "tool-dev-pixel-trivia-quizmaster") throw new Error("wrong tool id " + tool_id);
        const ok = data => ({ success: true, data });
        if (method === "ping") return ok({ pong: true, version: "0.1.1" });
        if (method === "make_lesson") return ok(lesson(args.topic));
        if (method === "make_quiz") return ok({ questions: genQs(args.topic || args.subject, (args.count || 5) + 2), dropped: 0, checked: false });
        if (method === "check_quiz") return ok(check(args.questions));
        if (method === "explain") return ok({ text: `${args.a} is right. Bit double-checked it.` });
        if (method === "recap") return ok({ text: recapText(args.name) });
        return { success: false, error: "unknown method" };
      }
    }
  };
  window.__FAKE = { bank, mem };
})();
