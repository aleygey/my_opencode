import type { NodeKind, ToolPlugin } from "./types"

const plugins = new Map<string, ToolPlugin<any>>()

export function register<TDetail>(plugin: ToolPlugin<TDetail>) {
  plugins.set(plugin.id, plugin as ToolPlugin<any>)
}

export function unregister(id: string) {
  plugins.delete(id)
}

export function get(id: string): ToolPlugin<any> | undefined {
  return plugins.get(id)
}

export function all(): ToolPlugin<any>[] {
  return Array.from(plugins.values()).sort((a, b) => b.priority - a.priority)
}

/** Return every plugin that claims the given node, ordered by priority. */
export function matchAll(nodeType: NodeKind, detail: unknown): ToolPlugin<any>[] {
  return all().filter((p) => p.match(nodeType, detail))
}

/** Return the highest-priority plugin that claims the node, or undefined. */
export function match(nodeType: NodeKind, detail: unknown): ToolPlugin<any> | undefined {
  return matchAll(nodeType, detail)[0]
}

export function clear() {
  plugins.clear()
}
