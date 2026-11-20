#!/usr/bin/env python3
"""Copy the AI prompts from executas/quizmaster/prompts.json (the single source of truth, embedded
in the Go tool) into bundle/lib/prompts.js, which the app uses when it talks to Anna's AI directly.

  python scripts/sync_prompts.py           # write bundle/lib/prompts.js
  python scripts/sync_prompts.py --check   # exit 1 if bundle/lib/prompts.js is out of date
"""
from __future__ import annotations

import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "executas" / "quizmaster" / "prompts.json"
DST = ROOT / "bundle" / "lib" / "prompts.js"


def render() -> str:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    data.pop("_comment", None)
    body = json.dumps(data, indent=2, ensure_ascii=False)
    return ("/* AUTO-GENERATED from executas/quizmaster/prompts.json by scripts/sync_prompts.py. Do not edit here. */\n"
            f"export const PROMPTS = {body};\n")


def main() -> int:
    out = render()
    if "--check" in sys.argv:
        if not DST.exists() or DST.read_text(encoding="utf-8") != out:
            print("bundle/lib/prompts.js is out of date: run python scripts/sync_prompts.py")
            return 1
        print("prompts in sync")
        return 0
    DST.write_text(out, encoding="utf-8")
    print(f"wrote {DST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
