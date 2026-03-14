---
name: rag-pipeline
description: Run standardized rag init/update pipeline with minimal options and manifest-based sync
compatibility: opencode
---

## Goal

Use two commands only:

1. `rag-init` for first build
2. `rag-update` for incremental sync

If the target repo does not contain this pipeline yet, bootstrap first:

```bash
bash script/rag/cmd/rag-bootstrap.sh --target <target_project_root>
```

## Required Inputs

1. source type: `structured` | `dir` | `url`
2. source path (or url list)
3. embedding model
4. collection name

## Exposed Options

Only expose these options to users by default:

1. `--source`
2. `--struct-mode` + `--struct-model`
3. `--embed-model`
4. `--url` / `--url-file` / `--input-dir` / `--scan-dir`
5. `--collection`

Keep low-level knobs hidden unless users ask explicitly:

1. chunk size / overlap
2. OCR engine internals
3. retry/backoff internals

## Commands

### Initial build

Structured-only init:

```bash
bash script/rag/cmd/rag-init.sh --source structured --scan-dir .rag/text --glob "**/*.structured.json" --embed-model qwen3-embedding:4b --collection rag_chunks
```

Directory init:

```bash
bash script/rag/cmd/rag-init.sh --source dir --input-dir <raw_dir> --text-out-dir .rag/text/dir --embed-model qwen3-embedding:4b --collection rag_chunks
```

URL init:

```bash
bash script/rag/cmd/rag-init.sh --source url --url <url> --ocr-images --image-inline marker --url-text-dir .rag/text/url --embed-model qwen3-embedding:4b --collection rag_chunks
```

### Incremental update

```bash
bash script/rag/cmd/rag-update.sh --source structured --scan-dir .rag/text --glob "**/*.structured.json" --embed-model qwen3-embedding:4b --collection rag_chunks
```

## Behavior Rules

1. Do not expose chunk-size/overlap or low-level OCR internals unless user explicitly asks.
2. Keep defaults:
   - `--struct-mode llamaindex`
   - `--inline-ocr strip`
   - `--image-inline marker`
3. If collection or embedding model changes, allow full rebuild.
4. Keep state in `--manifest` (default `.rag/state/manifest.json`) to support incremental update.
5. Runtime retrieval policy:
   - prefer plugin auto-inject with `<rag_state>` meta on every model step
   - use `rag_search` to progressively reveal evidence text
   - avoid repeated retrieval in the same query cluster unless new evidence appears
   - use `rag_search` mode progressively: `state` -> `delta` -> `brief`
   - use `expand` only for explicit debugging or when the user asks to inspect evidence details
6. Debugging:
   - enable with `RAG_DEBUG=1`
   - inspect `.rag/log/rag_debug.jsonl`
   - summarize quickly with `python script/rag/debug-rag-state.py --tail 100`
7. On failure, return:
   - exact command
   - stderr summary
   - recovery action
