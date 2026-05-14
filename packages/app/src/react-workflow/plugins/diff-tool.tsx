/** @jsxImportSource react */
import { useMemo, useState } from "react"
import { FileCode2, Plus, Minus, Check, ChevronRight, ChevronDown, Folder, FolderOpen } from "lucide-react"
import type { ToolPlugin, PluginContext } from "./types"
import type { Detail } from "../app"

type Change = NonNullable<Detail["codeChanges"]>[number]

// Hierarchical file tree built from a flat list of file paths. Each node is
// either a directory (with children) or a file (leaf with a `change`
// reference). Used by the Code Changes panel to render diffs grouped by
// their directory layout — the user reported that a flat tab strip
// becomes unreadable on multi-git workspaces where many files share base
// names across nested sub-packages.
type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string; change: Change; changeIndex: number }

type DirNode = { kind: "dir"; name: string; path: string; children: TreeNode[] }
type FileNode = { kind: "file"; name: string; path: string; change: Change; changeIndex: number }

function buildFileTree(changes: Change[]): DirNode {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [] }
  changes.forEach((change, idx) => {
    const parts = change.file.split("/").filter(Boolean)
    if (parts.length === 0) return
    let cursor: DirNode = root
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]
      const isLast = i === parts.length - 1
      const segPath = parts.slice(0, i + 1).join("/")
      if (isLast) {
        cursor.children.push({ kind: "file", name: seg, path: segPath, change, changeIndex: idx })
        continue
      }
      const existing = cursor.children.find((c): c is DirNode => c.kind === "dir" && c.name === seg)
      if (existing) {
        cursor = existing
      } else {
        const next: DirNode = { kind: "dir", name: seg, path: segPath, children: [] }
        cursor.children.push(next)
        cursor = next
      }
    }
  })
  // Collapse single-child dir chains so deep paths (`packages/opencode/src/foo`)
  // read as a single row instead of four nested levels. Keeps the tree
  // visually flat where the hierarchy doesn't carry meaning.
  const collapse = (node: TreeNode): TreeNode => {
    if (node.kind !== "dir") return node
    let current: DirNode = {
      ...node,
      children: node.children.map(collapse),
    }
    while (
      current.children.length === 1 &&
      current.children[0].kind === "dir"
    ) {
      const only = current.children[0] as DirNode
      current = {
        kind: "dir",
        name: current.name ? `${current.name}/${only.name}` : only.name,
        path: only.path,
        children: only.children,
      }
    }
    return current
  }
  const collapsed = collapse(root)
  return collapsed.kind === "dir" ? collapsed : root
}

function FileTreeRow({
  node,
  depth,
  activeIndex,
  onPick,
  collapsedDirs,
  toggleDir,
}: {
  node: TreeNode
  depth: number
  activeIndex: number
  onPick: (idx: number) => void
  collapsedDirs: Set<string>
  toggleDir: (p: string) => void
}) {
  const indent = { paddingLeft: `${depth * 12 + 6}px` }
  if (node.kind === "dir") {
    if (!node.name) {
      return (
        <>
          {node.children.map((c) => (
            <FileTreeRow
              key={`${c.kind}:${c.path}`}
              node={c}
              depth={depth}
              activeIndex={activeIndex}
              onPick={onPick}
              collapsedDirs={collapsedDirs}
              toggleDir={toggleDir}
            />
          ))}
        </>
      )
    }
    const collapsed = collapsedDirs.has(node.path)
    return (
      <>
        <button
          type="button"
          className="wf-detail-file-tree-row"
          style={indent}
          onClick={() => toggleDir(node.path)}
          title={node.path}
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={2} />
          ) : (
            <ChevronDown className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={2} />
          )}
          {collapsed ? (
            <Folder className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />
          ) : (
            <FolderOpen className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />
          )}
          <span className="truncate text-[11px] text-[var(--wf-ink-soft)]">{node.name}</span>
        </button>
        {!collapsed &&
          node.children.map((c) => (
            <FileTreeRow
              key={`${c.kind}:${c.path}`}
              node={c}
              depth={depth + 1}
              activeIndex={activeIndex}
              onPick={onPick}
              collapsedDirs={collapsedDirs}
              toggleDir={toggleDir}
            />
          ))}
      </>
    )
  }
  const active = node.changeIndex === activeIndex
  return (
    <button
      type="button"
      className={`wf-detail-file-tree-row ${active ? "wf-detail-file-tree-row--active" : ""}`}
      style={indent}
      onClick={() => onPick(node.changeIndex)}
      title={node.path}
    >
      <span className="w-3 flex-shrink-0" />
      <FileCode2 className="h-3 w-3 flex-shrink-0 text-[var(--wf-dim)]" strokeWidth={1.8} />
      <span className="truncate text-[11px]">{node.name}</span>
      <span className="ml-auto pl-2 text-[10px] text-[var(--wf-ok)] tabular-nums">
        +{node.change.additions}
      </span>
      {node.change.deletions > 0 && (
        <span className="text-[10px] text-rose-300 tabular-nums">−{node.change.deletions}</span>
      )}
    </button>
  )
}

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
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  const files = detail?.codeChanges ?? []
  const active = files[tab] ?? files[0]
  const changes = diffRows(active)
  const run = nodeStatus === "running"

  const tree = useMemo(() => buildFileTree(files), [files])
  const toggleDir = (p: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

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
        <div className="wf-detail-file-tree">
          {files.length > 0 ? (
            <FileTreeRow
              node={tree}
              depth={0}
              activeIndex={tab}
              onPick={setTab}
              collapsedDirs={collapsedDirs}
              toggleDir={toggleDir}
            />
          ) : (
            <div className="px-3 py-2 text-[11px] text-[var(--wf-dim)]">No changes yet</div>
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
