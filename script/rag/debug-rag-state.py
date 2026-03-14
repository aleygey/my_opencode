#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def read_rows(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--log", default=".rag/log/rag_debug.jsonl")
    p.add_argument("--tail", type=int, default=80)
    p.add_argument("--session", default="")
    p.add_argument("--channel", default="")
    p.add_argument("--full", action="store_true")
    args = p.parse_args()

    path = Path(args.log)
    rows = read_rows(path)
    if args.session:
        rows = [x for x in rows if str(x.get("sessionID", "")) == args.session]
    if args.channel:
        rows = [x for x in rows if str(x.get("channel", "")) == args.channel]
    if not rows:
        raise SystemExit(f"no debug rows found in: {path}")

    view = rows[-max(1, args.tail) :]
    events = Counter(str(x.get("event", "")) for x in view)
    statuses = Counter(str(x.get("status", "")) for x in view if x.get("status"))
    clusters = Counter(str(x.get("cluster", "")) for x in view if x.get("cluster"))
    channels = Counter(str(x.get("channel", "")) for x in view if x.get("channel"))
    modes = Counter(str(x.get("mode", "")) for x in view if x.get("mode"))

    print(json.dumps({
        "log": str(path),
        "rows_total": len(rows),
        "rows_view": len(view),
        "channels": dict(channels),
        "events": dict(events),
        "statuses": dict(statuses),
        "modes": dict(modes),
        "top_clusters": clusters.most_common(10),
    }, ensure_ascii=False, indent=2))

    print("\nlast_rows:")
    for item in view[-20:]:
        keep = item if args.full else {
            "ts": item.get("ts", ""),
            "channel": item.get("channel", ""),
            "event": item.get("event", ""),
            "sessionID": item.get("sessionID", ""),
            "query": item.get("query", ""),
            "cluster": item.get("cluster", ""),
            "mode": item.get("mode", ""),
            "loop": item.get("loop", ""),
            "used_cache": item.get("used_cache", ""),
            "status": item.get("status", ""),
            "reason": item.get("reason", ""),
            "rewrite_mode": item.get("rewrite_mode", ""),
            "keywords": item.get("keywords", []),
            "total_hits": item.get("total_hits", ""),
            "delta_hits": item.get("delta_hits", ""),
            "known_hits": item.get("known_hits", ""),
            "overlap": item.get("overlap", ""),
            "top_hits": item.get("top_hits", []),
            "delta_fps": item.get("delta_fps", []),
            "rewrites": item.get("rewrites", []),
            "emitted_context": item.get("emitted_context", ""),
        }
        print(json.dumps(keep, ensure_ascii=False))


if __name__ == "__main__":
    main()
