import type { Status } from "../app"
import type { LucideIcon } from "lucide-react"

/** The kinds of workflow nodes a plugin may support. */
export type NodeKind = "coding" | "build-flash" | "debug" | "deploy" | "plan" | "explore"

/** Context passed into every plugin component. Generic over the detail shape
 *  the plugin cares about, so implementations don't need `as Detail` casts. */
export interface PluginContext<TDetail = unknown> {
  nodeId: string
  nodeType: NodeKind
  nodeStatus: Status
  detail: TDetail
  onAction?: (action: string, payload?: unknown) => void
}

/** A plugin declares which nodes it handles and how to render them.
 *  - `match(node, detail)` is the single decision point. Return true to claim
 *    the node. There is no separate `supportedTypes` list; collapsing the two
 *    kills the duplication we had before.
 *  - `priority` orders multi-match tabs; higher wins the first tab. */
export interface ToolPlugin<TDetail = unknown> {
  id: string
  name: string
  icon: LucideIcon
  priority: number
  match: (nodeType: NodeKind, detail: unknown) => boolean
  component: React.ComponentType<PluginContext<TDetail>>
}
