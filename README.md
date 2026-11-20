# Pixel Trivia — Anna Edition

A retro learn-then-quiz game for the Anna AI OS. Bit, a pixel-owl quizmaster, writes a one-minute lesson
on a topic (four fact cards, each with a memory trick), then a quiz on what the player just read. Every
question is fact-checked by a second, blind AI pass. Missed questions come back on a spaced-review schedule;
players earn XP, levels, subject stars, a daily streak and badges, and can challenge friends with codes.
Progress is saved to the player's Anna account.

## What's in this folder

```
app.json                  store listing: name, description, category, logo, screenshots, bundled tool
manifest.json             window, phone + desktop, web-share permission, CSP, Anna assistant instructions
PRIVACY.md                privacy policy (host it and add its link as "privacy_url" in app.json)
bundle/                   the app itself (what Anna shows in its window)
  index.html              markup only: no inline scripts or styles (Anna's CSP blocks them)
  style.css               all styling; the Press Start 2P font is served from bundle/fonts (SIL OFL)
  app.js                  screens and the game loop (ES module; loads Anna's SDK at runtime)
  lib/data.js             14 subjects × 8 topics, 112 built-in questions, 12 badges
  lib/ai.js               every AI call: the quizmaster tool first, Anna's AI directly as fallback
  lib/prompts.js          AUTO-GENERATED copy of executas/quizmaster/prompts.json
  lib/progress.js         XP, levels, subject stars and difficulty, streak, badges, review schedule
  lib/social.js           challenge and reply codes, rivals board, share/copy
  lib/store.js            Anna storage (browser storage in a plain preview)
  lib/sprites.js          Bit and the 8 avatars (original pixel art drawn as SVG)
  lib/fx.js               chiptune sounds, falling stars, pixel bursts, haptics
  anna-tool-ids.js        written by `anna-app dev` / `apps publish`
assets/                   logo (512 + 1024 px) and five store screenshots (2560×1600)
executas/quizmaster/      the backend tool, "Bit the Quizmaster" (Go standard library → one static binary)
  main.go                 JSON-RPC over stdio; make_lesson / make_quiz / check_quiz / explain / recap / ping
  prompts.json            all AI prompts: the single source of truth, embedded into the binary
  manifest.json           what `describe` returns (embedded into the binary)
  executa.json            local + binary distribution profiles, one archive per platform
  dist/                   ready-built v0.1.1 archives for Linux x64/ARM, macOS ARM/Intel, Windows x64
fixtures/llm.jsonl        canned AI reply for offline testing
scripts/                  build_binary.py, test_protocol.py, sync_prompts.py
tests/                    e2e.py (full browser test) + fake-anna.js (test-only stand-in for Anna)
```

## How the game works

1. **First run:** name + avatar, at least three favourite subjects, then a 5-question placement round from
   the built-in deck. A subject where the player gets at least half right starts at medium difficulty.
2. **Today's Quest** (home screen) picks a favourite subject and its next unread topic. Any topic can also be
   chosen from a subject's page.
3. **Learn:** Bit's lesson, four cards. The quiz is written and checked in the background while the player reads.
4. **Quiz:** five questions from the lesson, plus up to two review cards that are due in that subject. 20 seconds each,
   keys 1-4, combo multiplier up to ×5, a hint (H) that removes two options for half points, WHY? for an
   explanation, REPORT for a bad question.
5. **Results:** score, XP (+20 for the lesson), level-ups, stars, badges, Bit's recap, missed answers, and
   CHALLENGE A FRIEND.

Other modes: **Quick quiz** (5/10/15 questions on one subject or a random mix, written in batches of five while
you play), **Review** (due cards: missed questions come back after 1, 3, 7 and 14 days, then count as mastered),
**Challenges**, **Scores** (top 10 rounds, rivals) and **Profile** (badges, mastery, settings, reset).

Difficulty per subject follows its stars (0–1 easy, 2–3 medium, 4–5 hard) and is nudged up or down by the last ten
answers in that subject.

## How the AI works

* **Lessons** call the tool's `make_lesson`.
* **Quizzes** are two calls, so each stays inside Anna's 90-second tool limit: `make_quiz` writes a few spare
  questions, then `check_quiz` answers every question blind (options shuffled, no answer key). Any question
  where the blind answer disagrees with the key is dropped. Questions that pass show **BY BIT · FACT-CHECKED**.
* **Format checks**, in both `main.go` and `lib/ai.js`: exactly one answer and three different wrong options,
  length limits, no "all/none of the above", no time-sensitive wording ("currently", "latest"…), and no
  question that contains its own answer.
* **WHY?** uses `explain`, and the end-of-round recap uses `recap`.
* **Fallback:** if the tool isn't installed or reachable, the same prompts go to `anna.llm.complete`, and
  Profile → BIT'S HELPER TOOL says "USING ANNA'S AI DIRECTLY". When the tool runs but one answer comes back
  unusable (Anna reports `tool_failed`), only that call falls back.
* **Built-in deck:** 112 questions, used for the placement round, for preview mode outside Anna, and to
  top up a quiz if the AI fails.
* **Anna's assistant** can quiz the user in chat: `system_prompt_addendum` in `manifest.json` tells it
  to call `make_quiz` and ask one question at a time.

**Editing prompts:** change `executas/quizmaster/prompts.json`, run `python scripts/sync_prompts.py` (updates
`bundle/lib/prompts.js`), then rebuild the tool, because the binary embeds the file.

## How storage works

`anna.storage`, the app's own bucket, keys under `pixeltrivia/`:

| key | value |
| --- | --- |
| `profile` | name, avatar, favourite subjects, random player id, sound / read-aloud settings |
| `progress` | XP, per-subject progress, streak, badges, stats, top 10, recently seen questions, lesson card titles |
| `review` | missed questions with their review box and due date (capped at 150) |
| `social` | challenges sent and played (30 each) and the rivals board |

Writes are debounced and retried. Outside Anna (opening `bundle/` from a plain web server) the same code uses the
browser's localStorage and the built-in deck, so you can preview without Anna.

## Challenges (no server yet)

A challenge code (`PXT1.…`, compressed JSON) carries the exact questions in display order plus the sender's
score. The friend pastes it into **CHALLENGES**, plays the same questions with the same timer and no hints, and
gets a reply code (`PXR1.…`) to send back. Both sides' rivals boards record the result once. Scores in codes
can't be verified without a server.

**Route B, later:** `lib/social.js` is the only place that knows how challenges travel, and every profile
already has a random player id (`pid`). Real accounts, friend lists and global leaderboards would add your own
small server (allowed through `csp_overrides` / `connect-src`), replace the encode/decode functions with calls to it,
and have the server hand out questions and mark answers so scores can't be faked.

## Test locally

```bash
npm i -g @anna-ai/cli                          # needs Node 22+ and uv
anna-app validate --strict
anna-app dev --mock-llm fixtures/llm.jsonl     # offline, canned AI → http://localhost:5180/
anna-app login --host https://anna.partners    # then, for real AI:
anna-app dev --storage aps                     # real Anna storage + AI on your account
python scripts/test_protocol.py --archives     # backend tool protocol + archive test (needs Go)
python tests/e2e.py                            # whole-app browser test (needs Python Playwright + Chrome)
```

* `anna-app dev` starts the backend tool with Go (`go run`). Without Go installed, the app still works in the
  harness and falls back to Anna's AI directly.
* The offline fixture gives the same canned reply to every AI call. Its questions show as "BY BIT" (unchecked),
  because the canned reply can't answer the blind check.

## Publish

1. **The tool is already built** (v0.1.1, all five platforms, in `executas/quizmaster/dist/`). Only rebuild after
   changing it: install Go 1.22+ from https://go.dev/dl/, run `python scripts/build_binary.py`, then
   `python scripts/test_protocol.py --archives`.
2. From this folder: `anna-app login --host https://anna.partners`, then `anna-app apps publish`.
   The first publish creates the app (`pixel-trivia`) and the tool, writes their identity into `.anna/`
   (keep that folder), writes the real tool id into `bundle/anna-tool-ids.js`, and uploads the logo and screenshots.
3. Install the draft on Anna, **on a Cloud Agent, from a fresh install**, and test end to end:
   * onboarding and the placement round;
   * a lesson and its quiz, where questions should say FACT-CHECKED;
   * Profile → BIT'S HELPER TOOL should say **✓ CONNECTED v0.1.1**;
   * a challenge between two Anna accounts;
   * the app on your phone.

   Then **Submit for review** in the Developer Console.

**Versions.** A published version is frozen. When the tool changes, bump `version` in **both**
`executas/quizmaster/manifest.json` and `executas/quizmaster/executa.json` (the build script refuses a mismatch),
rebuild, and bump the app's `version` in `app.json` (or use `anna-app apps publish --bump patch`).

## Before you submit

* **Privacy policy:** host `PRIVACY.md` somewhere public (as you did for Hearthside) and add its link to
  `app.json` as `"privacy_url"`.
* **Category:** `app.json` says `"education"`. If publishing rejects it, use `"productivity"`, which Anna accepted for Hearthside.

## Still to check on Anna's live platform

* **Speed:** a lesson is one AI call; its quiz is two more, made while the player reads. If Anna's AI is slow, the
  player sees "Bit is fact-checking your quiz..." for a moment when they tap START QUIZ.
* **SHARE button:** Anna's phone app opens the system share sheet. On desktop the browser's share is used where
  available, otherwise the message is copied for pasting.
* **Read aloud** uses the browser's built-in speech, which may be silent on some systems.

## Credits

Press Start 2P font by CodeMan38, SIL Open Font License (`bundle/fonts/OFL.txt`). Bit, the avatars, the built-in
questions and the code are original to this project. The prototype's Open Trivia DB connection has been removed,
so no third-party question content ships with the app.
