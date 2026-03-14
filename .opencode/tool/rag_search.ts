/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import path from "path"
import DESCRIPTION from "./rag_search.txt"
import {
  allowExpand,
  audit,
  base,
  brief,
  chars,
  cluster,
  collection,
  db,
  decide,
  expand,
  expandChars,
  key,
  model,
  parse,
  py,
  rewriteMode,
  rewriteModel,
  rewriteQueries,
  root,
  row,
  session,
  stateBlock,
  summary,
} from "../rag"

export default tool({
  description: DESCRIPTION,
  args: {
    query: tool.schema.string().describe("Search query text"),
    top_k: tool.schema.number().describe("Maximum hits to return").default(3),
    node_type: tool.schema.enum(["any", "text", "image"]).describe("Filter node type").default("text"),
    mode: tool.schema.enum(["state", "delta", "brief", "expand"]).describe("Result disclosure mode").default("delta"),
  },
  async execute(args, ctx) {
    const baseDir = root(ctx?.worktree || ctx?.directory || process.cwd())
    const python = py(baseDir)
    const script = path.join(baseDir, "script", "rag", "search-vector-index.py")
    const dbPath = db(baseDir)
    const show = args.mode === "expand" ? expandChars() : chars()
    const res =
      await Bun.$`${python} ${script} --query ${args.query} --db-path ${dbPath} --collection ${collection()} --model ${model()} --top-k ${args.top_k} --node-type ${args.node_type} --show-text-chars ${show} --base-url ${base()} --api-key ${key()} --format json --rewrite ${rewriteMode()} --rewrite-model ${rewriteModel()} --rewrite-queries ${rewriteQueries()}`
        .quiet()
        .nothrow()
    const out = res.stdout.toString().trim()
    const sessionID = String(ctx?.sessionID || ctx?.sessionId || baseDir)
    const keyName = cluster(args.query)
    const st = session(sessionID)
    const hit = row(st, keyName)

    if (res.exitCode !== 0) {
      const err = res.stderr.toString().trim()
      await audit(baseDir, {
        channel: "rag_search",
        event: "tool_error",
        sessionID,
        query: args.query,
        cluster: keyName,
        mode: args.mode,
        code: res.exitCode,
        stderr: err.slice(0, 1200),
        stdout: out.slice(0, 1200),
      })
      return JSON.stringify(
        {
          error: "rag_search_failed",
          exit_code: res.exitCode,
          worktree: baseDir,
          python,
          script,
          db_path: dbPath,
          collection: collection(),
          model: model(),
          base_url: base(),
          mode: args.mode,
          stderr: err.slice(0, 1200),
          stdout: out.slice(0, 1200),
          hint: "verify OPENAI_BASE_URL/OPENAI_API_KEY, collection exists, and venv has openai/qdrant-client",
        },
        null,
        2,
      )
    }

    let dataRes = { hits: [], rewrites: [args.query], keywords: [], rewrite_mode: "none" } as ReturnType<typeof parse>
    try {
      dataRes = parse(out)
    } catch {
      await audit(baseDir, {
        channel: "rag_search",
        event: "tool_parse_fail",
        sessionID,
        query: args.query,
        cluster: keyName,
        mode: args.mode,
        raw: out.slice(0, 1200),
      })
      return out.slice(0, 1000)
    }

    const data = decide(hit, dataRes.hits, args.query, dataRes.rewrites)
    const head = stateBlock(keyName, hit, data.next)
    const body =
      args.mode === "state"
        ? ""
        : args.mode === "expand"
          ? allowExpand()
            ? expand(dataRes.hits, args.top_k)
            : "expand_blocked=1\nhint=use mode=delta or mode=brief unless debugging with RAG_ALLOW_EXPAND_TOOL=1"
          : args.mode === "brief"
            ? brief(dataRes.hits, args.top_k)
            : data.delta.length
              ? brief(data.delta, args.top_k)
              : "no_new_delta"

    await audit(baseDir, {
      channel: "rag_search",
      event: "tool_search",
      sessionID,
      query: args.query,
      cluster: keyName,
      mode: args.mode,
      node_type: args.node_type,
      status: data.status,
      reason: data.reason,
      total_hits: data.total,
      delta_hits: data.delta.length,
      known_hits: data.known,
      overlap: data.overlap,
      rewrite_mode: dataRes.rewrite_mode,
      top_hits: summary(hit.top, 3),
      delta_fps: data.delta.map((x) => ({
        fp: `${x.text_file || x.source_url || ""}#${x.chunk_id || x.image_id || x.section_title || ""}`,
        source_url: x.source_url || "",
        section_title: x.section_title || "",
        chunk_id: x.chunk_id || "",
      })),
      emitted_context: args.mode !== "state",
      rewrites: hit.rewrites,
      keywords: dataRes.keywords,
    })

    return body ? `${head}\n${body}` : head
  },
})
