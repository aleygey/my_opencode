import path from "path"
import { appendFile, mkdir } from "node:fs/promises"

export type Hit = {
  score?: number
  rerank_score?: number
  source_url?: string
  section_title?: string
  text_preview?: string
  chunk_id?: string
  image_id?: string
  text_file?: string
  matched_queries?: string[]
  hit_count?: number
}

export type SearchResult = {
  hits: Hit[]
  rewrites: string[]
  keywords: string[]
  rewrite_mode: string
}

type Row = {
  seen: Set<string>
  window: number[]
  last_query: string
  last_status: string
  last_reason: string
  last_checked: number
  total_hits: number
  known_hits: number
  overlap: number
  delta: Hit[]
  hits: Hit[]
  top: Hit[]
  rewrites: string[]
}

type Session = {
  epoch: number
  last_user_id: string
  last_query: string
  last_cluster: string
  rows: Map<string, Row>
}

const STORE = new Map<string, Session>()
const STOP = new Set([
  "的",
  "了",
  "和",
  "是",
  "怎么",
  "如何",
  "请问",
  "一下",
  "关于",
  "教程",
  "方法",
  "方式",
  "what",
  "how",
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "in",
])
const SYN: Record<string, string> = {
  flash: "烧录",
  burn: "烧录",
  firmware: "固件",
  image: "镜像",
  electerm: "electerm",
  luckfox: "luckfox",
  pico: "pico",
  zero: "zero",
}

export function topk() {
  const n = Number.parseInt(process.env.RAG_TOP_K ?? "4", 10)
  if (Number.isFinite(n) && n > 0) return n
  return 4
}

export function use() {
  const n = Number.parseInt(process.env.RAG_CONTEXT_HITS ?? "2", 10)
  if (Number.isFinite(n) && n > 0) return n
  return 2
}

export function chars() {
  const n = Number.parseInt(process.env.RAG_CONTEXT_CHARS ?? "120", 10)
  if (Number.isFinite(n) && n >= 40) return n
  return 120
}

export function expandChars() {
  const n = Number.parseInt(process.env.RAG_EXPAND_CHARS ?? "420", 10)
  if (Number.isFinite(n) && n >= 120) return n
  return 420
}

export function simCut() {
  const n = Number.parseFloat(process.env.RAG_OVERLAP_THRESHOLD ?? "0.8")
  if (Number.isFinite(n) && n > 0 && n <= 1) return n
  return 0.8
}

export function weakCut() {
  const n = Number.parseFloat(process.env.RAG_WEAK_SCORE ?? "0.42")
  if (Number.isFinite(n) && n > 0 && n < 1) return n
  return 0.42
}

export function clusterWindowSec() {
  const n = Number.parseInt(process.env.RAG_CLUSTER_WINDOW_SEC ?? "30", 10)
  if (Number.isFinite(n) && n > 0) return n
  return 30
}

export function clusterMax() {
  const n = Number.parseInt(process.env.RAG_CLUSTER_MAX_FULL ?? "2", 10)
  if (Number.isFinite(n) && n > 0) return n
  return 2
}

export function reuseSec() {
  const n = Number.parseInt(process.env.RAG_REUSE_SEC ?? "8", 10)
  if (Number.isFinite(n) && n >= 0) return n
  return 8
}

export function model() {
  const v = process.env.RAG_EMBED_MODEL
  if (v) return v
  return "qwen3-embedding:4b"
}

export function rewriteMode() {
  const v = process.env.RAG_REWRITE_MODE
  if (v) return v
  return "auto"
}

export function rewriteModel() {
  const v = process.env.RAG_REWRITE_MODEL
  if (v) return v
  return process.env.RAG_STRUCT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini"
}

export function rewriteQueries() {
  const n = Number.parseInt(process.env.RAG_REWRITE_QUERIES ?? "3", 10)
  if (Number.isFinite(n) && n > 0) return n
  return 3
}

export function collection() {
  const v = process.env.RAG_COLLECTION
  if (v) return v
  return "rag_chunks"
}

export function base() {
  const v = process.env.RAG_BASE_URL || process.env.OPENAI_BASE_URL
  if (v) return v
  return "http://127.0.0.1:11434/v1"
}

export function key() {
  const v = process.env.RAG_API_KEY || process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY
  if (v) return v
  return "ollama"
}

export function debug() {
  return process.env.RAG_DEBUG_LOG === "1" || process.env.RAG_DEBUG === "1"
}

export function allowExpand() {
  return process.env.RAG_ALLOW_EXPAND_TOOL === "1"
}

export function root(input: string) {
  const env = process.env.RAG_WORKTREE
  if (env) return env
  if (input && input !== "/") return input
  return process.cwd()
}

export function py(rootDir: string) {
  const env = process.env.RAG_DOCLING_PYTHON_BIN
  if (env) return env
  return path.join(rootDir, ".venv-docling", "bin", "python")
}

export function db(rootDir: string) {
  const env = process.env.RAG_DB_PATH
  if (env) return env
  return path.join(rootDir, ".rag", "vector", "qdrant")
}

export function clip(text: string, n: number) {
  const s = String(text || "").replace(/\s+/g, " ").trim()
  if (s.length <= n) return s
  return `${s.slice(0, n).trim()} ...`
}

export function strip(text: string) {
  return text
    .replace(/\n*<rag_context>[\s\S]*?<\/rag_context>\n*/g, "\n")
    .replace(/\n*<rag_state>[\s\S]*?<\/rag_state>\n*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function terms(query: string) {
  const rows = (query.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9_-]+/gu) || [])
    .map((x) => x.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const raw of rows) {
    const v = SYN[raw] || raw
    if (!v || STOP.has(v)) continue
    out.push(v)
  }
  return [...new Set(out)].sort()
}

export function cluster(query: string) {
  const rows = terms(query)
  if (!rows.length) return `q:${clip(query.toLowerCase(), 48)}`
  return rows.slice(0, 8).join("|")
}

export function fp(hit: Hit) {
  const src = hit.text_file || hit.source_url || ""
  const id = hit.chunk_id || hit.image_id || hit.section_title || clip(String(hit.text_preview || ""), 36)
  return `${src}#${id}`
}

export function parse(raw: string) {
  const data = JSON.parse(raw)
  const hits = Array.isArray(data?.hits) ? data.hits : []
  const rewrites = Array.isArray(data?.rewrite?.queries) ? data.rewrite.queries.filter((x: unknown) => typeof x === "string") : []
  const keywords = Array.isArray(data?.rewrite?.keywords) ? data.rewrite.keywords.filter((x: unknown) => typeof x === "string") : []
  return {
    hits: hits as Hit[],
    rewrites,
    keywords,
    rewrite_mode: String(data?.rewrite?.mode || "none"),
  } as SearchResult
}

export function session(id: string) {
  const cur = STORE.get(id)
  if (cur) return cur
  const next: Session = {
    epoch: 0,
    last_user_id: "",
    last_query: "",
    last_cluster: "",
    rows: new Map(),
  }
  STORE.set(id, next)
  return next
}

export function row(st: Session, key: string) {
  const cur = st.rows.get(key)
  if (cur) return cur
  const next: Row = {
    seen: new Set(),
    window: [],
    last_query: "",
    last_status: "",
    last_reason: "",
    last_checked: 0,
    total_hits: 0,
    known_hits: 0,
    overlap: 0,
    delta: [],
    hits: [],
    top: [],
    rewrites: [],
  }
  st.rows.set(key, next)
  return next
}

export function allow(row: Row) {
  const now = Date.now()
  const win = clusterWindowSec() * 1000
  row.window = row.window.filter((x) => now - x <= win)
  if (row.window.length >= clusterMax()) return false
  row.window.push(now)
  return true
}

export function decide(row: Row, hits: Hit[], query: string, rewrites?: string[]) {
  const keys = hits.map(fp)
  const fresh = hits.filter((hit) => !row.seen.has(fp(hit)))
  const shared = keys.filter((key) => row.seen.has(key)).length
  const ov = keys.length ? shared / keys.length : 0
  const top = Number(hits[0]?.score || 0)
  const status = !hits.length
    ? "need_refine"
    : !fresh.length && ov >= simCut()
      ? "no_new_evidence"
      : top < weakCut()
        ? "weak_match"
        : "new_evidence"
  const reason = !hits.length
    ? "empty_hits"
    : !fresh.length && ov >= simCut()
      ? "high_overlap"
      : top < weakCut()
        ? "low_score"
        : fresh.length < hits.length
          ? "delta_available"
          : "fresh_hits"
  const next =
    status === "need_refine"
      ? "refine_query_or_call_rag_search"
      : status === "no_new_evidence"
        ? "reuse_known_evidence_or_call_rag_search_state"
        : status === "weak_match"
          ? "call_rag_search_delta_or_refine_query"
          : "call_rag_search_delta_if_more_detail_needed"
  for (const key of keys) row.seen.add(key)
  row.last_query = query
  row.last_status = status
  row.last_reason = reason
  row.last_checked = Date.now()
  row.total_hits = hits.length
  row.known_hits = row.seen.size
  row.overlap = ov
  row.delta = fresh
  row.hits = hits
  row.top = hits.slice(0, 3)
  row.rewrites = rewrites && rewrites.length ? rewrites : [query]
  return { status, reason, next, overlap: ov, delta: fresh, hits, known: row.known_hits, total: hits.length }
}

export function stateBlock(key: string, row: Row, next?: string) {
  const top = row.top[0]
  return [
    "<rag_state>",
    `status=${row.last_status || "need_refine"}`,
    `reason=${row.last_reason || "empty_hits"}`,
    `cluster=${key}`,
    `total_hits=${row.total_hits}`,
    `delta_hits=${row.delta.length}`,
    `known_hits=${row.known_hits}`,
    `overlap=${Number(row.overlap || 0).toFixed(4)}`,
    `top_source=${top?.source_url || ""}`,
    `top_section=${clip(top?.section_title || "", 48)}`,
    `rewrite_queries=${JSON.stringify(row.rewrites)}`,
    `next_action=${next || "call_rag_search_delta_if_needed"}`,
    "</rag_state>",
  ].join("\n")
}

export function brief(hits: Hit[], limit: number) {
  if (!hits.length) return "no_rag_hit"
  return hits
    .slice(0, Math.max(1, limit))
    .map((hit, i) =>
      [
        `[${i + 1}]`,
        `source=${hit.source_url || ""}`,
        `section=${clip(hit.section_title || "", 48)}`,
        `summary=${clip(hit.text_preview || "", chars())}`,
      ].join(" "),
    )
    .join("\n")
}

export function expand(hits: Hit[], limit: number) {
  if (!hits.length) return "no_rag_hit"
  return hits
    .slice(0, Math.max(1, limit))
    .map((hit, i) =>
      [
        `[${i + 1}] score=${Number(hit.score || 0).toFixed(4)}`,
        `source=${hit.source_url || ""}`,
        `section=${hit.section_title || ""}`,
        `chunk=${hit.chunk_id || hit.image_id || ""}`,
        `text=${clip(hit.text_preview || "", expandChars())}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export function summary(hits: Hit[], limit: number) {
  return hits.slice(0, Math.max(1, limit)).map((hit) => ({
    score: Number(hit.score || 0),
    rerank_score: Number(hit.rerank_score || 0),
    source_url: hit.source_url || "",
    section_title: hit.section_title || "",
    chunk_id: hit.chunk_id || "",
    image_id: hit.image_id || "",
    text_preview: clip(hit.text_preview || "", chars()),
    fp: fp(hit),
    matched_queries: Array.isArray(hit.matched_queries) ? hit.matched_queries : [],
    hit_count: Number(hit.hit_count || 0),
  }))
}

export async function audit(worktree: string, data: Record<string, unknown>) {
  if (!debug()) return
  const dir = path.join(root(worktree), ".rag", "log")
  await mkdir(dir, { recursive: true })
  await appendFile(path.join(dir, "rag_debug.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...data })}\n`, "utf-8")
}

export function reset(id: string) {
  const st = session(id)
  st.epoch += 1
  st.rows.clear()
  st.last_user_id = ""
  st.last_query = ""
  st.last_cluster = ""
  return st
}
