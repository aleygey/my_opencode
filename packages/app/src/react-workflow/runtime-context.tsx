/** @jsxImportSource react */
import { createContext, useContext, type ReactNode } from "react"

/**
 * Runtime context the SolidJS shell injects into the React workflow tree so
 * plugins can talk to the local opencode HTTP server (e.g. the serial monitor
 * needs to hit `/serial/*` and open the websocket on `/serial/:id/connect`).
 *
 * Carrying this through React context — instead of widening `PluginContext`
 * with N more fields per integration — keeps every plugin component a
 * self-contained leaf and keeps `<PluginSlot>` ignorant of any individual
 * plugin's IO needs.
 */
export interface WorkflowRuntime {
  /** Base URL of the running opencode HTTP server (e.g. `http://localhost:3000`).
   *  Plugins should resolve REST and WS URLs relative to this. */
  apiBase: string
  /** Pre-formatted `Authorization` header value when the server is password
   *  protected (`Basic <b64>`). Plugins must forward this on every fetch.
   *  Undefined when the server is open. */
  authHeader?: string
}

const WorkflowRuntimeContext = createContext<WorkflowRuntime | null>(null)

export function WorkflowRuntimeProvider(props: {
  value: WorkflowRuntime | null
  children: ReactNode
}) {
  return (
    <WorkflowRuntimeContext.Provider value={props.value}>{props.children}</WorkflowRuntimeContext.Provider>
  )
}

/** Returns the runtime when present. Plugin components should fall back to a
 *  "backend offline" UI when null — that's the disconnected dev case where
 *  the React tree was rendered without a SolidJS shell wiring it up. */
export function useWorkflowRuntime(): WorkflowRuntime | null {
  return useContext(WorkflowRuntimeContext)
}
