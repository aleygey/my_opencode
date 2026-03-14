#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def clip(text: str, n: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= n else s[:n].rstrip() + " ..."


def uniq(rows: list[str]) -> list[str]:
    seen = set()
    out = []
    for item in rows:
        val = str(item or "").strip()
        if not val or val in seen:
            continue
        seen.add(val)
        out.append(val)
    return out


def pick_json(text: str) -> dict:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("no json object found in rewrite response")
    return json.loads(text[start : end + 1])


def render_state(query: str, hits: list[dict], rewrite: dict) -> str:
    top = hits[0] if hits else {}
    status = "new_evidence" if hits else "need_refine"
    reason = "top_hits_available" if hits else "empty_hits"
    next_action = "use_delta_or_brief_only_if_needed" if hits else "refine_query_with_device_or_step"
    return "\n".join(
        [
            "<rag_state>",
            f"query={clip(query, 80)}",
            f"status={status}",
            f"reason={reason}",
            f"total_hits={len(hits)}",
            f"top_source={top.get('source_url', '')}",
            f"top_section={clip(top.get('section_title', ''), 48)}",
            f"rewrite_mode={rewrite.get('mode', 'none')}",
            f"rewrite_queries={json.dumps(rewrite.get('queries', []), ensure_ascii=False)}",
            f"next_action={next_action}",
            "</rag_state>",
        ]
    )


def render_brief(query: str, hits: list[dict], rewrite: dict, top_k: int) -> str:
    state = render_state(query, hits, rewrite)
    if not hits:
        return state
    body = []
    for i, item in enumerate(hits[: max(1, top_k)], start=1):
        body.append(
            " ".join(
                [
                    f"[{i}]",
                    f"source={item.get('source_url', '')}",
                    f"section={clip(item.get('section_title', ''), 48)}",
                    f"summary={clip(item.get('text_preview', ''), 120)}",
                ]
            )
        )
    return state + "\n" + "\n".join(body)


def auto_format(value: str) -> str:
    if value != "auto":
        return value
    if os.getenv("OPENCODE") == "1":
        return "state"
    return "json"


def need_rewrite(query: str) -> bool:
    text = str(query or "").strip()
    if len(text) >= 48:
        return True
    if text.count(" ") >= 5:
        return True
    marks = ["并且", "以及", "同时", "还有", "怎么", "如何", "步骤", "方式", "版本", "命令"]
    return sum(1 for x in marks if x in text) >= 2


def auto_rewrite(value: str, model: str, query: str) -> str:
    if value != "auto":
        return value
    if model and need_rewrite(query):
        return "llm"
    return "off"


def embed_query(client, model: str, text: str) -> list[float]:
    r = client.embeddings.create(model=model, input=[text])
    return r.data[0].embedding


def rewrite_query(client, model: str, query: str, limit: int) -> dict:
    if not model:
        return {"mode": "off", "queries": [query], "keywords": []}
    prompt = "\n".join(
        [
            "你是RAG检索改写器。",
            "目标：从长问题中提取真正的检索目标，去掉语义噪声。",
            "输出必须是 JSON 对象，不要输出解释。",
            f"最多给出 {max(1, limit)} 条 queries。",
            '返回格式：{"queries":["..."],"keywords":["..."]}',
            "要求：queries 应短、准、可用于 embedding 检索；keywords 只保留设备名、动作、文档对象、错误码、版本等关键信息。",
            f"原始问题：{query}",
        ]
    )
    try:
        res = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
        )
        text = res.choices[0].message.content or ""
    except Exception:
        return {"mode": "llm_error", "queries": [query], "keywords": []}
    try:
        data = pick_json(text)
    except Exception:
        return {"mode": "llm_fallback", "queries": [query], "keywords": []}
    queries = uniq([str(x) for x in data.get("queries", [])])[: max(1, limit)]
    if query not in queries:
        queries.insert(0, query)
    keywords = uniq([str(x) for x in data.get("keywords", [])])[:8]
    return {
        "mode": "llm",
        "queries": uniq(queries)[: max(1, limit)],
        "keywords": keywords,
    }


def related_images(qdrant, models, collection: str, ids: list[str], text_chars: int) -> list[dict]:
    out = []
    for iid in ids:
        flt = models.Filter(
            must=[
                models.FieldCondition(key="node_type", match=models.MatchValue(value="image")),
                models.FieldCondition(key="image_id", match=models.MatchValue(value=iid)),
            ]
        )
        points, _ = qdrant.scroll(
            collection_name=collection,
            scroll_filter=flt,
            with_payload=True,
            limit=1,
        )
        if not points:
            continue
        payload = points[0].payload or {}
        text = str(payload.get("text", ""))
        n = max(20, text_chars)
        preview = text if len(text) <= n else text[:n].rstrip() + " ..."
        out.append(
            {
                "image_id": iid,
                "source_url": payload.get("source_url", ""),
                "text_preview": preview,
            }
        )
    return out


def search(qdrant, models, collection: str, vec: list[float], limit: int, node_type: str):
    flt = None
    if node_type != "any":
        flt = models.Filter(
            must=[models.FieldCondition(key="node_type", match=models.MatchValue(value=node_type))]
        )
    if hasattr(qdrant, "query_points"):
        res = qdrant.query_points(
            collection_name=collection,
            query=vec,
            limit=max(1, limit),
            with_payload=True,
            query_filter=flt,
        )
        return res.points
    return qdrant.search(
        collection_name=collection,
        query_vector=vec,
        limit=max(1, limit),
        with_payload=True,
        query_filter=flt,
    )


def fp(payload: dict) -> str:
    src = str(payload.get("text_file", "") or payload.get("source_url", ""))
    ident = str(payload.get("chunk_id", "") or payload.get("image_id", "") or payload.get("section_title", ""))
    return f"{src}#{ident}"


def collect(points, qdrant, models, args, query: str) -> list[dict]:
    out = []
    for rank, item in enumerate(points, start=1):
        payload = item.payload or {}
        text = str(payload.get("text", ""))
        n = max(20, args.show_text_chars)
        preview = text if len(text) <= n else text[:n].rstrip() + " ..."
        ids = payload.get("image_ids", [])
        if not isinstance(ids, list):
            ids = []
        ext = (
            []
            if args.no_related_images
            else related_images(
                qdrant,
                models,
                args.collection,
                [str(x) for x in ids if x],
                args.show_text_chars,
            )
        )
        out.append(
            {
                "fp": fp(payload),
                "query": query,
                "rank": rank,
                "score": float(item.score),
                "node_type": payload.get("node_type", "text"),
                "image_id": payload.get("image_id", ""),
                "chunk_id": payload.get("chunk_id", ""),
                "section_title": payload.get("section_title", ""),
                "source_url": payload.get("source_url", ""),
                "text_file": payload.get("text_file", ""),
                "image_ids": ids,
                "related_images": ext,
                "text_preview": preview,
            }
        )
    return out


def merge_hits(rows: list[list[dict]], primary: str, top_k: int) -> list[dict]:
    merged: dict[str, dict] = {}
    for batch in rows:
      for item in batch:
        cur = merged.get(item["fp"])
        if not cur:
            merged[item["fp"]] = {
                **item,
                "matched_queries": [item["query"]],
                "hit_count": 1,
                "max_score": float(item["score"]),
                "rrf": 1.0 / (60 + int(item["rank"])),
                "primary_match": 1 if item["query"] == primary else 0,
            }
            continue
        if item["query"] not in cur["matched_queries"]:
            cur["matched_queries"].append(item["query"])
            cur["hit_count"] += 1
        cur["max_score"] = max(float(cur["max_score"]), float(item["score"]))
        cur["rrf"] += 1.0 / (60 + int(item["rank"]))
        if item["query"] == primary:
            cur["primary_match"] = 1
        if float(item["score"]) > float(cur["score"]):
            cur.update(
                {
                    "score": float(item["score"]),
                    "node_type": item["node_type"],
                    "image_id": item["image_id"],
                    "chunk_id": item["chunk_id"],
                    "section_title": item["section_title"],
                    "source_url": item["source_url"],
                    "text_file": item["text_file"],
                    "image_ids": item["image_ids"],
                    "related_images": item["related_images"],
                    "text_preview": item["text_preview"],
                }
            )
    out = []
    for item in merged.values():
        item["rerank_score"] = (
            0.45 * float(item["max_score"])
            + 0.35 * float(item["rrf"])
            + 0.12 * float(item["hit_count"])
            + 0.08 * float(item["primary_match"])
        )
        item.pop("fp", None)
        item.pop("query", None)
        item.pop("rank", None)
        item.pop("max_score", None)
        item.pop("rrf", None)
        item.pop("primary_match", None)
        out.append(item)
    out.sort(key=lambda x: (float(x.get("rerank_score", 0)), float(x.get("score", 0))), reverse=True)
    return out[: max(1, top_k)]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--query", required=True)
    p.add_argument("--db-path", default=".rag/vector/qdrant")
    p.add_argument("--collection", default="rag_chunks")
    p.add_argument("--model", default="nomic-embed-text")
    p.add_argument("--base-url", default="")
    p.add_argument("--api-key", default="")
    p.add_argument("--top-k", type=int, default=5)
    p.add_argument("--per-query-k", type=int, default=5)
    p.add_argument("--show-text-chars", type=int, default=240)
    p.add_argument("--node-type", choices=["any", "text", "image"], default="any")
    p.add_argument("--no-related-images", action="store_true")
    p.add_argument("--format", choices=["auto", "json", "state", "brief"], default="auto")
    p.add_argument("--rewrite", choices=["auto", "off", "llm"], default="auto")
    p.add_argument("--rewrite-model", default=os.getenv("RAG_REWRITE_MODEL", ""))
    p.add_argument("--rewrite-queries", type=int, default=int(os.getenv("RAG_REWRITE_QUERIES", "3")))
    args = p.parse_args()

    try:
        from openai import OpenAI
        from qdrant_client import QdrantClient, models
    except ModuleNotFoundError as e:
        raise SystemExit(
            f"missing dependency: {e.name}. run: bash script/rag/install-vector.sh"
        ) from e

    key = args.api_key or os.getenv("OPENAI_API_KEY") or os.getenv("MINIMAX_API_KEY") or "ollama"
    base = args.base_url or os.getenv("OPENAI_BASE_URL") or "http://127.0.0.1:11434/v1"
    client = OpenAI(api_key=key, base_url=base)
    rewrite_mode = auto_rewrite(args.rewrite, args.rewrite_model, args.query)
    rewrite = (
        rewrite_query(client, args.rewrite_model, args.query, max(1, args.rewrite_queries))
        if rewrite_mode == "llm"
        else {"mode": "off", "queries": [args.query], "keywords": []}
    )
    queries = uniq([args.query, *rewrite.get("queries", [])])[: max(1, args.rewrite_queries)]

    db = Path(args.db_path)
    if not db.exists():
        raise SystemExit(f"db path not found: {db}")

    qdrant = QdrantClient(path=str(db))
    rows = []
    for query in queries:
        vec = embed_query(client, args.model, query)
        points = search(qdrant, models, args.collection, vec, max(args.top_k, args.per_query_k), args.node_type)
        rows.append(collect(points, qdrant, models, args, query))

    out = merge_hits(rows, queries[0], args.top_k)
    rewrite["queries"] = queries
    fmt = auto_format(args.format)
    if fmt == "state":
        print(render_state(args.query, out, rewrite))
        return
    if fmt == "brief":
        print(render_brief(args.query, out, rewrite, args.top_k))
        return
    print(json.dumps({"query": args.query, "rewrite": rewrite, "hits": out}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
