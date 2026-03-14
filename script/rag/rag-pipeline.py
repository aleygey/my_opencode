#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path: Path, root: Path) -> str:
    p = path.resolve()
    try:
        return str(p.relative_to(root.resolve()))
    except ValueError:
        return str(p)


def run(cmd: list[str], *, capture: bool = False) -> str:
    if capture:
        out = subprocess.run(cmd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return out.stdout
    subprocess.run(cmd, check=True)
    return ""


def urls(args) -> list[str]:
    out = [u for u in args.url if u]
    if args.url_file:
        p = Path(args.url_file)
        if p.exists():
            out.extend(
                line.strip()
                for line in p.read_text(encoding="utf-8", errors="ignore").splitlines()
                if line.strip() and not line.strip().startswith("#")
            )
    seen = set()
    uniq = []
    for u in out:
        if u in seen:
            continue
        seen.add(u)
        uniq.append(u)
    return uniq


def txt_files(dir_path: Path) -> list[Path]:
    bad = {"_success.log", "_failed.log", "_run.log"}
    out = []
    for path in sorted(dir_path.rglob("*.txt")):
        name = path.name
        if name in bad:
            continue
        if name.endswith(".clean.txt") or name.endswith(".raw.txt"):
            continue
        out.append(path)
    return out


def structured_files(scan_dir: Path, glob: str) -> list[Path]:
    return sorted(p for p in scan_dir.glob(glob) if p.is_file())


def clean_path(txt: Path) -> Path:
    if txt.name.endswith(".txt"):
        return txt.with_name(txt.name[:-4] + ".clean.txt")
    return txt.with_name(txt.name + ".clean.txt")


def structured_path(txt: Path) -> Path:
    if txt.name.endswith(".txt"):
        return txt.with_name(txt.name[:-4] + ".structured.json")
    return txt.with_name(txt.name + ".structured.json")


@dataclass
class Env:
    root: Path
    py: Path
    url_to_text: Path
    convert_dir: Path
    clean_text: Path
    structure_text: Path
    build_index: Path


def env(root: Path, py: str) -> Env:
    return Env(
        root=root,
        py=Path(py),
        url_to_text=root / "script" / "rag" / "url-to-text.sh",
        convert_dir=root / "script" / "rag" / "convert-dir-to-text.sh",
        clean_text=root / "script" / "rag" / "clean-text.py",
        structure_text=root / "script" / "rag" / "structure-text.py",
        build_index=root / "script" / "rag" / "build-vector-index.py",
    )


def process_txt(e: Env, txt: Path, args, source_url: str = "") -> Path:
    c = clean_path(txt)
    s = structured_path(txt)
    run([str(e.py), str(e.clean_text), "--input", str(txt), "--output", str(c)])
    cmd = [
        str(e.py),
        str(e.structure_text),
        "--text",
        str(c),
        "--output",
        str(s),
        "--mode",
        args.struct_mode,
        "--inline-ocr",
        args.inline_ocr,
    ]
    img = txt.with_name(txt.name[:-4] + ".images.json") if txt.name.endswith(".txt") else txt.with_name(txt.name + ".images.json")
    if img.exists():
        cmd.extend(["--images", str(img)])
    if source_url:
        cmd.extend(["--source-url", source_url])
    if args.struct_mode == "llamaindex":
        cmd.extend(["--model", args.struct_model])
    run(cmd)
    return s


def refresh_dir(e: Env, args) -> list[Path]:
    src = Path(args.input_dir)
    out = Path(args.text_out_dir)
    out.mkdir(parents=True, exist_ok=True)
    run(["bash", str(e.convert_dir), "--input", str(src), "--output", str(out)])
    return [process_txt(e, txt, args) for txt in txt_files(out)]


def pick_txt(stdout: str) -> Path:
    rows = [line.strip() for line in stdout.splitlines() if line.strip()]
    if not rows:
        raise SystemExit("url-to-text returned empty output")
    return Path(rows[-1])


def refresh_url(e: Env, args) -> list[Path]:
    all_urls = urls(args)
    if not all_urls:
        raise SystemExit("no url provided: use --url or --url-file")
    out = []
    for url in all_urls:
        cmd = [
            "bash",
            str(e.url_to_text),
            "--url",
            url,
            "--output",
            args.url_text_dir,
            "--image-inline",
            args.image_inline,
        ]
        if args.ocr_images:
            cmd.append("--ocr-images")
        txt = pick_txt(run(cmd, capture=True))
        out.append(process_txt(e, txt, args, source_url=url))
    return out


def manifest(paths: list[Path], root: Path, args) -> dict:
    docs = {}
    for p in paths:
        key = rel(p, root)
        data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        docs[key] = {
            "path": key,
            "sha256": sha(p),
            "source_url": data.get("source_url", ""),
            "updated_at": now(),
        }
    return {
        "version": 1,
        "generated_at": now(),
        "root": str(root.resolve()),
        "collection": args.collection,
        "embedding_model": args.embed_model,
        "struct_mode": args.struct_mode,
        "struct_model": args.struct_model,
        "docs": docs,
    }


def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}


def write_manifest(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def index(e: Env, args, files: list[Path], recreate: bool, delete_keys: list[str]) -> dict:
    cmd = [
        str(e.py),
        str(e.build_index),
        "--db-path",
        args.db_path,
        "--collection",
        args.collection,
        "--model",
        args.embed_model,
        "--root",
        str(args.root),
    ]
    for f in files:
        cmd.extend(["--input", str(f)])
    for key in delete_keys:
        cmd.extend(["--delete-doc-key", key])
    if recreate:
        cmd.append("--recreate")
    out = run(cmd, capture=True)
    return json.loads(out)


def scan_all(args) -> list[Path]:
    return structured_files(Path(args.scan_dir), args.glob)


def init_cmd(e: Env, args) -> None:
    if args.source == "dir":
        files = refresh_dir(e, args)
    elif args.source == "url":
        files = refresh_url(e, args)
    else:
        files = scan_all(args)
    if not files:
        raise SystemExit("no structured files found for init")
    res = index(e, args, files, recreate=True, delete_keys=[])
    man = manifest(files, args.root, args)
    write_manifest(Path(args.manifest), man)
    print(
        json.dumps(
            {
                "mode": "init",
                "files": len(files),
                "manifest": args.manifest,
                "index": res,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def update_cmd(e: Env, args) -> None:
    if args.source == "dir":
        refresh_dir(e, args)
    elif args.source == "url":
        refresh_url(e, args)

    files = scan_all(args)
    old = load_manifest(Path(args.manifest))
    old_docs = old.get("docs", {})
    if not files:
        new = manifest([], args.root, args)
        removed = sorted(old_docs.keys())
        res = None
        if removed:
            res = index(e, args, [], recreate=False, delete_keys=removed)
        write_manifest(Path(args.manifest), new)
        print(
            json.dumps(
                {
                    "mode": "update",
                    "changed": 0,
                    "removed": len(removed),
                    "manifest": args.manifest,
                    "index": res,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    new = manifest(files, args.root, args)
    new_docs = new.get("docs", {})

    force_full = False
    if old:
        if old.get("collection") != args.collection or old.get("embedding_model") != args.embed_model:
            force_full = True

    if force_full:
        res = index(e, args, files, recreate=True, delete_keys=[])
        write_manifest(Path(args.manifest), new)
        print(
            json.dumps(
                {
                    "mode": "update",
                    "reason": "collection_or_embedding_changed",
                    "files": len(files),
                    "manifest": args.manifest,
                    "index": res,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    changed = [k for k, v in new_docs.items() if old_docs.get(k, {}).get("sha256") != v.get("sha256")]
    removed = [k for k in old_docs if k not in new_docs]
    if not changed and not removed:
        write_manifest(Path(args.manifest), new)
        print(
            json.dumps(
                {
                    "mode": "update",
                    "changed": 0,
                    "removed": 0,
                    "manifest": args.manifest,
                    "index": None,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    pick = {k: Path(args.root) / new_docs[k]["path"] for k in changed}
    res = index(e, args, [p for p in pick.values() if p.exists()], recreate=False, delete_keys=sorted(set(changed + removed)))
    write_manifest(Path(args.manifest), new)
    print(
        json.dumps(
            {
                "mode": "update",
                "changed": len(changed),
                "removed": len(removed),
                "manifest": args.manifest,
                "index": res,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def add_common(sp) -> None:
    struct_mode = os.getenv("RAG_STRUCT_MODE", "llamaindex")
    if struct_mode not in {"rule", "llamaindex"}:
        struct_mode = "llamaindex"
    sp.add_argument("--root", default=".")
    sp.add_argument("--python", default="./.venv-docling/bin/python")
    sp.add_argument("--source", choices=["structured", "dir", "url"], default="structured")
    sp.add_argument("--scan-dir", default=".rag/text")
    sp.add_argument("--glob", default="**/*.structured.json")
    sp.add_argument("--input-dir", default="")
    sp.add_argument("--text-out-dir", default=".rag/text/dir")
    sp.add_argument("--url", action="append", default=[])
    sp.add_argument("--url-file", default="")
    sp.add_argument("--url-text-dir", default=".rag/text/url")
    sp.add_argument("--ocr-images", action="store_true")
    sp.add_argument("--image-inline", choices=["marker", "ocr", "none"], default="marker")
    sp.add_argument("--struct-mode", choices=["rule", "llamaindex"], default=struct_mode)
    sp.add_argument("--struct-model", default=os.getenv("RAG_STRUCT_MODEL", "gpt-4o-mini"))
    sp.add_argument("--inline-ocr", choices=["strip", "keep"], default="strip")
    sp.add_argument("--embed-model", default="qwen3-embedding:4b")
    sp.add_argument("--db-path", default=".rag/vector/qdrant")
    sp.add_argument("--collection", default="rag_chunks")
    sp.add_argument("--manifest", default=".rag/state/manifest.json")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    p_init = sub.add_parser("init")
    add_common(p_init)
    p_update = sub.add_parser("update")
    add_common(p_update)
    args = p.parse_args()
    args.root = Path(args.root).resolve()
    e = env(args.root, args.python)

    if args.cmd == "init":
        init_cmd(e, args)
        return
    if args.cmd == "update":
        update_cmd(e, args)
        return
    raise SystemExit("unknown cmd")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        print(
            json.dumps(
                {
                    "error": "command_failed",
                    "cmd": e.cmd,
                    "code": e.returncode,
                    "stdout": e.stdout if isinstance(e.stdout, str) else "",
                    "stderr": e.stderr if isinstance(e.stderr, str) else "",
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        raise SystemExit(e.returncode)
