import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"
import type { Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider_ready: boolean
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  mcp_ready: boolean
  mcp: {
    [name: string]: McpStatus
  }
  lsp_ready: boolean
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  /* Session-level error banners surfaced to the UI. Captures every
   * error class the backend publishes via `session.error` plus the
   * compaction-failed event. The chat panel renders a banner for
   * whatever's parked here; cleared on session.deleted, success
   * paths (e.g. session.compacted), or future explicit dismiss.
   *
   * Each kind maps 1:1 to a `MessageV2` error class on the backend
   * (see `packages/opencode/src/session/message-v2.ts`):
   *
   *   compaction_failed   — Event.CompactionFailed (after compaction
   *                         can't shrink session under context cap)
   *   context_overflow    — ContextOverflowError (provider rejected
   *                         the request as too large)
   *   auth                — ProviderAuthError (API key invalid/missing)
   *   api                 — APIError (rate limit / 5xx / network)
   *   output_length       — MessageOutputLengthError (response cut by
   *                         provider mid-stream)
   *   structured_output   — StructuredOutputError (model emitted
   *                         malformed JSON for a json_schema response)
   *   aborted             — MessageAbortedError (user cancelled)
   *   agent_not_found     — Agent.get() returned null in prompt.ts
   *   model_not_found     — Provider.ModelNotFoundError on model resolve
   *   command_not_found   — Slash command lookup miss
   *   file_read_failed    — File attachment couldn't be read
   *   unknown             — fall-back for any uncategorised error
   */
  sessionError: {
    [sessionID: string]:
      | { kind: "compaction_failed"; reason: string; replay: boolean }
      | { kind: "context_overflow"; message: string }
      | { kind: "auth"; provider?: string; message: string }
      | { kind: "api"; message: string; statusCode?: number; retryable?: boolean }
      | { kind: "output_length"; message?: string }
      | { kind: "structured_output"; message: string; retries?: number }
      | { kind: "aborted"; message?: string }
      | { kind: "agent_not_found"; agent?: string; message: string }
      | { kind: "model_not_found"; provider?: string; model?: string; message: string }
      | { kind: "command_not_found"; command?: string; message: string }
      | { kind: "file_read_failed"; path?: string; message: string }
      | { kind: "unknown"; name?: string; message: string }
      | undefined
  }
}

export type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

export type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

export type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

export type ChildOptions = {
  bootstrap?: boolean
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export type RootLoadArgs = {
  directory: string
  limit: number
  list: (query: { directory: string; roots: true; limit?: number }) => Promise<{ data?: Session[] }>
}

export type RootLoadResult = {
  data?: Session[]
  limit: number
  limited: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
