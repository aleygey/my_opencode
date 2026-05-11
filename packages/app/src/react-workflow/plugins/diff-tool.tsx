/** @jsxImportSource react */
import { useState } from "react"
import { FileCode2, Plus, Minus, Check } from "lucide-react"
import type { ToolPlugin, PluginContext } from "./types"
import type { Detail } from "../app"

type Change = NonNullable<Detail["codeChanges"]>[number]

// Parse a unified diff patch (as emitted by git) into per-line rows. Each row
// carries its sign (+/-/ ), synthetic before/after line numbers, and a mode
// flag for styling. Hunk headers and file-meta lines are ignored — only body
// lines show up in the output.
function diffRows(item?: Change) {
  if (!item?.patch) return []
  const rows: Array<{
    before: string
    after: string
    sign: string
    text: string
    mode: "added" | "removed" | "plain"
  }> = []
  let before = 0
  let after = 0
  for (const raw of item.patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (match) {
        before = parseInt(match[1], 10)
        after = parseInt(match[2], 10)
      }
      continue
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue
    if (raw.startsWith("+")) {
      rows.push({ before: "", after: String(after), sign: "+", text: raw.slice(1), mode: "added" })
      after += 1
    } else if (raw.startsWith("-")) {
      rows.push({ before: String(before), after: "", sign: "-", text: raw.slice(1), mode: "removed" })
      before += 1
    } else if (raw.length > 0) {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw
      rows.push({ before: String(before), after: String(after), sign: " ", text, mode: "plain" })
      before += 1
      after += 1
    }
  }
  return rows
}

function DiffTool({ nodeId, nodeStatus, detail }: PluginContext<Detail | null>) {
  const [tab, setTab] = useState(0)
  const files = detail?.codeChanges ?? []
  const active = files[tab] ?? files[0]
  const changes = diffRows(active)
  const run = nodeStatus === "running"

  return (
    <div className="wf-detail-code">
      <div className="wf-detail-panel-header">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
            <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">Code Changes</span>
          </div>
          {files.length > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--wf-chip)] px-1.5 text-[10px] font-bold tabular-nums text-[var(--wf-dim)]">
              {files.length}
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {files.length > 0 ? (
            files.map((item, idx) => {
              // Per the user's "上面的文件没有对应的目录" — show the
              // PARENT directory next to the filename so tabs scan as
              // "src/foo · bar.ts" instead of just "bar.ts" (which
              // collides whenever two paths end with the same name).
              const parts = item.file.split("/")
              const filename = parts.at(-1) ?? item.file
              // Take the last 2 segments of the parent dir — enough to
              // disambiguate without exploding tab width on very deep
              // paths like `packages/opencode/src/foo/bar/...`.
              const parentSegments = parts.slice(0, -1)
              const parentShort =
                parentSegments.length <= 2
                  ? parentSegments.join("/")
                  : `…/${parentSegments.slice(-2).join("/")}`
              return (
                <button
                  key={item.file}
                  className={`wf-detail-file-tab ${idx === tab ? "wf-detail-file-tab--active" : ""}`}
                  onClick={() => setTab(idx)}
                  title={item.file}
                >
                  <FileCode2 className="h-3 w-3" strokeWidth={1.8} />
                  {parentShort && (
                    <span className="text-[10px] text-[var(--wf-dim)]">{parentShort}/</span>
                  )}
                  <span>{filename}</span>
                  <span className="text-[var(--wf-ok)]">+{item.additions}</span>
                </button>
              )
            })
          ) : (
            <div className="wf-detail-file-tab wf-detail-file-tab--active">
              <FileCode2 className="h-3 w-3" strokeWidth={1.8} />
              No changes yet
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2">
        {/* Full path breadcrumb above the diff. The tab above only
         * shows the last 2 parent segments to keep the tab compact;
         * here we render the FULL path so the user can read the
         * exact location. `truncate` keeps it on one line; the
         * tooltip on hover surfaces the full string regardless. */}
        <span
          className="truncate font-mono text-[11px] text-[var(--wf-dim)]"
          title={active?.file}
        >
          {active?.file ?? "No file selected"}
        </span>
      </div>

      <div className="wf-detail-diff">
        {active ? (
          <>
            <div className="wf-detail-diff-hunk">{`@@ ${active.status ?? "modified"} ${active.file} @@`}</div>
            {changes.map((line, i) => (
              <div key={`${active.file}:${i}`} className="wf-detail-diff-line">
                <span className="wf-detail-diff-num">{line.after || line.before || "·"}</span>
                <span className="wf-detail-diff-sign">{line.sign}</span>
                <span
                  className={`wf-detail-diff-text ${
                    line.mode === "added"
                      ? "wf-detail-diff-text--added"
                      : line.mode === "removed"
                        ? "text-rose-300"
                        : ""
                  }`}
                >
                  {line.text || " "}
                </span>
              </div>
            ))}
          </>
        ) : (
          <div className="px-5 py-6 text-[12px] text-[var(--wf-dim)]">No file changes for this node yet.</div>
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2.5 text-[11px]">
        <span className="flex items-center gap-1 font-semibold text-[var(--wf-ok)]">
          <Plus className="h-3 w-3" strokeWidth={2} />
          {active?.additions ?? 0} additions
        </span>
        <span className="flex items-center gap-1 text-[var(--wf-dim)]">
          <Minus className="h-3 w-3" strokeWidth={2} />
          {active?.deletions ?? 0} deletions
        </span>
        <span className="ml-auto font-mono text-[10px] text-[var(--wf-dim)]">{changes.length} lines</span>
      </div>
    </div>
  )
}

export const diffToolPlugin: ToolPlugin<Detail | null> = {
  id: "diff-tool",
  name: "Code Diff",
  icon: FileCode2,
  priority: 100,
  component: DiffTool,
  // Claim any coding node, and any other node that already has file changes
  // attached (e.g. a build-flash node that produced patches).
  match: (nodeType, detail) => {
    const d = detail as Detail | null
    return nodeType === "coding" || (d?.codeChanges?.length ?? 0) > 0
  },
}
