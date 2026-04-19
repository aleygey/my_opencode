import { Tool } from "./tool"
import z from "zod"
import { Serial } from "@/serial"
import { SerialID } from "@/serial/schema"

const format = (value: unknown) => JSON.stringify(value, null, 2)

// ── serial_list_ports ──────────────────────────────────────────────────────
// Discover physical serial devices attached to the host.

export const SerialListPortsTool = Tool.define("serial_list_ports", {
  description:
    "List physical serial devices attached to the host (path, manufacturer, vendorId, productId). Call this first to find a device before serial_create.",
  parameters: z.object({}),
  async execute(_input, _ctx) {
    const ports = await Serial.listPorts()
    return {
      title: `${ports.length} port(s)`,
      metadata: { count: ports.length, ports },
      output: format(ports),
    }
  },
})

// ── serial_list ────────────────────────────────────────────────────────────
// List open serial sessions (shared between agent and UI).

export const SerialListTool = Tool.define("serial_list", {
  description:
    "List currently open serial sessions. Each session is shared between the agent and any UI client attached to the same SerialID.",
  parameters: z.object({}),
  async execute(_input, _ctx) {
    const list = await Serial.list()
    return {
      title: `${list.length} session(s)`,
      metadata: { count: list.length, sessions: list },
      output: format(list),
    }
  },
})

// ── serial_create ──────────────────────────────────────────────────────────
// Open a new serial session.

export const SerialCreateTool = Tool.define("serial_create", {
  description:
    "Open a serial session on the given device path. Returns a SerialID. The session is visible to the UI so the user can monitor the same stream.",
  parameters: z.object({
    path: z.string().describe("Device path (e.g. /dev/ttyUSB0 or COM3)"),
    baudRate: z.number().int().positive().default(115200),
    title: z.string().optional().describe("Human-readable label shown in the UI"),
    dataBits: z.number().int().optional(),
    stopBits: z.number().int().optional(),
    parity: z.enum(["none", "even", "odd", "mark", "space"]).optional(),
    flowControl: z.boolean().optional(),
  }),
  async execute(input, _ctx) {
    const info = await Serial.create(input)
    return {
      title: info.title,
      metadata: { serialID: info.id, ...info },
      output: format(info),
    }
  },
})

// ── serial_write ───────────────────────────────────────────────────────────
// Send a command or raw bytes down a serial session.

export const SerialWriteTool = Tool.define("serial_write", {
  description:
    "Write data to an open serial session. Use a trailing \\r\\n if the target device expects a line terminator.",
  parameters: z.object({
    serial_id: z.string().describe("SerialID returned by serial_create"),
    data: z.string().describe("Payload to send. Escape sequences such as \\n are interpreted."),
  }),
  async execute(input, _ctx) {
    const id = SerialID.zod.parse(input.serial_id)
    const interpreted = input.data.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t")
    await Serial.write(id, interpreted)
    return {
      title: `write ${interpreted.length}B`,
      metadata: { serialID: id, bytes: interpreted.length },
      output: `wrote ${interpreted.length} bytes to ${id}`,
    }
  },
})

// ── serial_read_recent ─────────────────────────────────────────────────────
// Snapshot the ring buffer so the agent can observe output without a WebSocket.

export const SerialReadRecentTool = Tool.define("serial_read_recent", {
  description:
    "Read the most recent buffered output of a serial session. Use tail_bytes to get only the last N bytes (default 4096).",
  parameters: z.object({
    serial_id: z.string(),
    tail_bytes: z.number().int().positive().optional().default(4096),
  }),
  async execute(input, _ctx) {
    const id = SerialID.zod.parse(input.serial_id)
    const snap = await Serial.snapshot(id, input.tail_bytes)
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
  },
})

// ── serial_close ───────────────────────────────────────────────────────────
// Close a session. UI subscribers are disconnected as well.

export const SerialCloseTool = Tool.define("serial_close", {
  description: "Close a serial session. Disconnects any UI clients attached to the same SerialID.",
  parameters: z.object({
    serial_id: z.string(),
  }),
  async execute(input, _ctx) {
    const id = SerialID.zod.parse(input.serial_id)
    await Serial.remove(id)
    return {
      title: "closed",
      metadata: { serialID: id, closed: true },
      output: `closed ${id}`,
    }
  },
})
