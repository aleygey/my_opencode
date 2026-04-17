import type { ToolPlugin, PluginMatch, ToolData } from "./types"

const plugins: Map<string, ToolPlugin> = new Map()

export function register(plugin: ToolPlugin) {
  plugins.set(plugin.id, plugin)
}

export function get(id: string): ToolPlugin | undefined {
  return plugins.get(id)
}

export function all(): ToolPlugin[] {
  return Array.from(plugins.values()).sort((a, b) => b.priority - a.priority)
}

export function match(nodeType: string, detail: unknown): PluginMatch | null {
  const sorted = all()
  for (const plugin of sorted) {
    if (!plugin.supportedTypes.includes(nodeType)) continue
    if (plugin.matches && !plugin.matches(nodeType, detail)) continue
    const data = plugin.getData?.(detail) ?? { status: "idle" }
    return { plugin, data }
  }
  return null
}

export function matchAll(nodeType: string, detail: unknown): PluginMatch[] {
  const sorted = all()
  const matches: PluginMatch[] = []
  for (const plugin of sorted) {
    if (!plugin.supportedTypes.includes(nodeType)) continue
    if (plugin.matches && !plugin.matches(nodeType, detail)) continue
    const data = plugin.getData?.(detail) ?? { status: "idle" }
    matches.push({ plugin, data })
  }
  return matches
}

export function clear() {
  plugins.clear()
}

export { plugins }
