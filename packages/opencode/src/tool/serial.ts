import { Effect } from "effect"
import z from "zod"
import { Serial } from "@/serial"
import { SerialID } from "@/serial/schema"
import * as Tool from "./tool"

const format = (value: unknown) => JSON.stringify(value, null, 2)

// ── serial_list_ports ──────────────────────────────────────────────────────
// Discover physical serial devices attached to the host.

export const SerialListPortsTool = Tool.define(
  "serial_list_ports",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "List physical serial devices attached to the host (path, manufacturer, vendorId, productId). Call this first to find a device before serial_create.",
      parameters: z.object({}),
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ports = yield* serial.listPorts()
          return {
            title: `${ports.length} port(s)`,
            metadata: { count: ports.length, ports },
            output: format(ports),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_list ────────────────────────────────────────────────────────────
// List open serial sessions (shared between agent and UI).

export const SerialListTool = Tool.define(
  "serial_list",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "List currently open serial sessions. Each session is shared between the agent and any UI client attached to the same SerialID.",
      parameters: z.object({}),
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const list = yield* serial.list()
          return {
            title: `${list.length} session(s)`,
            metadata: { count: list.length, sessions: list },
            output: format(list),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_create ──────────────────────────────────────────────────────────
// Open a new serial session.

const SerialCreateParameters = z.object({
  path: z.string().describe("Device path (e.g. /dev/ttyUSB0 or COM3)"),
  baudRate: z.number().int().positive().default(115200),
  title: z.string().optional().describe("Human-readable label shown in the UI"),
  dataBits: z.number().int().optional(),
  stopBits: z.number().int().optional(),
  parity: z.enum(["none", "even", "odd", "mark", "space"]).optional(),
  flowControl: z.boolean().optional(),
})

export const SerialCreateTool = Tool.define(
  "serial_create",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "Open a serial session on the given device path. Returns a SerialID. The session is visible to the UI so the user can monitor the same stream.",
      parameters: SerialCreateParameters,
      execute: (params: z.infer<typeof SerialCreateParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* serial.create(params)
          return {
            title: info.title,
            metadata: { serialID: info.id, ...info },
            output: format(info),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_write ───────────────────────────────────────────────────────────
// Send a command or raw bytes down a serial session.

const SerialWriteParameters = z.object({
  serial_id: z.string().describe("SerialID returned by serial_create"),
  data: z
    .string()
    .describe(
      "Payload to send. Escape sequences are interpreted: \\r \\n \\t \\0 \\xNN \\u####. " +
        "Example: send Ctrl-C with \\x03, send 'slp' line with 'slp\\r\\n'.",
    ),
})

export const SerialWriteTool = Tool.define(
  "serial_write",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "Write data to an open serial session. Use a trailing \\r\\n if the target device expects a line terminator.",
      parameters: SerialWriteParameters,
      execute: (params: z.infer<typeof SerialWriteParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const id = SerialID.zod.parse(params.serial_id)
          const interpreted = Serial.decode(params.data)
          yield* serial.write(id, interpreted)
          return {
            title: `write ${interpreted.length}B`,
            metadata: { serialID: id, bytes: interpreted.length },
            output: `wrote ${interpreted.length} bytes to ${id}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_read_recent ─────────────────────────────────────────────────────
// Snapshot the ring buffer so the agent can observe output without a
// WebSocket. Supports incremental reads via `since_cursor` so an agent can
// stream-tail a session across multiple turns without re-reading the same
// bytes (huge token saver for boot logs / dmesg dumps).

const SerialReadRecentParameters = z.object({
  serial_id: z.string(),
  since_cursor: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Read from this absolute byte cursor onward. Pass back the `cursor` " +
        "value returned by a previous call to read only the new bytes since " +
        "then. Wins over tail_bytes when both are provided.",
    ),
  tail_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .default(4096)
    .describe("Return only the last N bytes. Ignored when since_cursor is set."),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Hard cap on returned data length. The most recent bytes are kept."),
})

export const SerialReadRecentTool = Tool.define(
  "serial_read_recent",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "Read buffered output of a serial session. Prefer `since_cursor` for incremental reads — the response includes a `cursor` you can pass back next time to read only newly arrived bytes. `tail_bytes` is the legacy mode that always returns the most recent N bytes.",
      parameters: SerialReadRecentParameters,
      execute: (params: z.infer<typeof SerialReadRecentParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const id = SerialID.zod.parse(params.serial_id)
          const snap = yield* serial.snapshot(id, {
            tailBytes: params.tail_bytes,
            sinceCursor: params.since_cursor,
            maxBytes: params.max_bytes,
          })
          if (!snap) {
            return {
              title: "not found",
              metadata: { serialID: id, found: false },
              output: `No active session ${id}.`,
            }
          }
          const metadata = {
            serialID: id,
            found: true,
            cursor: snap.cursor,
            bufferCursor: snap.bufferCursor,
            fromCursor: snap.fromCursor,
            bytes: snap.data.length,
            // `dropped` > 0 means the requested `since_cursor` predates the
            // start of the ring buffer — the agent should know data was lost.
            ...(snap.dropped > 0 && { droppedBytes: snap.dropped }),
          }
          const title =
            snap.dropped > 0
              ? `${snap.data.length}B @ ${snap.cursor} (lost ${snap.dropped}B)`
              : `${snap.data.length}B @ ${snap.cursor}`
          return { title, metadata, output: snap.data }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_grep ────────────────────────────────────────────────────────────
// Pull only matching lines out of the ring buffer instead of dumping the
// whole tail. Server-side filtering = far fewer tokens when the agent only
// cares about specific events (errors, prompts, kernel messages).

const SerialGrepParameters = z.object({
  serial_id: z.string(),
  pattern: z.string().describe("Regex pattern matched against each line."),
  since_cursor: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Scan from this byte cursor onward. Wins over tail_bytes when both are set."),
  tail_bytes: z.number().int().positive().optional().describe("Only scan the last N bytes."),
  max_matches: z.number().int().positive().optional().default(50),
})

export const SerialGrepTool = Tool.define(
  "serial_grep",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "Filter the ring buffer for lines matching a regex pattern. Use this instead of serial_read_recent when scanning a noisy boot log for specific events — far fewer tokens than reading the whole tail.",
      parameters: SerialGrepParameters,
      execute: (params: z.infer<typeof SerialGrepParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const id = SerialID.zod.parse(params.serial_id)
          const result = yield* serial.grep(id, {
            pattern: params.pattern,
            sinceCursor: params.since_cursor,
            tailBytes: params.tail_bytes,
            maxMatches: params.max_matches,
          })
          const metadata: {
            serialID: string
            found: boolean
            matches?: number
            scannedFrom?: number
            scannedTo?: number
            truncated?: boolean
          } = result
            ? {
                serialID: id,
                found: true,
                matches: result.matches.length,
                scannedFrom: result.scannedFrom,
                scannedTo: result.scannedTo,
                truncated: result.truncated,
              }
            : { serialID: id, found: false }
          if (!result) {
            return { title: "not found", metadata, output: `No active session ${id}.` }
          }
          const lines = result.matches.map((m) => `[${m.cursor}] ${m.line}`).join("\n")
          return {
            title: `${result.matches.length} match(es)`,
            metadata,
            output: lines || "(no matches)",
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_wait ────────────────────────────────────────────────────────────
// Block until a regex pattern appears in the stream (or timeout). Avoids
// the "poll serial_read_recent in a loop and dump the full tail every time"
// anti-pattern. Server holds the wait inside its event loop so latency
// matches the chunk-arrival cadence, not LLM tool-call cadence.

const SerialWaitParameters = z.object({
  serial_id: z.string(),
  pattern: z.string().describe("Regex pattern; matched against the ring buffer with the 'm' flag."),
  timeout_ms: z.number().int().positive().default(10000),
  context_lines: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(3)
    .describe("Number of lines of context to return before/after the match."),
})

export const SerialWaitTool = Tool.define(
  "serial_wait",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "Block until a regex pattern appears in the serial stream, then return the match plus a few lines of context. Use this to wait for prompts (e.g. '=> ' for u-boot, '# $' for a shell, 'login:' before authenticating) without polling and without flooding context with the boot log.",
      parameters: SerialWaitParameters,
      execute: (params: z.infer<typeof SerialWaitParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const id = SerialID.zod.parse(params.serial_id)
          const result = yield* serial.wait(id, {
            pattern: params.pattern,
            timeoutMs: params.timeout_ms,
            contextLines: params.context_lines,
          })
          const metadata: {
            serialID: string
            found: boolean
            matched?: boolean
            cursor?: number
            match?: string
            timedOut?: boolean
          } = { serialID: id, found: !!result }
          if (!result) {
            return { title: "not found", metadata, output: `No active session ${id}.` }
          }
          if (result.matched) {
            metadata.matched = true
            metadata.cursor = result.cursor
            metadata.match = result.match
            return {
              title: `matched @ ${result.cursor}`,
              metadata,
              output: [
                result.before ? `─ before ─\n${result.before}` : undefined,
                `─ match ─\n${result.match}`,
                result.after ? `─ after ─\n${result.after}` : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
            }
          }
          metadata.matched = false
          metadata.cursor = result.cursor
          metadata.timedOut = true
          return {
            title: `timed out after ${params.timeout_ms}ms`,
            metadata,
            output: `Pattern /${params.pattern}/ did not appear within ${params.timeout_ms}ms.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_arm ─────────────────────────────────────────────────────────────
// Register a server-side reactive trigger. Two flavours:
//
//   1. `on_pattern` (reactive): when the regex matches incoming data, write
//      `response`. One-shot or N-shot via `max_fires`.
//   2. `every_ms` (periodic): write `response` every N ms. Stop when
//      `until_pattern` matches, `max_fires` is hit, or `timeout_ms` elapses.
//
// Use case: power-cycle a board and continuously send "slp" until u-boot
// prompt appears, then auto-disarm — agent never enters the realtime loop.

const SerialArmParameters = z
  .object({
    serial_id: z.string(),
    response: z
      .string()
      .describe("Bytes to send when the trigger fires. Escape sequences \\r \\n \\t \\xNN \\u#### are decoded."),
    on_pattern: z
      .string()
      .optional()
      .describe("Regex; fire `response` whenever this matches incoming data. Mutually exclusive with `every_ms`."),
    every_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Periodically fire `response` every N ms (no input gating; useful for u-boot break spam). " +
          "Mutually exclusive with `on_pattern`.",
      ),
    until_pattern: z
      .string()
      .optional()
      .describe("Regex; auto-disarm when this matches incoming data. Use to stop a periodic trigger on prompt detection."),
    max_fires: z.number().int().positive().optional().describe("Disarm after this many fires."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Hard deadline; auto-disarm after this many ms regardless of state."),
  })
  .refine((d) => !!d.on_pattern || !!d.every_ms, {
    message: "Must provide either `on_pattern` (reactive) or `every_ms` (periodic).",
  })
  .refine((d) => !(d.on_pattern && d.every_ms), {
    message: "`on_pattern` and `every_ms` are mutually exclusive.",
  })
  .refine((d) => !!d.until_pattern || !!d.max_fires || !!d.timeout_ms, {
    message: "At least one stop condition is required: `until_pattern`, `max_fires`, or `timeout_ms`.",
  })

export const SerialArmTool = Tool.define(
  "serial_arm",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "Arm a server-side reactive trigger on a serial session. The trigger fires entirely inside opencode's event loop (sub-millisecond latency), so it can hit deadlines that an LLM tool-call round-trip cannot — e.g. spam 'slp' to break into u-boot before autoboot completes.\n\nTwo modes:\n  • on_pattern: when regex matches incoming data → write response\n  • every_ms: periodically write response every N ms\n\nAlways include a stop condition (until_pattern / max_fires / timeout_ms) — otherwise the trigger runs forever.\n\nReturns a trigger_id you can pass to serial_disarm.",
      parameters: SerialArmParameters,
      execute: (params: z.infer<typeof SerialArmParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const id = SerialID.zod.parse(params.serial_id)
          const triggerId = yield* serial.arm(id, {
            response: Serial.decode(params.response),
            onPattern: params.on_pattern,
            everyMs: params.every_ms,
            untilPattern: params.until_pattern,
            maxFires: params.max_fires,
            timeoutMs: params.timeout_ms,
          })
          const metadata: {
            serialID: string
            armed: boolean
            triggerID?: string
            mode?: string
          } = { serialID: id, armed: !!triggerId }
          if (!triggerId) {
            return { title: "not found", metadata, output: `No active session ${id}.` }
          }
          const mode = params.every_ms ? `every ${params.every_ms}ms` : `on /${params.on_pattern}/`
          metadata.triggerID = triggerId
          metadata.mode = params.every_ms ? "periodic" : "reactive"
          return {
            title: `armed ${triggerId} (${mode})`,
            metadata,
            output: `armed ${triggerId} on ${id}: ${mode}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_disarm ──────────────────────────────────────────────────────────
// Manually clear a trigger. Triggers also auto-disarm via `until_pattern`,
// `max_fires`, or `timeout_ms`, so this is mostly for the "agent changed
// its mind / scenario aborted" path.

const SerialDisarmParameters = z.object({
  serial_id: z.string(),
  trigger_id: z.string().describe("ID returned by serial_arm."),
})

export const SerialDisarmTool = Tool.define(
  "serial_disarm",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "Clear a trigger previously armed via serial_arm. No-op (returns `disarmed: false`) if the trigger has already auto-disarmed.",
      parameters: SerialDisarmParameters,
      execute: (params: z.infer<typeof SerialDisarmParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const id = SerialID.zod.parse(params.serial_id)
          const ok = yield* serial.disarm(id, params.trigger_id)
          return {
            title: ok ? "disarmed" : "not found",
            metadata: { serialID: id, triggerID: params.trigger_id, disarmed: ok },
            output: ok ? `disarmed ${params.trigger_id}` : `trigger ${params.trigger_id} not found (already disarmed?)`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── serial_close ───────────────────────────────────────────────────────────
// Close a session. UI subscribers are disconnected as well.

const SerialCloseParameters = z.object({
  serial_id: z.string(),
})

export const SerialCloseTool = Tool.define(
  "serial_close",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description: "Close a serial session. Disconnects any UI clients attached to the same SerialID.",
      parameters: SerialCloseParameters,
      execute: (params: z.infer<typeof SerialCloseParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const id = SerialID.zod.parse(params.serial_id)
          yield* serial.remove(id)
          return {
            title: "closed",
            metadata: { serialID: id, closed: true },
            output: `closed ${id}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
