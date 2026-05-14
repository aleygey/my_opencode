import { register, unregister, match, matchAll, all, get, clear } from "./registry"
import { diffToolPlugin } from "./diff-tool"
import { serialToolPlugin } from "./serial-tool"
import { exploreToolPlugin } from "./explore-tool"
import type { ToolPlugin, PluginContext, NodeKind } from "./types"

export type { ToolPlugin, PluginContext, NodeKind }
export { register, unregister, match, matchAll, all, get, clear }
export { diffToolPlugin, serialToolPlugin, exploreToolPlugin }

/** Register the built-in plugins. Call once at app bootstrap; safe to call
 *  again (it clears the registry first). No module-import side effects. */
export function initPlugins() {
  clear()
  register(diffToolPlugin)
  register(serialToolPlugin)
  register(exploreToolPlugin)
}
