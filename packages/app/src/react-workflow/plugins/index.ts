import { register, match, matchAll, all, get, clear } from "./registry"
import { diffToolPlugin } from "./diff-tool"
import { serialToolPlugin } from "./serial-tool"
import { executionToolPlugin } from "./execution-tool"
import { planToolPlugin } from "./plan-tool"
import type { ToolPlugin, PluginMatch, ToolData, PluginContext, ToolStatus } from "./types"

export type { ToolPlugin, PluginMatch, ToolData, PluginContext, ToolStatus }

export { register, match, matchAll, all, get, clear }
export { diffToolPlugin, serialToolPlugin, executionToolPlugin, planToolPlugin }

export function initPlugins() {
  clear()
  register(diffToolPlugin)
  register(serialToolPlugin)
  register(executionToolPlugin)
  register(planToolPlugin)
}

initPlugins()
