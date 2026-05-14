import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState, EffectBridge } from "@/effect"
import { makeRuntime } from "@/effect/run-service"
import { Instance } from "@/project/instance"
import type { SerialPort } from "#serial"
import z from "zod"
import { randomBytes } from "crypto"
import { Log } from "../util"
import { lazy } from "@opencode-ai/shared/util/lazy"
import { SerialID } from "./schema"
import { Effect, Layer, Context } from "effect"

export namespace Serial {
  const log = Log.create({ service: "serial" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024
  // Lookback window used by the trigger / waiter scanner so patterns split
  // across `port.onData` chunk boundaries (e.g. uboot's "=> ") still match.
  const SCAN_LOOKBACK = 1024
  const encoder = new TextEncoder()

  // ── Triggers (server-side reactive automation) ────────────────────────────
  // Registered via `arm()`; evaluated inside the existing `port.onData` path
  // so reaction latency is bounded by event-loop scheduling (sub-millisecond),
  // not by LLM tool-call cadence. Used to: (1) auto-respond to a regex match
  // (`onPattern`); (2) periodically write a payload until a stop condition is
  // met (`every_ms` + `untilPattern` — e.g. spam "slp\r\n" until u-boot
  // prompt appears, then disarm). The trigger is fully internal; the agent
  // sees only opaque trigger IDs.
  type Trigger = {
    id: string
    response: string
    onPattern?: RegExp
    untilPattern?: RegExp
    every?: { ms: number; timer: ReturnType<typeof setInterval> }
    maxFires?: number
    fires: number
    armedAt: number
    lastFireAt?: number
  }

  // ── Waiters (one-shot pattern blocking) ───────────────────────────────────
  // `wait()` registers a Waiter and resolves on next data chunk that matches,
  // or on timeout. Used by `serial_wait` to let an agent block on a prompt
  // without polling `serial_read_recent` and burning tokens on the boot log.
  type Waiter = {
    pattern: RegExp
    contextLines: number
    resolve: (result: WaitResult) => void
    timer: ReturnType<typeof setTimeout>
  }

  export type WaitResult =
    | {
        matched: true
        cursor: number
        match: string
        before: string
        after: string
      }
    | {
        matched: false
        cursor: number
        timed_out: true
      }

  function decodeEscapes(input: string): string {
    return input
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\0/g, "\0")
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  }

  type Socket = {
    readyState: number
    data?: unknown
    send: (data: string | Uint8Array | ArrayBuffer) => void
    close: (code?: number, reason?: string) => void
  }

  const sock = (ws: Socket) => (ws.data && typeof ws.data === "object" ? ws.data : ws)

  type Active = {
    info: Info
    port: SerialPort
    buffer: string
    bufferCursor: number
    cursor: number
    subscribers: Map<unknown, Socket>
    triggers: Map<string, Trigger>
    waiters: Set<Waiter>
    // High-water mark of `cursor` for which trigger pattern scanning has
    // already run. Prevents re-firing on stale buffer content when a new
    // chunk arrives but the matching prefix was already evaluated.
    scanCursor: number
  }

  type State = {
    dir: string
    sessions: Map<SerialID, Active>
  }

  // WebSocket control frame: 0x00 + UTF-8 JSON.
  const meta = (cursor: number) => {
    const json = JSON.stringify({ cursor })
    const bytes = encoder.encode(json)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = 0
    out.set(bytes, 1)
    return out
  }

  const serial = lazy(() => import("#serial"))

  export const Info = z
    .object({
      id: SerialID.zod,
      title: z.string(),
      path: z.string(),
      baudRate: z.number(),
      dataBits: z.number().optional(),
      stopBits: z.number().optional(),
      parity: z.enum(["none", "even", "odd", "mark", "space"]).optional(),
      status: z.enum(["connected", "disconnected", "error"]),
    })
    .meta({ ref: "Serial" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    path: z.string(),
    baudRate: z.number().default(115200),
    title: z.string().optional(),
    dataBits: z.number().optional(),
    stopBits: z.number().optional(),
    parity: z.enum(["none", "even", "odd", "mark", "space"]).optional(),
    flowControl: z.boolean().optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: BusEvent.define("serial.created", z.object({ info: Info })),
    Updated: BusEvent.define("serial.updated", z.object({ info: Info })),
    Data: BusEvent.define("serial.data", z.object({ id: SerialID.zod, data: z.string() })),
    Disconnected: BusEvent.define("serial.disconnected", z.object({ id: SerialID.zod })),
    Deleted: BusEvent.define("serial.deleted", z.object({ id: SerialID.zod })),
  }

  export type SnapshotOptions = {
    tailBytes?: number
    sinceCursor?: number
    maxBytes?: number
  }

  export type SnapshotResult = {
    data: string
    cursor: number
    bufferCursor: number
    /**
     * Byte position the returned `data` slice starts at. For incremental
     * reads (`sinceCursor`) this equals max(sinceCursor, bufferCursor) —
     * if the requested cursor preceded `bufferCursor`, some data was
     * discarded by the ring buffer and `dropped` reflects how much.
     */
    fromCursor: number
    /** Bytes that were requested but discarded by the ring buffer eviction. */
    dropped: number
  }

  export type ArmInput = {
    response: string
    onPattern?: string
    everyMs?: number
    untilPattern?: string
    maxFires?: number
    timeoutMs?: number
  }

  export type GrepResult = {
    matches: Array<{ line: string; cursor: number }>
    scannedFrom: number
    scannedTo: number
    truncated: boolean
  }

  export interface Interface {
    readonly list: () => Effect.Effect<Info[]>
    readonly get: (id: SerialID) => Effect.Effect<Info | undefined>
    readonly create: (input: CreateInput) => Effect.Effect<Info>
    readonly update: (id: SerialID, input: UpdateInput) => Effect.Effect<Info | undefined>
    readonly remove: (id: SerialID) => Effect.Effect<void>
    readonly connect: (
      id: SerialID,
      ws: Socket,
      cursor?: number,
    ) => Effect.Effect<{ onMessage: (message: string | ArrayBuffer) => void; onClose: () => void } | undefined>
    readonly listPorts: () => Effect.Effect<
      Array<{
        path: string
        manufacturer?: string
        serialNumber?: string
        pnpId?: string
        vendorId?: string
        productId?: string
      }>
    >
    readonly write: (id: SerialID, data: string) => Effect.Effect<void>
    readonly snapshot: (id: SerialID, options?: SnapshotOptions) => Effect.Effect<SnapshotResult | undefined>
    readonly grep: (
      id: SerialID,
      options: { pattern: string; sinceCursor?: number; tailBytes?: number; maxMatches?: number },
    ) => Effect.Effect<GrepResult | undefined>
    readonly wait: (
      id: SerialID,
      options: { pattern: string; timeoutMs: number; contextLines?: number },
    ) => Effect.Effect<WaitResult | undefined>
    readonly arm: (id: SerialID, input: ArmInput) => Effect.Effect<string | undefined>
    readonly disarm: (id: SerialID, triggerId: string) => Effect.Effect<boolean>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Serial") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const bridge = yield* EffectBridge.make()

      function teardown(session: Active) {
        // Clear timer-driven triggers first so no port.write fires during/after
        // close. (Pattern-driven triggers don't have timers; clearing the
        // map below disables them.)
        for (const t of session.triggers.values()) {
          if (t.every) clearInterval(t.every.timer)
        }
        session.triggers.clear()
        // Reject pending waiters so any pending `Effect.promise` callers
        // don't hang past session close.
        for (const w of session.waiters) {
          clearTimeout(w.timer)
          try {
            w.resolve({ matched: false, cursor: session.cursor, timed_out: true })
          } catch {}
        }
        session.waiters.clear()
        try {
          session.port.close()
        } catch {}
        for (const [sub, ws] of session.subscribers.entries()) {
          try {
            if (sock(ws) === sub) ws.close()
          } catch {}
        }
        session.subscribers.clear()
      }

      // ── Internal trigger/waiter helpers ───────────────────────────────────
      function fireTrigger(active: Active, t: Trigger) {
        try {
          active.port.write(t.response)
          t.fires += 1
          t.lastFireAt = Date.now()
        } catch {
          // Port already closed/errored — disarm so we stop trying.
          disarmInternal(active, t.id)
          return
        }
        if (typeof t.maxFires === "number" && t.fires >= t.maxFires) {
          disarmInternal(active, t.id)
        }
      }

      function disarmInternal(active: Active, triggerId: string): boolean {
        const t = active.triggers.get(triggerId)
        if (!t) return false
        if (t.every) clearInterval(t.every.timer)
        active.triggers.delete(triggerId)
        return true
      }

      // Called after each `port.onData` chunk is appended to the ring buffer.
      // Walks the most recent SCAN_LOOKBACK bytes and fires any triggers /
      // waiters whose pattern is satisfied. Periodic triggers (`every_ms`)
      // do their own writes via setInterval; this scanner only checks their
      // `untilPattern` for stop-disarm. Pattern-driven triggers (`onPattern`)
      // fire from here.
      function evaluate(active: Active) {
        if (active.triggers.size === 0 && active.waiters.size === 0) return

        // Build the scan window. We want enough history to catch patterns
        // that straddle two chunks ("=>" + " " arriving as separate frames),
        // but not so much that we re-match content already evaluated on
        // earlier ticks (`scanCursor`). The window also can't extend past
        // what's still in the ring buffer (`bufferCursor`).
        const totalEnd = active.cursor
        const lookbackStart = Math.max(active.scanCursor - SCAN_LOOKBACK, active.bufferCursor)
        const offset = Math.max(0, lookbackStart - active.bufferCursor)
        const window = active.buffer.slice(offset)

        if (active.triggers.size > 0) {
          for (const t of [...active.triggers.values()]) {
            if (t.untilPattern) {
              t.untilPattern.lastIndex = 0
              if (t.untilPattern.test(window)) {
                disarmInternal(active, t.id)
                continue
              }
            }
            // Periodic triggers fire from setInterval, not the scanner.
            if (!t.every && t.onPattern) {
              t.onPattern.lastIndex = 0
              if (t.onPattern.test(window)) {
                fireTrigger(active, t)
              }
            }
          }
        }

        if (active.waiters.size > 0) {
          for (const w of [...active.waiters]) {
            w.pattern.lastIndex = 0
            const match = w.pattern.exec(window)
            if (!match) continue
            active.waiters.delete(w)
            clearTimeout(w.timer)
            const matchStart = match.index ?? 0
            const matchEnd = matchStart + match[0].length
            const beforeText = window.slice(0, matchStart)
            const afterText = window.slice(matchEnd)
            const beforeLines = beforeText.split(/\r?\n/)
            const afterLines = afterText.split(/\r?\n/)
            try {
              w.resolve({
                matched: true,
                cursor: totalEnd,
                match: match[0],
                before: beforeLines.slice(-(w.contextLines + 1)).join("\n"),
                after: afterLines.slice(0, w.contextLines + 1).join("\n"),
              })
            } catch {}
          }
        }

        active.scanCursor = totalEnd
      }

      const state = yield* InstanceState.make<State>(
        Effect.fn("Serial.state")(function* (ctx) {
          const state = {
            dir: ctx.directory,
            sessions: new Map<SerialID, Active>(),
          }

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const session of state.sessions.values()) {
                teardown(session)
              }
              state.sessions.clear()
            }),
          )

          return state
        }),
      )

      const remove = Effect.fn("Serial.remove")(function* (id: SerialID) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return
        s.sessions.delete(id)
        log.info("removing session", { id })
        teardown(session)
        yield* bus.publish(Event.Deleted, { id: session.info.id })
      })

      const list = Effect.fn("Serial.list")(function* () {
        const s = yield* InstanceState.get(state)
        return Array.from(s.sessions.values()).map((session) => session.info)
      })

      const get = Effect.fn("Serial.get")(function* (id: SerialID) {
        const s = yield* InstanceState.get(state)
        return s.sessions.get(id)?.info
      })

      const create = Effect.fn("Serial.create")(function* (input: CreateInput) {
        const s = yield* InstanceState.get(state)

        // Port-level multiplex: the OS only allows one process to hold
        // /dev/ttyS2 (or any device path) at a time. If a session is
        // already open on this path with matching transport params, we
        // hand the caller the existing SerialID instead of failing on a
        // duplicate open(). This lets the Serial Monitor UI and the
        // debug-node tool coexist without one EBUSY-ing the other —
        // each subscriber attaches via WebSocket to the same session.
        for (const existing of s.sessions.values()) {
          const e = existing.info
          if (
            e.path === input.path &&
            e.baudRate === input.baudRate &&
            (input.dataBits === undefined || e.dataBits === input.dataBits) &&
            (input.stopBits === undefined || e.stopBits === input.stopBits) &&
            (input.parity === undefined || e.parity === input.parity)
          ) {
            log.info("Serial.create reusing existing session for same path/params", {
              id: e.id,
              path: e.path,
            })
            return e
          }
        }
        const id = SerialID.ascending()

        const { open } = yield* Effect.promise(() => serial())
        const port = yield* Effect.sync(() =>
          open(input.path, {
            baudRate: input.baudRate,
            dataBits: input.dataBits,
            stopBits: input.stopBits,
            parity: input.parity,
            flowControl: input.flowControl,
          }),
        )

        const info = {
          id,
          title: input.title || `Serial ${id.slice(-4)}`,
          path: input.path,
          baudRate: input.baudRate,
          dataBits: input.dataBits,
          stopBits: input.stopBits,
          parity: input.parity,
          status: "connected" as const,
        }
        const session: Active = {
          info,
          port,
          buffer: "",
          bufferCursor: 0,
          cursor: 0,
          subscribers: new Map(),
          triggers: new Map(),
          waiters: new Set(),
          scanCursor: 0,
        }
        s.sessions.set(id, session)

        port.onData(
          Instance.bind((chunk) => {
            session.cursor += chunk.length

            for (const [key, ws] of session.subscribers.entries()) {
              if (ws.readyState !== 1) {
                session.subscribers.delete(key)
                continue
              }
              if (sock(ws) !== key) {
                session.subscribers.delete(key)
                continue
              }
              try {
                ws.send(chunk)
              } catch {
                session.subscribers.delete(key)
              }
            }

            session.buffer += chunk
            if (session.buffer.length > BUFFER_LIMIT) {
              const excess = session.buffer.length - BUFFER_LIMIT
              session.buffer = session.buffer.slice(excess)
              session.bufferCursor += excess

              bridge.fork(bus.publish(Event.Data, { id: session.info.id, data: chunk }))
            }

            // Evaluate triggers + waiters AFTER buffer & subscribers are
            // updated. This is the realtime reaction path: a pattern match
            // here triggers `port.write` within the same tick, no LLM in
            // the loop. Total latency per chunk is dominated by the regex
            // .test/.exec calls (microseconds) — negligible at typical
            // serial throughput (≤ 1 Mbps).
            evaluate(session)
          }),
        )

        port.onExit(
          Instance.bind(({ exitCode }) => {
            if (session.info.status === "disconnected") return
            log.info("session disconnected", { id, exitCode })
            session.info.status = "disconnected"
            bridge.fork(bus.publish(Event.Disconnected, { id: session.info.id }))
            bridge.fork(remove(id))
          }),
        )

        yield* bus.publish(Event.Created, { info })
        return info
      })

      const update = Effect.fn("Serial.update")(function* (id: SerialID, input: UpdateInput) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return
        if (input.title) {
          session.info.title = input.title
        }
        yield* bus.publish(Event.Updated, { info: session.info })
        return session.info
      })

      const write = Effect.fn("Serial.write")(function* (id: SerialID, data: string) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (session && session.info.status === "connected") {
          session.port.write(data)
        }
      })

      const connect = Effect.fn("Serial.connect")(function* (id: SerialID, ws: Socket, cursor?: number) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) {
          ws.close()
          return
        }
        log.info("client connected to session", { id })

        const sub = sock(ws)
        session.subscribers.delete(sub)
        session.subscribers.set(sub, ws)

        const cleanup = () => {
          session.subscribers.delete(sub)
        }

        const start = session.bufferCursor
        const end = session.cursor
        const from =
          cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

        const data = (() => {
          if (!session.buffer) return ""
          if (from >= end) return ""
          const offset = Math.max(0, from - start)
          if (offset >= session.buffer.length) return ""
          return session.buffer.slice(offset)
        })()

        if (data) {
          try {
            for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
              ws.send(data.slice(i, i + BUFFER_CHUNK))
            }
          } catch {
            cleanup()
            ws.close()
            return
          }
        }

        try {
          ws.send(meta(end))
        } catch {
          cleanup()
          ws.close()
          return
        }

        return {
          onMessage: (message: string | ArrayBuffer) => {
            session.port.write(String(message))
          },
          onClose: () => {
            log.info("client disconnected from session", { id })
            cleanup()
          },
        }
      })

      const listPorts = Effect.fn("Serial.listPorts")(function* () {
        const { listPorts } = yield* Effect.promise(() => serial())
        return yield* Effect.promise(() => listPorts())
      })

      const snapshot = Effect.fn("Serial.snapshot")(function* (id: SerialID, options?: SnapshotOptions) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return undefined

        const totalEnd = session.cursor
        const totalStart = session.bufferCursor
        const buffer = session.buffer

        // Resolve which window of bytes to return.
        //   sinceCursor wins if both are provided. If sinceCursor predates
        //   bufferCursor we report the gap as `dropped` (caller may want to
        //   warn the agent that ring-buffer eviction caused data loss).
        let sliceOffset: number
        let fromCursor: number
        let dropped = 0
        if (typeof options?.sinceCursor === "number") {
          fromCursor = Math.max(options.sinceCursor, totalStart)
          dropped = Math.max(0, totalStart - options.sinceCursor)
          sliceOffset = fromCursor - totalStart
        } else if (typeof options?.tailBytes === "number" && options.tailBytes > 0) {
          if (options.tailBytes < buffer.length) {
            sliceOffset = buffer.length - options.tailBytes
            fromCursor = totalStart + sliceOffset
          } else {
            sliceOffset = 0
            fromCursor = totalStart
          }
        } else {
          sliceOffset = 0
          fromCursor = totalStart
        }

        let data = sliceOffset >= 0 && sliceOffset < buffer.length ? buffer.slice(sliceOffset) : ""
        if (typeof options?.maxBytes === "number" && options.maxBytes > 0 && data.length > options.maxBytes) {
          // Cap from the end so the most recent bytes are kept (typical
          // debug intent: "show me the latest tail of the increment").
          data = data.slice(data.length - options.maxBytes)
          fromCursor = totalEnd - data.length
        }

        const result: SnapshotResult = {
          data,
          cursor: totalEnd,
          bufferCursor: totalStart,
          fromCursor,
          dropped,
        }
        return result
      })

      const grep = Effect.fn("Serial.grep")(function* (
        id: SerialID,
        options: { pattern: string; sinceCursor?: number; tailBytes?: number; maxMatches?: number },
      ) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return undefined

        const re = new RegExp(options.pattern)
        const totalEnd = session.cursor
        const totalStart = session.bufferCursor
        const buffer = session.buffer
        const maxMatches = options.maxMatches ?? 50

        let sliceOffset: number
        let fromCursor: number
        if (typeof options.sinceCursor === "number") {
          fromCursor = Math.max(options.sinceCursor, totalStart)
          sliceOffset = fromCursor - totalStart
        } else if (typeof options.tailBytes === "number" && options.tailBytes > 0) {
          if (options.tailBytes < buffer.length) {
            sliceOffset = buffer.length - options.tailBytes
          } else {
            sliceOffset = 0
          }
          fromCursor = totalStart + sliceOffset
        } else {
          sliceOffset = 0
          fromCursor = totalStart
        }

        const slice = sliceOffset >= 0 && sliceOffset < buffer.length ? buffer.slice(sliceOffset) : ""
        const matches: Array<{ line: string; cursor: number }> = []
        let cursorAt = fromCursor
        // Split on \n keeping the original line content; we do +1 for
        // the consumed newline to advance the cursor. \r\n is benign:
        // we leave the trailing \r in the line text, which typically
        // matters little for grep semantics.
        const lines = slice.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? ""
          re.lastIndex = 0
          if (re.test(line)) {
            matches.push({ line, cursor: cursorAt })
            if (matches.length >= maxMatches) break
          }
          cursorAt += line.length + (i < lines.length - 1 ? 1 : 0)
        }

        const result: GrepResult = {
          matches,
          scannedFrom: fromCursor,
          scannedTo: totalEnd,
          truncated: matches.length >= maxMatches,
        }
        return result
      })

      const wait = Effect.fn("Serial.wait")(function* (
        id: SerialID,
        options: { pattern: string; timeoutMs: number; contextLines?: number },
      ) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return undefined

        const re = new RegExp(options.pattern, "m")
        const contextLines = options.contextLines ?? 3

        // Fast path: pattern is already in the buffer (e.g. agent calls
        // wait() *after* the boot is already complete). No need to block.
        re.lastIndex = 0
        const existingMatch = re.exec(session.buffer)
        if (existingMatch) {
          const matchStart = existingMatch.index ?? 0
          const matchEnd = matchStart + existingMatch[0].length
          const beforeText = session.buffer.slice(0, matchStart)
          const afterText = session.buffer.slice(matchEnd)
          const result: WaitResult = {
            matched: true,
            cursor: session.cursor,
            match: existingMatch[0],
            before: beforeText.split(/\r?\n/).slice(-(contextLines + 1)).join("\n"),
            after: afterText.split(/\r?\n/).slice(0, contextLines + 1).join("\n"),
          }
          return result
        }

        // Slow path: register a one-shot Waiter; the `evaluate()` step on the
        // next chunk will resolve us, or the timer fires first.
        return yield* Effect.promise(
          () =>
            new Promise<WaitResult>((resolve) => {
              const waiter: Waiter = {
                pattern: re,
                contextLines,
                resolve: (r) => {
                  clearTimeout(waiter.timer)
                  session.waiters.delete(waiter)
                  resolve(r)
                },
                timer: setTimeout(() => {
                  session.waiters.delete(waiter)
                  resolve({ matched: false, cursor: session.cursor, timed_out: true })
                }, options.timeoutMs),
              }
              session.waiters.add(waiter)
            }),
        )
      })

      const arm = Effect.fn("Serial.arm")(function* (id: SerialID, input: ArmInput) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return undefined

        const triggerId = "trg_" + randomBytes(6).toString("hex")
        const trigger: Trigger = {
          id: triggerId,
          response: input.response,
          onPattern: input.onPattern ? new RegExp(input.onPattern) : undefined,
          untilPattern: input.untilPattern ? new RegExp(input.untilPattern) : undefined,
          maxFires: input.maxFires,
          fires: 0,
          armedAt: Date.now(),
        }

        if (typeof input.everyMs === "number" && input.everyMs > 0) {
          trigger.every = {
            ms: input.everyMs,
            timer: setInterval(() => fireTrigger(session, trigger), input.everyMs),
          }
        }
        if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
          // The same Active map serves as the disarm registry, so the
          // timeout just calls disarmInternal — race with manual disarm
          // is a no-op (`get` returns undefined).
          setTimeout(() => disarmInternal(session, triggerId), input.timeoutMs).unref?.()
        }

        session.triggers.set(triggerId, trigger)
        return triggerId
      })

      const disarm = Effect.fn("Serial.disarm")(function* (id: SerialID, triggerId: string) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return false
        return disarmInternal(session, triggerId)
      })

      return Service.of({
        list,
        get,
        create,
        update,
        remove,
        connect,
        listPorts,
        write,
        snapshot,
        grep,
        wait,
        arm,
        disarm,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function get(id: SerialID) {
    return runPromise((svc) => svc.get(id))
  }

  export async function create(input: CreateInput) {
    return runPromise((svc) => svc.create(input))
  }

  export async function update(id: SerialID, input: UpdateInput) {
    return runPromise((svc) => svc.update(id, input))
  }

  export async function remove(id: SerialID) {
    return runPromise((svc) => svc.remove(id))
  }

  export async function connect(id: SerialID, ws: Socket, cursor?: number) {
    return runPromise((svc) => svc.connect(id, ws, cursor))
  }

  export async function listPorts() {
    return runPromise((svc) => svc.listPorts())
  }

  export async function write(id: SerialID, data: string) {
    return runPromise((svc) => svc.write(id, data))
  }

  export async function snapshot(id: SerialID, options?: SnapshotOptions) {
    return runPromise((svc) => svc.snapshot(id, options))
  }

  export async function grep(
    id: SerialID,
    options: { pattern: string; sinceCursor?: number; tailBytes?: number; maxMatches?: number },
  ) {
    return runPromise((svc) => svc.grep(id, options))
  }

  export async function wait(
    id: SerialID,
    options: { pattern: string; timeoutMs: number; contextLines?: number },
  ) {
    return runPromise((svc) => svc.wait(id, options))
  }

  export async function arm(id: SerialID, input: ArmInput) {
    return runPromise((svc) => svc.arm(id, input))
  }

  export async function disarm(id: SerialID, triggerId: string) {
    return runPromise((svc) => svc.disarm(id, triggerId))
  }

  // Re-exported so callers can decode escape sequences (\\r \\n \\t \\xNN
  // \\u####) the same way the tool layer does. Used by `serial_arm` and
  // `serial_write` to translate human-typed escapes into raw bytes before
  // they hit the port.
  export const decode = decodeEscapes
}
