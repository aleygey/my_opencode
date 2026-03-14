/// <reference path="../env.d.ts" />
import type { Plugin } from "@opencode-ai/plugin"
import path from "path"
import {
  allow,
  allowExpand,
  audit,
  base,
  cluster,
  collection,
  decide,
  key,
  model,
  parse,
  py,
  reset,
  rewriteMode,
  rewriteModel,
  rewriteQueries,
  reuseSec,
  root,
  row,
  session,
  stateBlock,
  strip,
  summary,
  topk,
  chars,
  db,
} from "../rag"

type Msg = {
  info?: {
    role?: string
    id?: string
    sessionID?: string
    sessionId?: string
  }
  parts?: Array<{
    type?: string
    text?: string
    synthetic?: boolean
  }>
}

function sid(msgs: Msg[], idx: number) {
  const direct = msgs[idx]?.info?.sessionID || msgs[idx]?.info?.sessionId
  if (direct) return String(direct)
  for (let i = idx; i >= 0; i--) {
    const v = msgs[i]?.info?.sessionID || msgs[i]?.info?.sessionId
    if (v) return String(v)
  }
  return "default"
}

function uid(msgs: Msg[], idx: number) {
  const v = msgs[idx]?.info?.id
  if (!v) return ""
  return String(v)
}

function next(status: string) {
  if (status === "new_evidence") return "call_rag_search_delta_if_needed"
  if (status === "weak_match") return "call_rag_search_delta_or_refine_query"
  if (status === "no_new_evidence") return "reuse_known_state_or_call_rag_search_state"
  if (status === "cluster_throttled") return "avoid_repeating_same_search"
  if (status === "retrieval_error") return "retry_or_check_rag_backend"
  return "refine_query_or_call_rag_search"
}

function mark(
  hit: ReturnType<typeof row>,
  input: { query: string; status: string; reason: string; total?: number; rewrites?: string[] },
) {
  hit.last_query = input.query
  hit.last_status = input.status
  hit.last_reason = input.reason
  hit.last_checked = Date.now()
  hit.total_hits = input.total || 0
  hit.delta = []
  hit.hits = []
  hit.top = []
  hit.overlap = 0
  hit.rewrites = input.rewrites || [input.query]
}

const RagContextPlugin: Plugin = async ({ worktree, $ }) => {
  return {
    "tool.definition": async (input, output) => {
      if (input.toolID !== "rag_search") return
      output.description = [
        output.description,
        "",
        "Call this tool with valid JSON arguments only.",
        'Use query as a plain string value. Do not insert extra quotes inside the query string.',
        'Valid example: {"query":"luckfox-pico zero 传输文件方式","mode":"delta","node_type":"text","top_k":3}',
        'Invalid example: {"query":"luck"fox-pico zero","mode":"brief"}',
      ].join("\n")
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "rag_search") return
      if (allowExpand()) return
      if (output.args?.mode !== "expand") return
      output.args = {
        ...output.args,
        mode: "delta",
        top_k: Math.min(Number(output.args?.top_k || 3), 3),
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (process.env.RAG_AUTO_INJECT === "0") return
      const msgs = output.messages as Msg[]
      if (!Array.isArray(msgs) || !msgs.length) return
      let idx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info?.role === "user") {
          idx = i
          break
        }
      }
      if (idx < 0) return
      const loop = msgs.slice(idx + 1).some((msg) => msg.info?.role === "assistant")
      const parts = Array.isArray(msgs[idx].parts) ? msgs[idx].parts : []
      let textPart: { type?: string; text?: string; synthetic?: boolean } | undefined
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]
        if (part?.type === "text" && typeof part.text === "string" && !part.synthetic) {
          textPart = part
          break
        }
      }
      if (!textPart?.text) return

      const clean = strip(textPart.text)
      const query = clean.trim().slice(0, 800)
      if (!query) return

      const sessionID = sid(msgs, idx)
      const userID = uid(msgs, idx)
      const st = session(sessionID)
      const keyName = cluster(query)
      const hit = row(st, keyName)
      const now = Date.now()
      const baseDir = root(worktree)
      const python = py(baseDir)
      const script = path.join(baseDir, "script", "rag", "search-vector-index.py")
      const dbPath = db(baseDir)
      const same = st.last_user_id === userID && st.last_query === query && st.last_cluster === keyName
      const cached = !!hit.last_status && (loop || (same && now - hit.last_checked <= reuseSec() * 1000))

      if (cached) {
        textPart.text = `${clean}\n\n${stateBlock(keyName, hit, next(hit.last_status))}`
        await audit(worktree, {
          channel: "rag_context",
          event: "context_meta",
          sessionID,
          userID,
          query,
          cluster: keyName,
          loop,
          used_cache: true,
          status: hit.last_status,
          reason: hit.last_reason,
          total_hits: hit.total_hits,
          delta_hits: hit.delta.length,
          known_hits: hit.known_hits,
          overlap: hit.overlap,
          rewrites: hit.rewrites,
          top_hits: summary(hit.top, 3),
          emitted_context: false,
        })
        return
      }

      if (!allow(hit)) {
        mark(hit, {
          query,
          status: "cluster_throttled",
          reason: "cluster_window_limit",
        })
        st.last_user_id = userID
        st.last_query = query
        st.last_cluster = keyName
        textPart.text = `${clean}\n\n${stateBlock(keyName, hit, next(hit.last_status))}`
        await audit(worktree, {
          channel: "rag_context",
          event: "context_meta",
          sessionID,
          userID,
          query,
          cluster: keyName,
          loop,
          used_cache: false,
          status: hit.last_status,
          reason: hit.last_reason,
          total_hits: hit.total_hits,
          delta_hits: hit.delta.length,
          known_hits: hit.known_hits,
          overlap: hit.overlap,
          rewrites: hit.rewrites,
          top_hits: [],
          emitted_context: false,
        })
        return
      }

      const res =
        await $`${python} ${script} --query ${query} --db-path ${dbPath} --collection ${collection()} --model ${model()} --top-k ${topk()} --node-type text --show-text-chars ${chars()} --base-url ${base()} --api-key ${key()} --format json --rewrite ${rewriteMode()} --rewrite-model ${rewriteModel()} --rewrite-queries ${rewriteQueries()}`
          .quiet()
          .nothrow()
      const raw = res.stdout.toString()

      if (res.exitCode !== 0) {
        mark(hit, {
          query,
          status: "retrieval_error",
          reason: "backend_error",
        })
        st.last_user_id = userID
        st.last_query = query
        st.last_cluster = keyName
        textPart.text = `${clean}\n\n${stateBlock(keyName, hit, next(hit.last_status))}`
        await audit(worktree, {
          channel: "rag_context",
          event: "search_fail",
          sessionID,
          userID,
          query,
          cluster: keyName,
          loop,
          code: res.exitCode,
          stderr: res.stderr.toString().slice(0, 1200),
          status: hit.last_status,
          reason: hit.last_reason,
          emitted_context: false,
        })
        return
      }

      let resData = { hits: [], rewrites: [query], keywords: [], rewrite_mode: "none" } as ReturnType<typeof parse>
      try {
        resData = parse(raw)
      } catch {
        mark(hit, {
          query,
          status: "retrieval_error",
          reason: "parse_error",
        })
        st.last_user_id = userID
        st.last_query = query
        st.last_cluster = keyName
        textPart.text = `${clean}\n\n${stateBlock(keyName, hit, next(hit.last_status))}`
        await audit(worktree, {
          channel: "rag_context",
          event: "parse_fail",
          sessionID,
          userID,
          query,
          cluster: keyName,
          loop,
          raw: raw.slice(0, 1200),
          status: hit.last_status,
          reason: hit.last_reason,
          emitted_context: false,
        })
        return
      }

      const out = decide(hit, resData.hits, query, resData.rewrites)
      st.last_user_id = userID
      st.last_query = query
      st.last_cluster = keyName
      textPart.text = `${clean}\n\n${stateBlock(keyName, hit, out.next)}`
      await audit(worktree, {
        channel: "rag_context",
        event: "context_search",
        sessionID,
        userID,
        query,
        cluster: keyName,
        loop,
        used_cache: false,
        status: out.status,
        reason: out.reason,
        total_hits: out.total,
        delta_hits: out.delta.length,
        known_hits: out.known,
        overlap: out.overlap,
        rewrite_mode: resData.rewrite_mode,
        rewrites: hit.rewrites,
        keywords: resData.keywords,
        top_hits: summary(hit.top, 3),
        delta_fps: out.delta.map((x) => ({
          fp: `${x.text_file || x.source_url || ""}#${x.chunk_id || x.image_id || x.section_title || ""}`,
          source_url: x.source_url || "",
          section_title: x.section_title || "",
          chunk_id: x.chunk_id || "",
        })),
        emitted_context: false,
      })
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (process.env.RAG_AUTO_INJECT === "0") return
      output.system.push("RAG protocol: parse <rag_state> on every model step. rag_context injects retrieval meta only, not full evidence.")
      output.system.push(
        "If rag_state status=new_evidence and you still need facts, call rag_search with mode=delta first. Use mode=brief only when delta is insufficient.",
      )
      output.system.push(
        "If rag_state status=no_new_evidence, reuse current state. Do not repeat the same retrieval unless the query becomes more specific.",
      )
      output.system.push(
        "Do not call rag_search mode=expand in normal QA. Use expand only for explicit debugging or evidence inspection.",
      )
      output.system.push(
        "Do not execute script/rag/search-vector-index.py directly from shell for QA retrieval. Use rag_search only.",
      )
      output.system.push(
        'When calling rag_search, emit valid JSON arguments. query must be one plain string value, without nested or broken quotation marks.',
      )
      output.system.push(
        "For long or noisy questions, trust rag_state rewrite metadata and prefer rag_search results derived from rewritten retrieval queries.",
      )
    },
    "experimental.session.compacting": async (input, output) => {
      const id = String((input as { sessionID?: string })?.sessionID || "default")
      const st = reset(id)
      await audit(worktree, {
        channel: "rag_context",
        event: "state_reset",
        sessionID: id,
        epoch: st.epoch,
      })
      return output
    },
  }
}

export default RagContextPlugin
