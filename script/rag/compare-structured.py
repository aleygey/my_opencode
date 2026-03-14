#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

OCR_RE = re.compile(r"\[IMAGE_OCR\][\s\S]*?\[/IMAGE_OCR\]")


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8", errors="ignore"))


def metrics(data: dict) -> dict:
    chunks = data.get("chunks", [])
    sections = data.get("sections", [])
    image_nodes = data.get("image_nodes", [])
    nodes = data.get("nodes", [])
    txt = [x.get("text", "") for x in chunks]
    chars = [len(x) for x in txt]
    with_ocr = sum(1 for x in txt if "[IMAGE_OCR]" in x)
    ocr_blocks = sum(len(OCR_RE.findall(x)) for x in txt)
    linked = sum(1 for x in chunks if (x.get("image_ids") or []))
    return {
        "chunks": len(chunks),
        "sections": len(sections),
        "image_nodes": len(image_nodes),
        "nodes": len(nodes),
        "chunks_with_image_refs": linked,
        "chunks_with_inline_ocr": with_ocr,
        "inline_ocr_blocks_in_chunks": ocr_blocks,
        "avg_chunk_chars": 0 if not chars else round(sum(chars) / len(chars), 2),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--old", required=True)
    p.add_argument("--new", required=True)
    args = p.parse_args()

    old = metrics(load(Path(args.old)))
    new = metrics(load(Path(args.new)))
    keys = sorted(set(old) | set(new))
    diff = {k: (new.get(k, 0) - old.get(k, 0)) for k in keys}
    print(json.dumps({"old": old, "new": new, "delta_new_minus_old": diff}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
