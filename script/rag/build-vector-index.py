#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

IMAGE_OCR_RE = re.compile(r"\[IMAGE_OCR\][\s\S]*?\[/IMAGE_OCR\]")


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_text(text: str, strip_inline_ocr: bool) -> str:
    body = text or ""
    if strip_inline_ocr:
        body = IMAGE_OCR_RE.sub(" ", body)
    return clean(body)


def is_rate_limit_error(e: Exception) -> bool:
    s = str(e).lower()
    return "rate limit" in s or "too many requests" in s or "429" in s


def embed_texts(
    client,
    model: str,
    texts: list[str],
    max_retries: int,
    retry_initial: float,
) -> list[list[float]]:
    n = 0
    delay = max(0.2, retry_initial)
    while True:
        try:
            r = client.embeddings.create(model=model, input=texts)
            return [item.embedding for item in r.data]
        except Exception as e:
            if not is_rate_limit_error(e) or n >= max_retries:
                raise
            n += 1
            print(
                f"[embed] rate limit; retry {n}/{max_retries} after {delay:.1f}s",
                file=sys.stderr,
            )
            time.sleep(delay)
            delay = min(delay * 2, 30)


def list_inputs(paths: list[str], input_dir: str, glob: str) -> list[Path]:
    files = [Path(p) for p in paths]
    if input_dir:
        files.extend(sorted(Path(input_dir).glob(glob)))
    out = []
    seen = set()
    for path in files:
        p = path.resolve()
        if p in seen:
            continue
        seen.add(p)
        if p.is_file():
            out.append(p)
    return out


def doc_key(path: Path, root: Path) -> str:
    p = path.resolve()
    try:
        return str(p.relative_to(root.resolve()))
    except ValueError:
        return str(p)


def delete_keys(direct: list[str], file_path: str) -> list[str]:
    out = [x for x in direct if x]
    if file_path:
        p = Path(file_path)
        if p.exists():
            out.extend(
                line.strip()
                for line in p.read_text(encoding="utf-8", errors="ignore").splitlines()
                if line.strip()
            )
    return sorted(set(out))


def merge_images(data: dict) -> list[dict]:
    if isinstance(data.get("image_nodes"), list):
        out = []
        for item in data["image_nodes"]:
            iid = item.get("image_id") or item.get("id")
            if not iid:
                continue
            out.append(
                {
                    "id": iid,
                    "section_ids": item.get("section_ids", []),
                    "source_url": item.get("source_url", ""),
                    "alt": item.get("alt", ""),
                    "ocr_text": item.get("ocr_text", ""),
                }
            )
        return out

    image_map = {}
    for sec in data.get("sections", []):
        for item in sec.get("images", []):
            iid = item.get("id")
            if not iid:
                continue
            row = image_map.get(iid) or {
                "id": iid,
                "section_ids": [],
                "source_url": item.get("url", ""),
                "alt": item.get("alt", ""),
                "ocr_text": item.get("ocr_text", ""),
            }
            sid = sec.get("id")
            if sid and sid not in row["section_ids"]:
                row["section_ids"].append(sid)
            if not row["source_url"]:
                row["source_url"] = item.get("url", "")
            if not row["alt"]:
                row["alt"] = item.get("alt", "")
            if not row["ocr_text"]:
                row["ocr_text"] = item.get("ocr_text", "")
            image_map[iid] = row
    return list(image_map.values())


def load_nodes(
    paths: list[Path],
    include_images: bool,
    strip_inline_ocr: bool,
    image_min_chars: int,
    root: Path,
) -> list[dict]:
    rows = []
    for path in paths:
        data = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
        source_url = data.get("source_url", "")
        text_file = data.get("text_file", str(path))
        key = doc_key(path, root)
        for i, item in enumerate(data.get("chunks", [])):
            text = normalize_text(item.get("text", ""), strip_inline_ocr)
            if not text:
                continue
            raw = f"{path}:{item.get('id', i)}"
            pid = str(uuid.uuid5(uuid.NAMESPACE_URL, raw))
            meta = item.get("metadata") or {}
            rows.append(
                {
                    "id": pid,
                    "text": text,
                    "payload": {
                        "node_type": "text",
                        "chunk_id": item.get("id", f"chunk-{i}"),
                        "section_id": item.get("section_id", ""),
                        "section_title": item.get("section_title", ""),
                        "source_url": meta.get("source_url") or source_url,
                        "text_file": meta.get("text_file") or text_file,
                        "doc_key": key,
                        "image_ids": item.get("image_ids", []),
                        "char_len": meta.get("char_len", len(text)),
                        "text": text,
                        "raw_id": raw,
                    },
                }
            )
        if not include_images:
            continue
        for i, item in enumerate(merge_images(data)):
            iid = item.get("id")
            txt = clean(
                "\n".join(
                    x
                    for x in [
                        f"[IMAGE:{iid}]",
                        item.get("alt", ""),
                        item.get("ocr_text", ""),
                    ]
                    if x
                )
            )
            if len(clean((item.get("alt", "") + " " + item.get("ocr_text", "")).strip())) < image_min_chars:
                continue
            raw = f"{path}:image:{iid}:{i}"
            pid = str(uuid.uuid5(uuid.NAMESPACE_URL, raw))
            rows.append(
                {
                    "id": pid,
                    "text": txt,
                    "payload": {
                        "node_type": "image",
                        "image_id": iid,
                        "section_ids": item.get("section_ids", []),
                        "section_title": "",
                        "source_url": item.get("source_url", "") or source_url,
                        "text_file": text_file,
                        "doc_key": key,
                        "image_ids": [iid],
                        "char_len": len(txt),
                        "text": txt,
                        "alt": item.get("alt", ""),
                        "ocr_text": item.get("ocr_text", ""),
                        "raw_id": raw,
                    },
                }
            )
    return rows


def has_collection(client: QdrantClient, name: str) -> bool:
    if hasattr(client, "collection_exists"):
        return bool(client.collection_exists(name))
    cols = client.get_collections().collections
    return any(c.name == name for c in cols)


def delete_doc_keys(client, models, collection: str, keys: list[str]) -> int:
    if not keys:
        return 0
    if not has_collection(client, collection):
        return 0
    for key in keys:
        client.delete(
            collection_name=collection,
            points_selector=models.Filter(
                must=[models.FieldCondition(key="doc_key", match=models.MatchValue(value=key))]
            ),
            wait=True,
        )
    return len(keys)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", action="append", default=[])
    p.add_argument("--input-dir", default="")
    p.add_argument("--glob", default="*.structured.json")
    p.add_argument("--db-path", default=".rag/vector/qdrant")
    p.add_argument("--collection", default="rag_chunks")
    p.add_argument("--model", default="nomic-embed-text")
    p.add_argument("--base-url", default="")
    p.add_argument("--api-key", default="")
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--max-retries", type=int, default=6)
    p.add_argument("--retry-initial", type=float, default=1.5)
    p.add_argument("--no-image-nodes", action="store_true")
    p.add_argument("--keep-inline-ocr", action="store_true")
    p.add_argument("--image-min-chars", type=int, default=2)
    p.add_argument("--root", default=".")
    p.add_argument("--delete-doc-key", action="append", default=[])
    p.add_argument("--delete-doc-keys-file", default="")
    p.add_argument("--recreate", action="store_true")
    args = p.parse_args()

    try:
        from openai import OpenAI
        from qdrant_client import QdrantClient, models
    except ModuleNotFoundError as e:
        raise SystemExit(
            f"missing dependency: {e.name}. run: bash script/rag/install-vector.sh"
        ) from e

    inputs = list_inputs(args.input, args.input_dir, args.glob)
    root = Path(args.root)
    del_keys = delete_keys(args.delete_doc_key, args.delete_doc_keys_file)

    rows = (
        load_nodes(
            inputs,
            include_images=not args.no_image_nodes,
            strip_inline_ocr=not args.keep_inline_ocr,
            image_min_chars=max(0, args.image_min_chars),
            root=root,
        )
        if inputs
        else []
    )
    if not rows and not del_keys:
        raise SystemExit("no input files and no delete doc keys; nothing to do")

    key = args.api_key or os.getenv("OPENAI_API_KEY") or os.getenv("MINIMAX_API_KEY") or "ollama"
    base = args.base_url or os.getenv("OPENAI_BASE_URL") or "http://127.0.0.1:11434/v1"
    embed = OpenAI(api_key=key, base_url=base) if rows else None

    db_path = Path(args.db_path)
    db_path.mkdir(parents=True, exist_ok=True)
    qdrant = QdrantClient(path=str(db_path))
    deleted = 0

    if args.recreate and has_collection(qdrant, args.collection):
        qdrant.delete_collection(collection_name=args.collection)
    if del_keys:
        deleted = delete_doc_keys(qdrant, models, args.collection, del_keys)

    if not rows:
        count = qdrant.count(collection_name=args.collection, exact=True).count if has_collection(qdrant, args.collection) else 0
        print(
            json.dumps(
                {
                    "db_path": str(db_path),
                    "collection": args.collection,
                    "input_files": 0,
                    "inserted": 0,
                    "deleted_doc_keys": deleted,
                    "collection_count": count,
                    "text_nodes": 0,
                    "image_nodes": 0,
                    "vector_size": 0,
                    "embedding_model": args.model,
                    "embedding_base_url": base,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    vec0 = embed_texts(
        embed,
        args.model,
        [rows[0]["text"]],
        args.max_retries,
        args.retry_initial,
    )[0]
    dim = len(vec0)
    if dim <= 0:
        raise SystemExit("embedding result is empty")
    if not has_collection(qdrant, args.collection):
        qdrant.create_collection(
            collection_name=args.collection,
            vectors_config=models.VectorParams(size=dim, distance=models.Distance.COSINE),
        )

    batch_size = max(1, args.batch_size)
    total = 0
    batch = [{"id": rows[0]["id"], "vector": vec0, "payload": rows[0]["payload"]}]
    for i in range(1, len(rows), batch_size):
        seg = rows[i : i + batch_size]
        vecs = embed_texts(
            embed,
            args.model,
            [x["text"] for x in seg],
            args.max_retries,
            args.retry_initial,
        )
        batch.extend(
            {
                "id": seg[j]["id"],
                "vector": vecs[j],
                "payload": seg[j]["payload"],
            }
            for j in range(len(seg))
        )

    for i in range(0, len(batch), batch_size):
        seg = batch[i : i + batch_size]
        qdrant.upsert(
            collection_name=args.collection,
            points=[
                models.PointStruct(id=item["id"], vector=item["vector"], payload=item["payload"])
                for item in seg
            ],
            wait=True,
        )
        total += len(seg)

    count = qdrant.count(collection_name=args.collection, exact=True).count
    text_nodes = sum(1 for x in rows if x["payload"].get("node_type") == "text")
    image_nodes = sum(1 for x in rows if x["payload"].get("node_type") == "image")
    print(
        json.dumps(
            {
                "db_path": str(db_path),
                "collection": args.collection,
                "input_files": len(inputs),
                "inserted": total,
                "deleted_doc_keys": deleted,
                "collection_count": count,
                "text_nodes": text_nodes,
                "image_nodes": image_nodes,
                "vector_size": dim,
                "embedding_model": args.model,
                "embedding_base_url": base,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
