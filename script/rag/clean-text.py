#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path


def normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def drop_noise(lines: list[str]) -> list[str]:
    out = []
    seen = set()
    for line in lines:
        row = line.strip()
        if not row:
            out.append("")
            continue
        if row.startswith("[上一页 ") or row.startswith("[下一页 "):
            continue
        if row.startswith("- [") and row.endswith(")"):
            continue
        if row == "<!-- image -->":
            continue
        key = re.sub(r"\s+", " ", row)
        if key in seen and len(key) > 80:
            continue
        seen.add(key)
        out.append(line)
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()

    src = Path(args.input).read_text(encoding="utf-8", errors="ignore")
    rows = drop_noise(src.splitlines())
    out = normalize("\n".join(rows))
    Path(args.output).write_text(out, encoding="utf-8")


if __name__ == "__main__":
    main()

