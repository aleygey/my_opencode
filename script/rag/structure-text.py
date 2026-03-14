#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LAST_LLM_AT = 0.0
IMAGE_ID_RE = re.compile(r"\[IMAGE:([^\]]+)\]")
IMAGE_OCR_RE = re.compile(r"\[IMAGE_OCR\][\s\S]*?\[/IMAGE_OCR\]")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def strip_inline_ocr(text: str) -> str:
    out = IMAGE_OCR_RE.sub("", text)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def image_ids(text: str) -> list[str]:
    return sorted(set(IMAGE_ID_RE.findall(text)))


def split_sections(text: str) -> list[dict]:
    rows = []
    title = "document"
    buf = []
    for line in text.splitlines():
        if re.match(r"^#{1,6}\s+", line):
            body = "\n".join(buf).strip()
            if body:
                rows.append({"title": title, "text": body})
            title = re.sub(r"^#{1,6}\s+", "", line).strip()
            buf = []
            continue
        buf.append(line)
    body = "\n".join(buf).strip()
    if body:
        rows.append({"title": title, "text": body})
    return rows


def chunk_text(text: str, size: int, overlap: int) -> list[str]:
    if len(text) <= size:
        return [text]
    out = []
    i = 0
    while i < len(text):
        out.append(text[i : i + size])
        if i + size >= len(text):
            break
        i += max(1, size - overlap)
    return out


def rule_summary(text: str, n: int = 280) -> str:
    s = clean(text)
    if len(s) <= n:
        return s
    return s[:n].rstrip() + " ..."


def throttle(interval: float) -> None:
    global LAST_LLM_AT
    if interval <= 0:
        return
    now = time.monotonic()
    wait = LAST_LLM_AT + interval - now
    if wait > 0:
        time.sleep(wait)
    LAST_LLM_AT = time.monotonic()


def is_rate_limit_error(e: Exception) -> bool:
    s = str(e).lower()
    return "rate limit" in s or "too many requests" in s or "429" in s


def with_retry(
    fn,
    *,
    min_interval: float,
    max_retries: int,
    retry_initial: float,
) -> str:
    delay = max(0.1, retry_initial)
    n = 0
    while True:
        throttle(min_interval)
        try:
            return fn()
        except Exception as e:
            if not is_rate_limit_error(e) or n >= max_retries:
                raise
            n += 1
            print(
                f"[llm] rate limit; retry {n}/{max_retries} after {delay:.1f}s",
                file=sys.stderr,
            )
            time.sleep(delay)
            delay = min(delay * 2, 30)


def llama_summary(
    text: str,
    model: str,
    *,
    min_interval: float,
    max_retries: int,
    retry_initial: float,
) -> str:
    if importlib.util.find_spec("llama_index.llms.openai") is None:
        raise SystemExit(
            "llama-index is not installed in this Python environment. "
            "Use ./.venv-docling/bin/python -m pip install -r script/rag/requirements-llamaindex.txt"
        )

    prompt = (
        "Summarize the following text in Chinese, keep factual key points in 3 sentences max.\n\n"
        f"{text[:6000]}"
    )

    def key() -> str:
        k = os.getenv("OPENAI_API_KEY") or os.getenv("MINIMAX_API_KEY")
        if k:
            return k
        raise SystemExit(
            "OPENAI_API_KEY is required for --mode llamaindex "
            "(MINIMAX_API_KEY is also accepted)."
        )

    def compat() -> str:
        from openai import OpenAI as OpenAIClient

        client = OpenAIClient(
            api_key=key(),
            base_url=os.getenv("OPENAI_BASE_URL") or None,
        )
        res = client.chat.completions.create(
            model=model,
            temperature=0,
            messages=[{"role": "user", "content": prompt}],
        )
        msg = res.choices[0].message.content if res.choices else ""
        return clean(msg or "")

    from llama_index.llms.openai import OpenAI

    try:
        return with_retry(
            lambda: clean(
                OpenAI(
                    model=model,
                    temperature=0,
                    api_base=os.getenv("OPENAI_BASE_URL"),
                    api_key=key(),
                ).complete(prompt).text
            ),
            min_interval=min_interval,
            max_retries=max_retries,
            retry_initial=retry_initial,
        )
    except ValueError as e:
        if "Unknown model" not in str(e):
            raise
        if not os.getenv("OPENAI_BASE_URL"):
            raise SystemExit(
                f"Unknown model '{model}'. Set OPENAI_BASE_URL to your compatible endpoint, "
                "for example: https://api.minimaxi.com/v1"
            )
        return with_retry(
            compat,
            min_interval=min_interval,
            max_retries=max_retries,
            retry_initial=retry_initial,
        )


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--text", required=True)
    p.add_argument("--images", required=False, default="")
    p.add_argument("--output", required=True)
    p.add_argument("--source-url", required=False, default="")
    p.add_argument("--mode", choices=["rule", "llamaindex"], default="rule")
    p.add_argument("--model", default="gpt-4o-mini")
    p.add_argument("--llm-min-interval", type=float, default=1.0)
    p.add_argument("--llm-max-retries", type=int, default=6)
    p.add_argument("--llm-retry-initial", type=float, default=1.5)
    p.add_argument("--inline-ocr", choices=["strip", "keep"], default="strip")
    p.add_argument("--chunk-size", type=int, default=1600)
    p.add_argument("--chunk-overlap", type=int, default=200)
    args = p.parse_args()

    text_path = Path(args.text)
    src = read(text_path)
    sections = split_sections(src)

    image_rows = []
    image_map = {}
    if args.images:
        rows = json.loads(read(Path(args.images)))
        image_rows = rows.get("images", [])
        for item in image_rows:
            image_map[item["id"]] = item

    out_sections = []
    chunks = []
    nodes = []
    for si, sec in enumerate(sections):
        body = strip_inline_ocr(sec["text"]) if args.inline_ocr == "strip" else sec["text"]
        ids = image_ids(body)
        summary = rule_summary(body)
        if args.mode == "llamaindex":
            summary = llama_summary(
                body,
                args.model,
                min_interval=args.llm_min_interval,
                max_retries=args.llm_max_retries,
                retry_initial=args.llm_retry_initial,
            )

        out_sections.append(
            {
                "id": f"sec-{si}",
                "title": sec["title"],
                "summary": summary,
                "image_ids": ids,
                "images": [image_map[i] for i in ids if i in image_map],
                "text": body,
            }
        )

        parts = chunk_text(body, args.chunk_size, args.chunk_overlap)
        for ci, body in enumerate(parts):
            ids2 = image_ids(body)
            chunk = {
                "id": f"sec-{si}-chunk-{ci}",
                "type": "text",
                "section_id": f"sec-{si}",
                "section_title": sec["title"],
                "text": body,
                "image_ids": ids2,
                "metadata": {
                    "source_url": args.source_url,
                    "text_file": str(text_path),
                    "char_len": len(body),
                },
            }
            chunks.append(chunk)
            nodes.append(chunk)

    image_nodes = []
    for item in image_rows:
        iid = item.get("id")
        if not iid:
            continue
        refs = [sec["id"] for sec in out_sections if iid in sec["image_ids"]]
        text = clean("\n".join(x for x in [item.get("alt", ""), item.get("ocr_text", "")] if x))
        image = {
            "id": f"image-{iid}",
            "type": "image",
            "image_id": iid,
            "section_ids": refs,
            "source_url": item.get("url", ""),
            "alt": item.get("alt", ""),
            "ocr_text": item.get("ocr_text", ""),
            "text": text,
            "metadata": {
                "source_url": args.source_url,
                "text_file": str(text_path),
                "ocr_chars": item.get("ocr_chars", len(item.get("ocr_text", "") or "")),
                "status": item.get("status", ""),
            },
        }
        image_nodes.append(image)
        nodes.append(image)

    out = {
        "source_url": args.source_url,
        "text_file": str(text_path),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "inline_ocr": args.inline_ocr,
        "sections": out_sections,
        "chunks": chunks,
        "image_nodes": image_nodes,
        "nodes": nodes,
    }
    Path(args.output).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
