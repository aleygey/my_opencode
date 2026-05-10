/**
 * Distill a noisy planner-emitted title down to a clean short label.
 *
 * Backend `node.title` often arrives shaped like
 *   "Plan · ## Goal 在本地 opencode 中实现…\n\n## Core req\n…"
 * because the planner LLM doesn't follow a strict {title, body}
 * schema and the workflow runtime ends up using the whole prompt as
 * the title. This util strips:
 *   1. a leading `Plan · ` / `Coding · ` / `Build · ` etc. prefix
 *      (the kind label is already shown as a chip),
 *   2. any markdown header marks (`#`, `##`, `###`),
 *   3. anything past the first non-blank line.
 * Then truncates to the requested limit (default ~28 chars) with an
 * ellipsis. The full text stays available via the cell's `title=`
 * tooltip and the inspector raw view.
 *
 * Lives in `react-workflow/utils/` so both the canvas node, the
 * inspector header, and any other surface that renders a node title
 * can share a single distillation rule — applying it inconsistently
 * was making the canvas look clean while the inspector still showed
 * the full prompt body (user-reported "node 节点的标题是一长串
 * prompt"). */
export function distillTitle(raw: string | undefined | null, limit = 28): string {
  if (!raw) return ""
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    let s = t
    // Drop `Plan · ` / `Code · ` / `Build · ` style prefix.
    s = s.replace(
      /^(?:Plan|Code|Coding|Build|Debug|Deploy|Explore|计划|编码|构建|调试|部署|探索)\s*[·:：-]\s*/u,
      "",
    )
    // Drop markdown header markers + a trailing colon.
    s = s.replace(/^#+\s*/u, "").replace(/[：:]\s*$/u, "")
    if (!s) continue
    return s.length > limit ? s.slice(0, limit - 2).trimEnd() + "…" : s
  }
  return raw.length > limit ? raw.slice(0, limit - 2).trimEnd() + "…" : raw
}
