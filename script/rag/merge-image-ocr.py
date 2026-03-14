#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def read(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="ignore")


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def snippet(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    return text[:n].rstrip() + " ..."


def inline_block(image_id: str, text: str, limit: int, mode: str) -> str:
    if mode == "none":
        return ""
    if mode == "marker":
        return f"[IMAGE:{image_id}]"
    if not text:
        return f"[IMAGE:{image_id}]"
    body = snippet(text, limit)
    return f"[IMAGE:{image_id}]\n[IMAGE_OCR]\n{body}\n[/IMAGE_OCR]"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--text", required=True)
    p.add_argument("--meta", required=True)
    p.add_argument("--ocr-dir", required=True)
    p.add_argument("--sidecar", required=True)
    p.add_argument("--source-url", required=True)
    p.add_argument("--raw", required=False, default="")
    p.add_argument("--inline-limit", type=int, default=2000)
    p.add_argument("--inline-mode", choices=["ocr", "marker", "none"], default="marker")
    args = p.parse_args()

    text_path = Path(args.text)
    meta_path = Path(args.meta)
    ocr_dir = Path(args.ocr_dir)
    sidecar_path = Path(args.sidecar)

    raw = read(text_path)
    if args.raw:
        Path(args.raw).write_text(raw, encoding="utf-8")

    rows = json.loads(read(meta_path) or "[]")
    items = []
    for i, row in enumerate(rows):
        image_id = row.get("id") or f"img-{i}"
        files = sorted(ocr_dir.glob(f"{image_id}*.txt"))
        ocr_text = clean(read(files[0])) if files else ""
        items.append(
            {
                "id": image_id,
                "index": i,
                "url": row.get("url", ""),
                "alt": row.get("alt", ""),
                "ocr_text": ocr_text,
                "ocr_chars": len(ocr_text),
                "status": "ok" if ocr_text else "empty",
            }
        )

    marker = re.compile(r"<!--\s*image\s*-->")
    text = raw
    n = min(len(items), len(marker.findall(raw)))
    for i in range(n):
        block = inline_block(items[i]["id"], items[i]["ocr_text"], args.inline_limit, args.inline_mode)
        text = marker.sub(lambda _: block, text, count=1)

    text_path.write_text(text, encoding="utf-8")

    sidecar = {
        "source_url": args.source_url,
        "text_file": str(text_path),
        "raw_file": args.raw,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "images": items,
    }
    sidecar_path.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
