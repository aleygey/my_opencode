/** @jsxImportSource react */
import { useState } from "react"
import { Puzzle } from "lucide-react"
import { matchAll } from "../plugins/registry"
import type { NodeKind } from "../plugins/types"
import type { Status } from "../app"

interface PluginSlotProps {
  nodeId: string
  nodeType: NodeKind
  nodeStatus: Status
  detail: unknown
  onAction?: (action: string, payload?: unknown) => void
}

function FallbackPanel() {
  return (
    <div className="wf-detail-code">
      <div className="wf-detail-panel-header">
        <div className="flex items-center gap-2">
          <Puzzle className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
          <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">Tools</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-12 text-[var(--wf-dim)]">
        <Puzzle className="h-8 w-8 opacity-30" strokeWidth={1.2} />
        <p className="text-[12px]">No tools available for this node type.</p>
      </div>
    </div>
  )
}

export function PluginSlot({ nodeId, nodeType, nodeStatus, detail, onAction }: PluginSlotProps) {
  const matches = matchAll(nodeType, detail)
  const [activeIdx, setActiveIdx] = useState(0)

  if (matches.length === 0) {
    return <FallbackPanel />
  }

  const plugin = matches[activeIdx] ?? matches[0]
  const ctx = { nodeId, nodeType, nodeStatus, detail, onAction }
  const ToolComponent = plugin.component

  // Single plugin — render directly, no wrapper
  if (matches.length === 1) {
    return <ToolComponent {...ctx} />
  }

  // Multiple plugins — tab bar + active plugin content
  return (
    <>
      <div className="wf-plugin-tabs">
        {matches.map((p, idx) => {
          const Icon = p.icon
          const isActive = idx === activeIdx
          return (
            <button
              key={p.id}
              className={`wf-plugin-tab ${isActive ? "wf-plugin-tab--active" : ""}`}
              onClick={() => setActiveIdx(idx)}
              title={p.name}
            >
              <Icon className="h-3 w-3" strokeWidth={1.8} />
              <span>{p.name}</span>
            </button>
          )
        })}
      </div>
      <ToolComponent {...ctx} />
    </>
  )
}
