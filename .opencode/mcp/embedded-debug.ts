import net from "node:net"
import path from "node:path"
import { existsSync } from "node:fs"
import { mkdir, unlink } from "node:fs/promises"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import z from "zod"
import { text } from "./lib/embedded"

const server = new McpServer({
  name: "embedded_debug",
  version: "0.1.0",
})

const lockFile =
  process.env.SERIAL_LOCK_FILE ?? path.join(process.cwd(), ".opencode/embedded/runtime/serial-write-lock.json")

server.tool("debug_status", "Read serial debug tcp settings and writer lock", {}, async () => {
  const lock = await readLock()
  return text({
    host: process.env.SER2NET_HOST ?? "127.0.0.1",
    rw_port: Number(process.env.SER2NET_RW_PORT ?? "3333"),
    mon_port: Number(process.env.SER2NET_MON_PORT ?? "3334"),
    lock_file: lockFile,
    writer_lock: lock,
  })
})

server.tool(
  "debug_claim_writer",
  "Acquire single-writer lock for serial tcp",
  {
    owner: z.string(),
    ttl_sec: z.number().int().min(10).max(7200).default(900),
  },
  async (args) => {
    const lock = await readLock()
    if (lock && lock.owner !== args.owner) {
      return text({
        ok: false,
        reason: "writer lock already held",
        current_owner: lock.owner,
        expires_at: lock.expires_at,
      })
    }

    const next = {
      owner: args.owner,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + args.ttl_sec * 1000).toISOString(),
    }
    await mkdir(path.dirname(lockFile), { recursive: true })
    await Bun.write(lockFile, `${JSON.stringify(next, null, 2)}\n`)
    return text({ ok: true, lock: next })
  },
)

server.tool(
  "debug_release_writer",
  "Release writer lock",
  {
    owner: z.string(),
  },
  async (args) => {
    const lock = await readLock()
    if (!lock) return text({ ok: true, released: false })
    if (lock.owner !== args.owner) {
      return text({
        ok: false,
        reason: "owner mismatch",
        current_owner: lock.owner,
      })
    }
    if (existsSync(lockFile)) await unlink(lockFile)
    return text({ ok: true, released: true })
  },
)

server.tool(
  "debug_write",
  "Write serial command to ser2net rw tcp endpoint",
  {
    owner: z.string(),
    data: z.string(),
    append_newline: z.boolean().default(true),
  },
  async (args) => {
    const lock = await readLock()
    if (!lock || lock.owner !== args.owner) {
      return text({
        ok: false,
        reason: "writer lock required",
        hint: "call debug_claim_writer first",
      })
    }

    const host = process.env.SER2NET_HOST ?? "127.0.0.1"
    const port = Number(process.env.SER2NET_RW_PORT ?? "3333")
    const payload = args.append_newline ? `${args.data}\n` : args.data
    const out = await writeTcp(host, port, payload)
    return text({
      owner: args.owner,
      host,
      port,
      ...out,
    })
  },
)

server.tool(
  "debug_monitor",
  "Read serial monitor stream from ser2net tcp endpoint",
  {
    mode: z.enum(["rw", "monitor"]).default("monitor"),
    bytes: z.number().int().min(1).max(32768).default(4096),
    timeout_ms: z.number().int().min(100).max(60000).default(2000),
  },
  async (args) => {
    const host = process.env.SER2NET_HOST ?? "127.0.0.1"
    const rw = Number(process.env.SER2NET_RW_PORT ?? "3333")
    const mon = Number(process.env.SER2NET_MON_PORT ?? "3334")
    const port = args.mode === "rw" ? rw : mon
    const out = await readTcp(host, port, args.bytes, args.timeout_ms)
    return text({
      host,
      port,
      mode: args.mode,
      ...out,
    })
  },
)

async function readLock() {
  if (!existsSync(lockFile)) return undefined
  const lock = await Bun.file(lockFile).json()
  const expired = Date.parse(lock.expires_at) <= Date.now()
  if (!expired) return lock
  if (existsSync(lockFile)) await unlink(lockFile)
  return undefined
}

async function writeTcp(host: string, port: number, data: string) {
  return await new Promise<{ ok: boolean; bytes: number; error?: string }>((resolve) => {
    let done = false
    const finish = (value: { ok: boolean; bytes: number; error?: string }) => {
      if (done) return
      done = true
      resolve(value)
    }
    const socket = net.createConnection({ host, port }, () => {
      socket.write(data)
      socket.end()
      finish({ ok: true, bytes: Buffer.byteLength(data) })
    })
    socket.on("error", (error) => {
      finish({ ok: false, bytes: 0, error: String(error) })
    })
  })
}

async function readTcp(host: string, port: number, limit: number, timeoutMs: number) {
  return await new Promise<{ ok: boolean; data: string; bytes: number; error?: string }>((resolve) => {
    let done = false
    const finish = (value: { ok: boolean; data: string; bytes: number; error?: string }) => {
      if (done) return
      done = true
      resolve(value)
    }
    const chunks: Buffer[] = []
    let size = 0
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      finish({
        ok: true,
        data: Buffer.concat(chunks).toString("utf8"),
        bytes: size,
      })
    }, timeoutMs)

    socket.on("data", (chunk: Buffer) => {
      if (size >= limit) return
      const next = chunk.slice(0, limit - size)
      chunks.push(next)
      size += next.length
      if (size < limit) return
      clearTimeout(timer)
      socket.destroy()
      finish({
        ok: true,
        data: Buffer.concat(chunks).toString("utf8"),
        bytes: size,
      })
    })

    socket.on("error", (error) => {
      clearTimeout(timer)
      finish({ ok: false, data: "", bytes: size, error: String(error) })
    })

    socket.on("close", () => {
      clearTimeout(timer)
      if (!size) return
      finish({
        ok: true,
        data: Buffer.concat(chunks).toString("utf8"),
        bytes: size,
      })
    })
  })
}

await server.connect(new StdioServerTransport())
