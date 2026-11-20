#!/usr/bin/env python3
"""Check Bit the Quizmaster's Executa the way the Anna Agent talks to it, plus its release archives.

  python scripts/test_protocol.py                 # builds a native binary with Go, then tests it
  python scripts/test_protocol.py --binary PATH   # test a specific binary
  python scripts/test_protocol.py --archives      # also check every archive in executas/quizmaster/dist

Plays the host: initialize / describe / invoke(ping), then every AI method, answering the tool's
reverse sampling/createMessage requests with canned replies shaped like the real model's. It checks:
one JSON object per stdout line, echoed ids, an unwrapped describe equal to manifest.json, the six
allowed parameter types, that make_quiz drops malformed / time-sensitive / give-away questions and
any question the blind second check disagrees with, and that the process is still alive afterwards.
"""
from __future__ import annotations

import argparse, json, re, subprocess, sys, tarfile, tempfile, time, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "executas" / "quizmaster"
TYPES = {"string", "integer", "number", "boolean", "array", "object"}

LESSON = {"title": "Gods of Asgard", "intro": "Hoot! Let's meet the Norse gods.", "cards": [
    {"title": "Odin the All-Father", "fact": "Odin gave up one eye to drink from Mimir's well of wisdom.", "hook": "One eye, all the wisdom."},
    {"title": "Thor's hammer", "fact": "Thor's hammer is called Mjolnir and always returns to his hand.", "hook": "Mjolnir boomerangs home."},
    {"title": "Sleipnir", "fact": "Odin rides Sleipnir, an eight-legged horse.", "hook": "Eight legs, double the speed."}]}

QUESTIONS = [
    {"q": "What is the name of Thor's hammer?", "a": "Mjolnir", "wrong": ["Gungnir", "Draupnir", "Skidbladnir"], "exp": "Mjolnir is Thor's hammer.", "hint": "It starts with M."},
    {"q": "How many legs does Sleipnir have?", "a": "Eight", "wrong": ["Four", "Six", "Ten"], "exp": "Sleipnir has eight legs.", "hint": "Twice a normal horse."},
    {"q": "What did Odin give up for wisdom?", "a": "An eye", "wrong": ["A hand", "His voice", "His spear"], "exp": "Odin gave an eye at Mimir's well.", "hint": "Think of his look."},
    {"q": "Who is currently the most popular Norse god?", "a": "Thor", "wrong": ["Odin", "Loki", "Freya"], "exp": "", "hint": ""},   # time-sensitive -> dropped
    {"q": "Which god is Loki's son Fenrir?", "a": "A wolf", "wrong": ["A wolf", "A snake"], "exp": "", "hint": ""},              # 2 distinct wrong -> dropped
    {"q": "Which Norse goddess, Frigg, was Odin's wife?", "a": "Frigg", "wrong": ["Freya", "Sif", "Hel"], "exp": "", "hint": ""},  # gives answer away -> dropped
    {"q": "Which tree links the nine worlds?", "a": "Yggdrasil", "wrong": ["Mimameid", "Laerad", "Glasir"], "exp": "The world tree is Yggdrasil.", "hint": "A great ash."},
]
# The blind check deliberately "disagrees" on this one, so it must be dropped:
DISAGREE = "Which tree links the nine worlds?"
ANSWERS = {q["q"]: q["a"] for q in QUESTIONS}


def canned(params: dict) -> dict:
    system = params.get("systemPrompt") or ""
    user = params["messages"][0]["content"]["text"]
    if "bite-size lesson" in system:
        text = "Here you go:\n```json\n" + json.dumps(LESSON) + "\n```"
    elif "You write multiple-choice questions" in system:
        assert "Lesson:" in user and "Odin" in user, "the lesson should reach the quiz prompt"
        text = json.dumps({"questions": QUESTIONS})
    elif "fact-checker" in system:
        answers = []
        for block in user.strip().split("\n\n"):
            rows = block.strip().split("\n")
            q = re.sub(r"^\d+\.\s*", "", rows[0])
            opts = {r[0]: r[3:] for r in rows[1:]}
            want = ANSWERS[q]
            pick = next(L for L, o in opts.items() if o == want)
            if q == DISAGREE:
                pick = next(L for L, o in opts.items() if o != want)
            answers.append(pick)
        text = json.dumps({"answers": answers})
    elif "Explain the answer" in system:
        text = '{"text": "Mjolnir is Thor\'s hammer; Gungnir is Odin\'s spear."}'
    elif "end-of-round recap" in system:
        text = '{"text": "Great work on Thor\'s hammer. Review Sleipnir next."}'
    else:
        raise AssertionError("unexpected sampling request: " + system[:80])
    return {"role": "assistant", "content": {"type": "text", "text": text}, "model": "test", "stopReason": "endTurn"}


def test_binary(binary: str) -> None:
    t0 = time.time()
    p = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")

    def send(o):
        p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()

    def recv():
        line = p.stdout.readline()
        assert line.endswith("\n"), f"response must end with a newline: {line!r}"
        return json.loads(line)

    def call(rid, tool, args):
        """invoke a tool, serving any sampling requests it makes; returns the result."""
        send({"jsonrpc": "2.0", "id": rid, "method": "invoke", "params": {"tool": tool, "arguments": args}})
        samples = 0
        while True:
            m = recv()
            if m.get("method") == "sampling/createMessage":
                prm = m["params"]
                assert prm["messages"][0]["content"]["type"] == "text" and prm["systemPrompt"] and prm["maxTokens"] > 0
                send({"jsonrpc": "2.0", "id": m["id"], "result": canned(prm)})
                samples += 1
                continue
            assert m["id"] == rid, m
            return m["result"], samples

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    r = recv(); assert r["id"] == 1 and "capabilities" in r["result"], r
    send({"jsonrpc": "2.0", "id": 2, "method": "describe"})
    r = recv(); assert r["id"] == 2, r
    startup = time.time() - t0
    d = r["result"]; assert "manifest" not in d and "success" not in d, "describe must not be wrapped"
    assert d == json.loads((SRC / "manifest.json").read_text(encoding="utf-8")), "describe differs from manifest.json"
    for t in d["tools"]:
        assert isinstance(t["parameters"], list)
        for prm in t["parameters"]:
            assert prm["type"] in TYPES, prm

    res, n = call("p", "ping", {}); assert res["success"] and res["data"]["pong"] and n == 0, res

    res, n = call(3, "make_lesson", {"subject": "Mythology", "topic": "Norse myths", "level": "easy", "cards": 3})
    assert res["success"] and len(res["data"]["cards"]) == 3 and res["data"]["title"] == "Gods of Asgard", res

    lesson_text = "\n".join(c["fact"] for c in LESSON["cards"])
    res, n = call(4, "make_quiz", {"subject": "Mythology", "topic": "Norse myths", "count": 5, "lesson": lesson_text})
    assert res["success"], res
    qs = res["data"]["questions"]
    got = [q["q"] for q in qs]
    assert got == [QUESTIONS[0]["q"], QUESTIONS[1]["q"], QUESTIONS[2]["q"]], got   # 3 format drops + 1 check drop
    assert res["data"]["checked"] is True and res["data"]["dropped"] == 4 and n == 2, res
    assert all(len(q["wrong"]) == 3 and q["exp"] and q["hint"] for q in qs)

    res, n = call(5, "make_quiz", {"subject": "Mythology", "topic": "Norse myths", "count": 2, "lesson": lesson_text, "check": False})
    assert res["success"] and len(res["data"]["questions"]) == 2 and res["data"]["checked"] is False and n == 1, res

    res, n = call(6, "check_quiz", {"questions": [QUESTIONS[0], QUESTIONS[6]]})
    assert res["success"] and res["data"]["keep"] == [True, False], res

    res, _ = call(7, "explain", {"q": QUESTIONS[0]["q"], "a": "Mjolnir", "chosen": "Gungnir"})
    assert res["success"] and "Gungnir" in res["data"]["text"], res
    res, _ = call(8, "recap", {"name": "Ammar", "subject": "Mythology", "topic": "Norse myths", "right": 2, "total": 3, "missed": ["How many legs does Sleipnir have? -> Eight"]})
    assert res["success"] and res["data"]["text"], res

    res, n = call(9, "make_lesson", {"subject": "Mythology"}); assert res["success"] is False and n == 0, res
    res, n = call(10, "nope", {}); assert res["success"] is False, res

    send({"jsonrpc": "2.0", "id": 11, "method": "health"})
    r = recv(); assert r["id"] == 11 and r["result"]["status"] == "ready", r   # still alive after replying
    p.stdin.close(); p.wait(timeout=10)
    print(f"protocol OK: {binary}  (describe answered in {startup*1000:.0f} ms)")


def test_archives() -> None:
    version = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))["version"]
    arts = json.loads((SRC / "executa.json").read_text(encoding="utf-8"))["distribution"]["profiles"]["binary"]["binary_artifacts"]
    for platform, art in arts.items():
        path = SRC / art["path"].replace("{version}", version)
        assert path.exists(), f"missing {path.name} — run scripts/build_binary.py"
        exe = art["entrypoint"]
        with tempfile.TemporaryDirectory() as tmp:
            if art["format"] == "zip":
                with zipfile.ZipFile(path) as z:
                    assert set(z.namelist()) == {"manifest.json", exe}, z.namelist()
                    assert (z.getinfo(exe).external_attr >> 16) & 0o111
                    z.extractall(tmp)
            else:
                with tarfile.open(path) as t:
                    assert set(t.getnames()) == {"manifest.json", exe}, t.getnames()
                    assert t.getmember(exe).mode & 0o111, "executable bit missing"
                    t.extractall(tmp, filter="data")
            m = json.loads((Path(tmp) / "manifest.json").read_text(encoding="utf-8"))
            assert m["version"] == version and m["runtime"]["binary"]["entrypoint"] == exe
            assert m["runtime"]["binary"]["permissions"][exe] == "0o755"
        print(f"archive OK: {path.name}")


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--binary"); ap.add_argument("--archives", action="store_true"); a = ap.parse_args()
    binary = a.binary
    if not binary:
        out = Path(tempfile.mkdtemp()) / ("quizmaster.exe" if sys.platform == "win32" else "quizmaster")
        subprocess.run(["go", "build", "-o", str(out), "."], cwd=SRC, check=True)
        binary = str(out)
    test_binary(binary)
    if a.archives:
        test_archives()
    return 0


if __name__ == "__main__":
    sys.exit(main())
