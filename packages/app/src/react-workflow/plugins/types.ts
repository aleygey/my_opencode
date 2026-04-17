import type { Status } from "../app"
import type { LucideIcon } from "lucide-react"

export type ToolStatus = "idle" | "running" | "completed" | "failed" | "paused"

export interface ToolData {
  status: ToolStatus
  progress?: number
  timestamp?: string
  rawData?: unknown
}

export interface PluginContext {
  nodeId: string
  nodeType: string
  nodeStatus: Status
  data: ToolData
  detail?: unknown
  onAction?: (action: string, payload?: unknown) => void
}

export interface ToolPlugin {
  id: string
  name: string
  icon: LucideIcon
  supportedTypes: string[]
  priority: number
  component: React.ComponentType<PluginContext>
  getData?: (detail: unknown) => ToolData
  matches?: (nodeType: string, detail: unknown) => boolean
}

export interface PluginMatch {
  plugin: ToolPlugin
  data: ToolData
}
