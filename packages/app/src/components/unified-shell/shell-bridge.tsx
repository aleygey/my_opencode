/**
 * Shell bridge context — lets module bodies publish their chrome config
 * (header / substrip / rail subs / tasks) to the parent UnifiedShell
 * without re-mounting the shell on route changes.
 *
 * Usage in a module body:
 *   const shell = useShellBridge()
 *   createEffect(() => {
 *     shell.setChrome({
 *       header: { parent: "Trace", title: "Recall · turn 1" },
 *       substrip: { tabs: [...], active: "recall", right: <…/> },
 *     })
 *   })
 *
 * The parent route mounts <ShellBridgeProvider> and reads the same
 * signals to feed UnifiedShell's props. SolidJS reactivity makes the
 * shell's chrome update without remounting; only the route children
 * swap on module navigation.
 */

import {
  type Accessor,
  createContext,
  createSignal,
  type JSX,
  type ParentProps,
  useContext,
} from "solid-js"
import type {
  ShellHeaderConfig,
  ShellRailSubItem,
  ShellSubstripConfig,
  ShellTask,
} from "."

export type ShellChromeConfig = {
  header?: ShellHeaderConfig
  substrip?: ShellSubstripConfig
  railSubs?: ShellRailSubItem[]
  activeSubId?: string
  onPickSub?: (id: string) => void
  railBadges?: Partial<Record<"workflow" | "knowledge" | "trace", string | number>>
  tasks?: ShellTask[]
  activeTaskId?: string
  onPickTask?: (id: string) => void
  onCreateTask?: () => void
  /** Optional ad-hoc body slot below the standard chrome. */
  bodyOverlay?: JSX.Element
}

type ShellBridgeAPI = {
  /** Read the current accumulated config — used by <UnifiedShell>. */
  chrome: Accessor<ShellChromeConfig>
  /** Replace the entire chrome config. Called from each module body in
   * a createEffect that depends on the body's reactive state. */
  setChrome: (cfg: ShellChromeConfig) => void
}

const Ctx = createContext<ShellBridgeAPI>()

/** Mount once at the top of the unified session route. Holds a signal
 * for the chrome config; child module bodies push to it via setChrome. */
export function ShellBridgeProvider(props: ParentProps) {
  const [chrome, setChrome] = createSignal<ShellChromeConfig>({})
  const value: ShellBridgeAPI = { chrome, setChrome }
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

/** Access the bridge. Throws if used outside ShellBridgeProvider. */
export function useShellBridge(): ShellBridgeAPI {
  const ctx = useContext(Ctx)
  if (!ctx) {
    throw new Error("useShellBridge() must be used inside <ShellBridgeProvider>")
  }
  return ctx
}
