import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Instance } from "@/project/instance"
import type { SerialPort } from "#serial"
import z from "zod"
import { Log } from "../util/log"
import { lazy } from "@opencode-ai/util/lazy"
import { SerialID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EffectLogger } from "@/effect/logger"

export namespace Serial {
  const log = Log.create({ service: "serial" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024
  const encoder = new TextEncoder()

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
    readonly snapshot: (
      id: SerialID,
      tailBytes?: number,
    ) => Effect.Effect<{ data: string; cursor: number; bufferCursor: number } | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Serial") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service

      function teardown(session: Active) {
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
            if (session.buffer.length <= BUFFER_LIMIT) return
            const excess = session.buffer.length - BUFFER_LIMIT
            session.buffer = session.buffer.slice(excess)
            session.bufferCursor += excess

            Effect.runFork(
              bus.publish(Event.Data, { id: session.info.id, data: chunk }).pipe(Effect.provide(EffectLogger.layer)),
            )
          }),
        )

        port.onExit(
          Instance.bind(({ exitCode }) => {
            if (session.info.status === "disconnected") return
            log.info("session disconnected", { id, exitCode })
            session.info.status = "disconnected"
            Effect.runFork(
              bus.publish(Event.Disconnected, { id: session.info.id }).pipe(Effect.provide(EffectLogger.layer)),
            )
            Effect.runFork(remove(id).pipe(Effect.provide(EffectLogger.layer)))
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

      const snapshot = Effect.fn("Serial.snapshot")(function* (id: SerialID, tailBytes?: number) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return undefined
        const data =
          typeof tailBytes === "number" && tailBytes > 0 && tailBytes < session.buffer.length
            ? session.buffer.slice(session.buffer.length - tailBytes)
            : session.buffer
        return { data, cursor: session.cursor, bufferCursor: session.bufferCursor }
      })

      return Service.of({ list, get, create, update, remove, connect, listPorts, write, snapshot })
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

  export async function snapshot(id: SerialID, tailBytes?: number) {
    return runPromise((svc) => svc.snapshot(id, tailBytes))
  }
}
