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
  data: z.string().describe("Payload to send. Escape sequences such as \\n are interpreted."),
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
          const interpreted = params.data.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t")
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
// Snapshot the ring buffer so the agent can observe output without a WebSocket.

const SerialReadRecentParameters = z.object({
  serial_id: z.string(),
  tail_bytes: z.number().int().positive().optional().default(4096),
})

export const SerialReadRecentTool = Tool.define(
  "serial_read_recent",
  Effect.gen(function* () {
    const serial = yield* Serial.Service
    return {
      description:
        "Read the most recent buffered output of a serial session. Use tail_bytes to get only the last N bytes (default 4096).",
      parameters: SerialReadRecentParameters,
      execute: (params: z.infer<typeof SerialReadRecentParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const id = SerialID.zod.parse(params.serial_id)
          const snap = yield* serial.snapshot(id, params.tail_bytes)
          const metadata: {
            serialID: string
            found: boolean
            cursor?: number
            bufferCursor?: number
            bytes?: number
          } = snap
            ? { serialID: id, found: true, cursor: snap.cursor, bufferCursor: snap.bufferCursor, bytes: snap.data.length }
            : { serialID: id, found: false }
          return {
            title: snap ? `${snap.data.length}B @ ${snap.cursor}` : "not found",
            metadata,
            output: snap ? snap.data : `No active session ${id}.`,
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
