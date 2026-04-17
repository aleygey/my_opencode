/** @jsxImportSource react */
import { useState } from "react"
import { diffLines } from "diff"
import { FileCode2, Plus, Minus, Check } from "lucide-react"
import type { ToolPlugin, PluginContext, ToolData, ToolStatus } from "./types"
import type { Detail } from "../app"

type Change = NonNullable<Detail["codeChanges"]>[number]

function diffRows(item?: Change) {
  if (!item) return []
  let before = 1
  let after = 1
  return diffLines(item.before, item.after).flatMap((change) => {
    const rows = change.value.split("\n")
    if (rows.at(-1) === "") rows.pop()
    return rows.map((text) => {
      if (change.added) {
        const line = { before: "", after: String(after), sign: "+", text, mode: "added" as const }
        after += 1
        return line
      }
      if (change.removed) {
        const line = { before: String(before), after: "", sign: "-", text, mode: "removed" as const }
        before += 1
        return line
      }
      const line = { before: String(before), after: String(after), sign: " ", text, mode: "plain" as const }
      before += 1
      after += 1
      return line
    })
  })
}

function DiffTool({ nodeId, nodeStatus, data, detail }: PluginContext) {
  const [tab, setTab] = useState(0)
  const d = detail as Detail | null
  const files = d?.codeChanges ?? []
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
            files.map((item, idx) => (
              <button
                key={item.file}
                className={`wf-detail-file-tab ${idx === tab ? "wf-detail-file-tab--active" : ""}`}
                onClick={() => setTab(idx)}
              >
                <FileCode2 className="h-3 w-3" strokeWidth={1.8} />
                {item.file.split("/").at(-1)}
                <span className="text-[var(--wf-ok)]">+{item.additions}</span>
              </button>
            ))
          ) : (
            <div className="wf-detail-file-tab wf-detail-file-tab--active">
              <FileCode2 className="h-3 w-3" strokeWidth={1.8} />
              No changes yet
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2">
        <span className="font-mono text-[11px] text-[var(--wf-dim)]">{active?.file ?? "No file selected"}</span>
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

export const diffToolPlugin: ToolPlugin = {
  id: "diff-tool",
  name: "Code Diff",
  icon: FileCode2,
  supportedTypes: ["coding", "build-flash"],
  priority: 100,
  component: DiffTool,
  getData: (detail: unknown): ToolData => {
    const d = detail as Detail | null
    const files = d?.codeChanges ?? []
    return {
      status: files.length > 0 ? "completed" : "idle",
      progress: files.length,
      rawData: files,
    }
  },
  matches: (nodeType: string, detail: unknown): boolean => {
    const d = detail as Detail | null
    return (d?.codeChanges?.length ?? 0) > 0 || nodeType === "coding"
  },
}
