#!/usr/bin/env python3
"""End-to-end test of the Pixel Trivia bundle in Chrome, under a strict Anna-like CSP, with
tests/fake-anna.js standing in for Anna (storage, the quizmaster tool and the AI).

  python tests/e2e.py [--shots DIR]

Plays: onboarding + placement (with WHY?), a Norse-myths lesson and its quiz (hint, wrong answer,
keyboard), results + recap, a challenge sent to a second player who plays it and replies, the reply
scored back on the first player's rivals board, a review round, a 10-question quick quiz fetched in
chunks, a lesson with the tool broken (falls back to Anna's AI), the profile, the standalone preview
(no Anna, built-in deck) and a phone-sized layout. Fails on any CSP violation or console error.
"""
from __future__ import annotations

import argparse, functools, http.server, os, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "bundle"
FAKE = str(ROOT / "tests" / "fake-anna.js")
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'"
PORT = 8811
BASE = f"http://127.0.0.1:{PORT}/index.html"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


def serve():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=str(BUNDLE)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


LOOKUP = """async (q) => {
  if (window.__FAKE && window.__FAKE.bank[q]) return window.__FAKE.bank[q];
  const { DECK } = await import('/lib/data.js');
  for (const list of Object.values(DECK)) for (const [qq, a] of list) if (qq === q) return a;
  return null;
}"""


class Run:
    def __init__(self, browser, name, shots, viewport=(1280, 800), scale=2, query="", mobile=False):
        self.ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, device_scale_factor=scale, is_mobile=mobile, has_touch=mobile)
        self.ctx.add_init_script(path=FAKE)
        self.page = self.ctx.new_page()
        self.name, self.shots, self.errors = name, shots, []
        self.page.on("console", lambda m: self.errors.append(m.text) if m.type == "error" else None)
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.goto(BASE + query)

    def shot(self, fname):
        if self.shots:
            self.page.wait_for_timeout(450)
            self.page.screenshot(path=str(Path(self.shots) / fname))

    def click(self, sel):
        self.page.click(sel)

    def answer(self, correct=True, key=None, keep_feedback=False):
        pg = self.page
        pg.wait_for_selector("#qtext")
        q = pg.inner_text("#qtext")
        a = pg.evaluate(LOOKUP, q)
        assert a, f"{self.name}: no answer known for {q!r}"
        opts = pg.query_selector_all(".opts button")
        texts = pg.evaluate("() => [...document.querySelectorAll('.opts button')].map(b => b.lastChild.textContent.trim())")
        idx = next((i for i, t in enumerate(texts) if t == a), None) if correct else next(i for i, t in enumerate(texts) if t != a and not opts[i].is_disabled())
        assert idx is not None, (q, a, texts)
        if key:
            pg.keyboard.press(str(idx + 1))
        else:
            opts[idx].click()
        pg.wait_for_selector("#nextq")
        verdict = pg.inner_text(".feedback .verdict")
        assert ("CORRECT" in verdict) == correct, (q, verdict)
        if not keep_feedback:
            pg.click("#nextq")
        return q

    def check_clean(self):
        csp = self.page.evaluate("window.__csp || []")
        assert not csp, f"{self.name}: CSP violations {csp}"
        errs = [e for e in self.errors if "favicon" not in e]
        assert not errs, f"{self.name}: console errors {errs}"


def onboard(r, name, av, subs, placement=True):
    pg = r.page
    pg.wait_for_selector("#nm")
    pg.fill("#nm", name); r.click(f"[data-av={av}]"); r.click("#go")
    pg.wait_for_selector("[data-c]")
    assert pg.is_disabled("#go")
    for s in subs:
        r.click(f"[data-c={s}]")
    r.click("#go")
    pg.wait_for_selector("#skip")
    if not placement:
        r.click("#skip")
    else:
        r.click("#go")
        for i in range(5):
            if i == 0 and "noanna" not in pg.url:   # built-in questions have no stored explanation: WHY? asks Bit
                r.answer(correct=False, keep_feedback=True)
                r.click("#why"); pg.wait_for_selector("#exp >> text=is right")
                r.click("#nextq")
            else:
                r.answer(correct=True)
        pg.wait_for_selector("text=ALL SET!")
        assert "MEDIUM" in pg.inner_text(".bubble"), pg.inner_text(".bubble")
    pg.wait_for_selector("text=ALL SET!")
    r.click("#go")
    pg.wait_for_selector("#quest")


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--shots"); a = ap.parse_args()
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)
    httpd = serve()
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])

        # ---------- player 1: onboarding, lesson, quiz, results ----------
        r1 = Run(b, "player1", a.shots, query="?user=u1")
        pg = r1.page
        onboard(r1, "Nova", "frog", ["mythology", "science", "history"])
        print("onboarding + placement OK")
        pg.wait_for_timeout(1800)   # tool ping
        r1.click("#prof"); pg.wait_for_selector("#toolst >> text=CONNECTED")
        assert "v0.1.1" in pg.inner_text("#toolst")
        r1.click("#back")

        r1.click("[data-c=mythology]"); pg.wait_for_selector("[data-t='Norse myths']")
        r1.click("[data-t='Norse myths']")
        pg.wait_for_selector(".lesson-card")
        assert "Odin" in pg.inner_text(".lesson-card")
        r1.shot("2-lesson.png")
        for _ in range(3):
            pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(120)
        assert "CARD 4/4" in pg.inner_text(".lesson-card")
        r1.click("#next")
        pg.wait_for_selector("#qtext")
        assert "FACT-CHECKED" in pg.inner_text(".qcat"), pg.inner_text(".qcat")
        hud = pg.inner_text(".hud"); assert "Q 1/5" in hud, hud    # 7 written, 1 dropped by the check, 5 kept
        r1.answer(correct=True, keep_feedback=True)
        assert pg.inner_text("#hudScore") != "0", "score in the top bar should update"
        r1.shot("3-quiz.png")
        r1.click("#nextq")
        r1.answer(correct=False)                       # goes to the review pile
        pg.keyboard.press("h"); pg.wait_for_selector("#hintline:not([hidden])")
        assert len(pg.query_selector_all(".opts button.gone")) == 2
        r1.answer(correct=True)
        r1.answer(correct=True, key=True)              # keyboard 1-4
        r1.answer(correct=True)
        pg.wait_for_selector("#recap >> text=Great run")
        res = pg.inner_text("#app")
        assert "4/5 CORRECT" in res and "MISSED (1)" in res and "NEW BADGE: FIRST STEPS" in res, res
        assert "DAILY STREAK: 1 DAY" in res, res
        r1.shot("4-results.png")
        calls = pg.evaluate("window.__calls")
        assert "tool:make_lesson" in calls and "tool:make_quiz" in calls and "tool:check_quiz" in calls and "tool:recap" in calls, calls
        assert not any(c.startswith("llm:") for c in calls), calls
        print("lesson -> quiz -> results OK (all through the tool)")

        r1.click("#chal"); pg.wait_for_selector("#code")
        code = pg.input_value("#code")
        assert "PXT1." in code and "NOVA challenged you" in code, code
        r1.click("#share"); pg.wait_for_selector("#toast:not([hidden])")
        r1.click("#back"); pg.wait_for_selector("#quest")
        print("challenge code made:", len(code), "chars")

        # ---------- player 2 plays the challenge ----------
        r2 = Run(b, "player2", a.shots, query="?user=u2")
        p2 = r2.page
        onboard(r2, "Zara", "knight", ["sports", "music", "art"], placement=False)
        r2.click("#chal"); p2.wait_for_selector("#paste")
        p2.fill("#paste", "hey!! " + code + " see you")
        r2.click("#open"); p2.wait_for_selector("text=CHALLENGES YOU!")
        assert "NOVA" in p2.inner_text("#app")
        r2.shot("5-challenge-intro.png")
        r2.click("#go")
        assert p2.query_selector("#hint") is None, "no hints in challenges"
        for _ in range(5):
            r2.answer(correct=True)
        p2.wait_for_selector("text=YOU WIN!")
        r2.shot("5-challenge.png")
        r2.click("#reply"); p2.wait_for_selector("#code")
        reply = p2.input_value("#code"); assert "PXR1." in reply
        r2.click("#back"); p2.wait_for_selector("#paste")
        assert "1W" in p2.inner_text("#app")
        # replaying the same code shows the stored result rather than recording again
        p2.fill("#paste", code); r2.click("#open"); p2.wait_for_selector("text=YOU WIN!")
        r2.check_clean()
        print("player 2 played the challenge and won")

        # ---------- player 1 opens the reply ----------
        r1.click("#chal"); pg.wait_for_selector("#paste")
        pg.fill("#paste", reply); r1.click("#open"); pg.wait_for_selector("text=THEY WIN!")
        r1.click("#list"); pg.wait_for_selector("#paste")
        txt = pg.inner_text("#app"); assert "ZARA" in txt and "1L" in txt, txt
        pg.fill("#paste", reply); r1.click("#open"); pg.wait_for_selector("text=THEY WIN!")    # no double count
        r1.click("#list"); pg.wait_for_selector("#paste"); assert "1L" in pg.inner_text("#app") and "2L" not in pg.inner_text("#app")
        pg.fill("#paste", code); r1.click("#open"); pg.wait_for_selector("text=THAT'S YOUR CHALLENGE"); pg.keyboard.press("Escape")
        pg.fill("#paste", "PXT1.garbage!!"); r1.click("#open"); pg.wait_for_selector("#toast:not([hidden])")
        r1.click("#back")
        print("reply scored on the rivals board")

        # ---------- review ----------
        pg.evaluate("""() => { const m = window.__FAKE.mem; const k = 'pixeltrivia/review'; m[k].items.forEach(i => i.due = 0); localStorage.setItem('fakeanna:u1', JSON.stringify(m)); }""")
        pg.reload(); pg.wait_for_selector("#quest")
        assert "REVIEW (" in pg.inner_text("#review")
        r1.click("#review"); pg.wait_for_selector("#qtext")
        assert "REVIEW CARD" in pg.inner_text(".qcat")
        nrev = int(pg.inner_text(".hud").split("/")[1].split()[0])
        for _ in range(nrev):
            r1.answer(correct=True)
        pg.wait_for_selector("#home")
        r1.click("#home")
        print(f"review round OK ({nrev} cards)")

        # ---------- quick quiz, 10 questions in chunks ----------
        r1.click("#quick"); r1.click("#lens [data-n='10']"); r1.click("[data-c=random]")
        for i in range(10):
            r1.answer(correct=i % 3 != 0)
        pg.wait_for_selector("#again")
        assert "/10 CORRECT" in pg.inner_text("#app")
        r1.click("#home")
        print("quick quiz (10, chunked) OK")

        # ---------- tool broken: falls back to Anna's AI ----------
        pg.evaluate("window.__TOOL_BROKEN = true; window.__calls.length = 0")
        r1.click("[data-c=science]"); pg.wait_for_selector("#learn")
        r1.click("#learn"); pg.wait_for_selector(".lesson-card")
        for _ in range(3):
            r1.click("#next"); pg.wait_for_timeout(80)
        r1.click("#next")
        pg.wait_for_selector("#qtext")
        assert "FACT-CHECKED" in pg.inner_text(".qcat")
        for _ in range(5):
            r1.answer(correct=True)
        pg.wait_for_selector("#recap >> text=Great run")
        calls = pg.evaluate("window.__calls")
        assert any(c.startswith("llm:You are Bit, the pixel owl") for c in calls) and any("fact-checker" in c for c in calls), calls
        r1.click("#home")
        r1.click("#prof"); pg.wait_for_selector("#toolst >> text=USING ANNA")
        r1.shot("profile.png")
        r1.click("#back")
        r1.check_clean()
        print("tool-broken fallback OK")

        # persisted across reload?
        pg.reload(); pg.wait_for_selector("#quest")
        assert "NOVA" in pg.inner_text(".player") and "LEVEL" in pg.inner_text(".player")
        r1.shot("1-home.png")
        r1.check_clean()

        # ---------- standalone preview (no Anna) ----------
        r3 = Run(b, "preview", a.shots, query="?noanna=1")
        p3 = r3.page
        onboard(r3, "Guest", "robot", ["animals", "food", "games"], placement=True)
        assert "PREVIEW MODE" in p3.inner_text("#app")
        r3.click("#quest")
        for _ in range(8):
            r3.answer(correct=True)
        p3.wait_for_selector("#again")
        assert "8/8" in p3.inner_text("#app") or "/8 CORRECT" in p3.inner_text("#app")
        r3.check_clean()
        print("standalone preview OK (built-in deck)")

        # ---------- phone layout ----------
        r4 = Run(b, "phone", a.shots, viewport=(390, 844), scale=2, query="?user=u4", mobile=True)
        p4 = r4.page
        onboard(r4, "Mo", "bunny", ["geography", "film", "tv"], placement=False)
        r4.shot("phone-home.png")
        sw = p4.evaluate("document.documentElement.scrollWidth"); assert sw <= 392, f"horizontal overflow on phone: {sw}"
        r4.click("[data-c=mythology]"); p4.click("[data-t='Norse myths']"); p4.wait_for_selector(".lesson-card")
        r4.shot("phone-lesson.png")
        for _ in range(4):
            r4.click("#next"); p4.wait_for_timeout(80)
        p4.wait_for_selector("#qtext"); r4.shot("phone-quiz.png")
        sw = p4.evaluate("document.documentElement.scrollWidth"); assert sw <= 392, f"horizontal overflow on phone quiz: {sw}"
        r4.check_clean()
        print("phone layout OK")
        b.close()
    httpd.shutdown()
    print("ALL E2E CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
