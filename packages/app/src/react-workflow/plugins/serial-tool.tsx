/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Cpu,
  Activity,
  Terminal,
  Wifi,
  WifiOff,
  Send,
  RotateCcw,
  Settings,
  Trash2,
  ChevronUp,
  HelpCircle,
  X,
} from "lucide-react"
import type { ToolPlugin, PluginContext } from "./types"
import type { Detail } from "../app"
import { useWorkflowRuntime, type WorkflowRuntime } from "../runtime-context"

/** Single line in the scrollback. `rx` lines are split on `\n` so each
 *  device-emitted line shows with its own timestamp; `tx`/`info`/`error` are
 *  whatever the user / wiring writes. */
interface SerialLine {
  id: string
  type: "rx" | "tx" | "error" | "info"
  text: string
  time: string
}

/** Shape returned by `GET /serial/`. Mirrors `Serial.Info`. */
interface SerialSession {
  id: string
  title: string
  path: string
  baudRate: number
  status: "connected" | "disconnected" | "error"
}

/** Shape returned by `GET /serial/ports`. */
interface SerialPort {
  path: string
  manufacturer?: string
  serialNumber?: string
  vendorId?: string
  productId?: string
}

const COMMON_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400] as const

function formatTime(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`
}

let lineSeq = 0
const lineId = () => `${Date.now()}-${++lineSeq}`

/** Build a `fetch` wrapper that injects the basic-auth header if present and
 *  resolves paths relative to the live API base. Returns `null` when the
 *  runtime context isn't wired up — callers must guard against that. */
function makeApi(rt: WorkflowRuntime | null) {
  if (!rt) return null
  const headers: Record<string, string> = {}
  if (rt.authHeader) headers.Authorization = rt.authHeader
  return {
    base: rt.apiBase,
    authHeader: rt.authHeader,
    async json<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
      const finalHeaders: Record<string, string> = { ...headers }
      let body = init?.body
      if (init?.json !== undefined) {
        finalHeaders["Content-Type"] = "application/json"
        body = JSON.stringify(init.json)
      }
      const res = await fetch(new URL(path, rt.apiBase), {
        ...init,
        headers: { ...finalHeaders, ...(init?.headers as Record<string, string> | undefined) },
        body,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`)
      }
      const ct = res.headers.get("content-type") ?? ""
      return (ct.includes("application/json") ? await res.json() : (await res.text())) as T
    },
  }
}

/** Convert HTTP base (`http://host:port`) → WS base (`ws://host:port`). */
function toWsBase(httpBase: string): string {
  const url = new URL(httpBase)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString().replace(/\/$/, "")
}

function SerialTool({ nodeStatus, detail }: PluginContext<Detail | null>) {
  const runtime = useWorkflowRuntime()
  const api = useMemo(() => makeApi(runtime), [runtime])

  const [lines, setLines] = useState<SerialLine[]>([])
  const [input, setInput] = useState("")
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [baudRate, setBaudRate] = useState(115200)
  const [port, setPort] = useState("")
  const [availablePorts, setAvailablePorts] = useState<SerialPort[]>([])
  const [autoScroll] = useState(true)
  const [activeSession, setActiveSession] = useState<SerialSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const cursorRef = useRef<number>(0)

  const run = nodeStatus === "running"
  const connected = !!activeSession && activeSession.status === "connected" && wsRef.current?.readyState === WebSocket.OPEN

  const status: "connected" | "ready" | "idle" =
    connected ? "connected" : run ? "ready" : "idle"
  const statusLabel =
    status === "connected" && activeSession
      ? `${activeSession.path} · ${activeSession.baudRate} baud`
      : status === "ready"
        ? "Ready to connect"
        : "Disconnected"

  const pushLine = useCallback((type: SerialLine["type"], text: string, ts?: Date) => {
    if (!text) return
    if (type === "rx") {
      // Split incoming chunks on newline so each line gets a fresh timestamp.
      // `\r\n` and lone `\r` are both collapsed to `\n` first.
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      const parts = normalized.split("\n")
      const time = formatTime(ts)
      setLines((prev) => {
        const next = [...prev]
        for (let i = 0; i < parts.length; i++) {
          const seg = parts[i]
          // Avoid appending a trailing empty line when the chunk ends with \n.
          if (i === parts.length - 1 && seg === "") continue
          next.push({ id: lineId(), type, text: seg, time })
        }
        return next
      })
      return
    }
    setLines((prev) => [...prev, { id: lineId(), type, text, time: formatTime(ts) }])
  }, [])

  // Refresh the host port list whenever the settings drawer opens — cheap,
  // and saves the user from typing a path manually.
  useEffect(() => {
    if (!showSettings || !api) return
    let cancelled = false
    api
      .json<SerialPort[]>("/serial/ports")
      .then((ports) => {
        if (cancelled) return
        setAvailablePorts(ports)
        if (!port && ports[0]) setPort(ports[0].path)
      })
      .catch((err) => {
        if (cancelled) return
        setErrorMsg(`Port scan failed: ${(err as Error).message}`)
      })
    return () => {
      cancelled = true
    }
  }, [showSettings, api, port])

  // Auto-attach: if there's already an open session for this workspace, hook
  // onto it instead of forcing the user to click Connect again. This is what
  // makes the panel feel "live" when the debug agent has already opened a
  // session via `serial_create` from the model side.
  useEffect(() => {
    if (!api || activeSession) return
    let cancelled = false
    api
      .json<SerialSession[]>("/serial/")
      .then((sessions) => {
        if (cancelled || sessions.length === 0) return
        const live = sessions.find((s) => s.status === "connected") ?? sessions[0]
        if (live) attach(live, true)
      })
      .catch(() => {
        // 404 / network failure here is fine — it just means there's no
        // backend (or no sessions yet). Don't surface this as an error
        // because it's the steady state on first paint.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  // Drop the WS on unmount; do NOT call DELETE on the session — the agent
  // may still be using it. UI close is purely a per-tab subscription teardown.
  useEffect(() => {
    return () => {
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  const openSocket = useCallback(
    (session: SerialSession, fromCursor = -1) => {
      if (!runtime) return
      // Replace any existing socket — happens when the user connects to a
      // different session without disconnecting first.
      wsRef.current?.close()
      const wsBase = toWsBase(runtime.apiBase)
      // The opencode server gates websocket upgrades on the same Basic-auth
      // header as REST calls. Browsers don't let us set arbitrary headers on
      // `new WebSocket(...)`, but the same auth flows through if the cookie
      // is shared OR if the server is open. For password-protected dev
      // servers the wrapper already handled auth at the SDK login step;
      // we do a best-effort here and surface a clear message on failure.
      const ws = new WebSocket(`${wsBase}/serial/${session.id}/connect?cursor=${fromCursor}`)
      ws.binaryType = "arraybuffer"
      wsRef.current = ws

      ws.onopen = () => {
        pushLine("info", `Attached to ${session.path} @ ${session.baudRate} baud`)
      }
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          pushLine("rx", ev.data)
          return
        }
        // Binary frame — could be raw bytes that happened to be sent as
        // binary, or the meta control frame (first byte 0x00 + UTF-8 JSON).
        const arr = new Uint8Array(ev.data)
        if (arr.length === 0) return
        if (arr[0] === 0x00) {
          try {
            const json = JSON.parse(new TextDecoder().decode(arr.slice(1))) as { cursor?: number }
            if (typeof json.cursor === "number") cursorRef.current = json.cursor
          } catch {
            // ignore malformed control frame
          }
          return
        }
        try {
          pushLine("rx", new TextDecoder().decode(arr))
        } catch {
          /* noop */
        }
      }
      ws.onerror = () => {
        pushLine("error", "WebSocket error — see browser console")
      }
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null
        pushLine("info", "Stream closed")
      }
    },
    [pushLine, runtime],
  )

  const attach = useCallback(
    (session: SerialSession, silent = false) => {
      setActiveSession(session)
      cursorRef.current = 0
      if (!silent) pushLine("info", `Attaching to ${session.path}…`)
      openSocket(session)
    },
    [openSocket, pushLine],
  )

  const connect = useCallback(async () => {
    if (!api) {
      setErrorMsg("No backend connection available")
      return
    }
    if (!port) {
      setErrorMsg("Pick a port first (Settings)")
      setShowSettings(true)
      return
    }
    setBusy(true)
    setErrorMsg(null)
    try {
      const session = await api.json<SerialSession>("/serial/", {
        method: "POST",
        json: { path: port, baudRate, title: `${detail?.type ?? "device"} · ${port}` },
      })
      attach(session)
    } catch (err) {
      const msg = (err as Error).message
      setErrorMsg(`Connect failed: ${msg}`)
      pushLine("error", `Connect failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }, [api, attach, baudRate, detail?.type, port, pushLine])

  const disconnect = useCallback(async () => {
    if (!api || !activeSession) return
    setBusy(true)
    try {
      // DELETE closes the session on the host; the WS will close itself in
      // response. We don't optimistically clear `activeSession` because the
      // backend's `serial.deleted` event drops the WS and that's our cue.
      await api.json(`/serial/${activeSession.id}`, { method: "DELETE" }).catch(() => undefined)
      wsRef.current?.close()
      wsRef.current = null
      setActiveSession(null)
      pushLine("info", "Disconnected")
    } finally {
      setBusy(false)
    }
  }, [activeSession, api, pushLine])

  const sendCommand = useCallback(async () => {
    if (!api || !activeSession) return
    const text = input.trim()
    if (!text) return
    pushLine("tx", text)
    setInput("")
    try {
      // Append `\n` so the device sees a line terminator. Most embedded REPLs
      // expect this; if a workflow needs raw bytes, the agent uses
      // `serial_write` with explicit escapes.
      await api.json(`/serial/${activeSession.id}/write`, {
        method: "POST",
        json: { data: text + "\n" },
      })
    } catch (err) {
      pushLine("error", `Write failed: ${(err as Error).message}`)
    }
  }, [activeSession, api, input, pushLine])

  const reset = useCallback(async () => {
    // Soft reset = send Ctrl-C twice + Ctrl-D — the universal "drop me back
    // to the bootloader" sequence on micropython / nuttx / many u-boot
    // shells. For more specific reset semantics the agent should call
    // `serial_write` directly.
    if (!api || !activeSession) return
    pushLine("info", "Sending soft-reset (^C^C^D)…")
    try {
      await api.json(`/serial/${activeSession.id}/write`, {
        method: "POST",
        json: { data: "\x03\x03\x04" },
      })
    } catch (err) {
      pushLine("error", `Reset failed: ${(err as Error).message}`)
    }
  }, [activeSession, api, pushLine])

  const clear = () => setLines([])

  const isOffline = !runtime
  const portLabel = activeSession?.path ?? port

  return (
    <div className="wf-detail-code">
      <div className="wf-detail-panel-header">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
            <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[var(--wf-dim)]">
              Serial Monitor
            </span>
          </div>
          <div className="flex items-center gap-2">
            {status === "connected" ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--wf-ok-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--wf-ok)]"
                title={statusLabel}
              >
                <Wifi className="h-3 w-3" strokeWidth={2} />
                <span>Connected</span>
                <span className="font-mono text-[9px] opacity-70">· {statusLabel}</span>
              </span>
            ) : status === "ready" ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--wf-warn-soft,var(--wf-chip))] px-2 py-0.5 text-[10px] font-semibold text-[var(--wf-warn,var(--wf-dim))]"
                title={statusLabel}
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                {statusLabel}
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--wf-chip)] px-2 py-0.5 text-[10px] font-semibold text-[var(--wf-dim)]"
                title={statusLabel}
              >
                <WifiOff className="h-3 w-3" strokeWidth={2} />
                {statusLabel}
              </span>
            )}
            <button
              className="p-1 rounded hover:bg-[var(--wf-chip)] transition"
              onClick={() => setShowHelp((v) => !v)}
              title={showHelp ? "Hide help" : "What is this panel?"}
              aria-label="Serial monitor help"
              aria-pressed={showHelp}
            >
              <HelpCircle
                className={`h-3.5 w-3.5 ${showHelp ? "text-[var(--wf-fg,var(--wf-dim))]" : "text-[var(--wf-dim)]"}`}
                strokeWidth={1.8}
              />
            </button>
            <button
              className="p-1 rounded hover:bg-[var(--wf-chip)] transition"
              onClick={() => setShowSettings((v) => !v)}
              title="Settings"
              aria-label="Serial monitor settings"
              aria-pressed={showSettings}
            >
              {showSettings ? (
                <ChevronUp className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={2} />
              ) : (
                <Settings className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
              )}
            </button>
          </div>
        </div>

        {showHelp && (
          <div className="mt-3 px-3 py-2.5 rounded-lg bg-[var(--wf-panel)] border border-[var(--wf-line)] text-[11px] leading-relaxed text-[var(--wf-fg,var(--wf-dim))]">
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <span className="font-semibold uppercase tracking-[0.07em] text-[var(--wf-dim)]">
                Serial Monitor — Quick Help
              </span>
              <button
                className="p-0.5 -mt-0.5 rounded hover:bg-[var(--wf-chip)] transition"
                onClick={() => setShowHelp(false)}
                title="Close"
                aria-label="Close help"
              >
                <X className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={2} />
              </button>
            </div>
            <p className="mb-1.5 text-[var(--wf-dim)]">
              Streams live UART output for build-flash &amp; debug nodes. Use Settings (gear) to pick the
              port and baud rate before connecting. The debug agent can also open a session itself
              via the <code className="font-mono">serial_create</code> tool — this panel will auto-attach
              to any active session when it mounts.
            </p>
            <ul className="space-y-0.5 list-disc pl-4 text-[var(--wf-dim)]">
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">RX</span> — bytes received
                from the device
              </li>
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">TX</span> — bytes you sent
                via the input box (Enter to send; auto-appends <code className="font-mono">\n</code>)
              </li>
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">Reset</span> sends
                <code className="font-mono"> ^C^C^D</code>;
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]"> Clear</span>
                {" "}wipes the local log only
              </li>
            </ul>
          </div>
        )}

        {showSettings && (
          <div className="mt-3 flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg bg-[var(--wf-panel)] border border-[var(--wf-line)]">
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-medium text-[var(--wf-dim)]">Port</label>
              {availablePorts.length > 0 ? (
                <select
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  className="wf-serial-select"
                >
                  {availablePorts.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.path}
                      {p.manufacturer ? ` — ${p.manufacturer}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  className="wf-serial-input"
                  placeholder="/dev/ttyUSB0"
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-medium text-[var(--wf-dim)]">Baud</label>
              <select
                value={baudRate}
                onChange={(e) => setBaudRate(Number(e.target.value))}
                className="wf-serial-select"
                disabled={connected}
              >
                {COMMON_BAUD_RATES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                className="wf-serial-btn"
                onClick={() => {
                  if (!api) return
                  api
                    .json<SerialPort[]>("/serial/ports")
                    .then(setAvailablePorts)
                    .catch((err) => setErrorMsg((err as Error).message))
                }}
                disabled={!api}
                title="Re-scan host serial ports"
              >
                <RotateCcw className="h-3 w-3" strokeWidth={1.8} />
                Rescan
              </button>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="mt-2 px-3 py-1.5 rounded-md text-[10.5px] text-[var(--wf-bad,var(--wf-warn))] bg-[var(--wf-bad-soft,var(--wf-chip))] border border-[var(--wf-line)] flex items-center justify-between gap-3">
            <span className="font-mono truncate">{errorMsg}</span>
            <button
              className="opacity-60 hover:opacity-100"
              onClick={() => setErrorMsg(null)}
              aria-label="Dismiss error"
            >
              <X className="h-3 w-3" strokeWidth={2} />
            </button>
          </div>
        )}

        {isOffline && (
          <div className="mt-2 px-3 py-1.5 rounded-md text-[10.5px] text-[var(--wf-dim)] bg-[var(--wf-chip)]">
            Backend unavailable — the React workflow shell wasn't given a runtime context.
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2">
        <Activity className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
        <span className="font-mono text-[11px] text-[var(--wf-dim)]">{detail?.type ?? "embedded"} device</span>
        <span className="text-[var(--wf-line-strong)]">·</span>
        <span className="text-[11px] text-[var(--wf-dim)]">{lines.length} lines</span>
        {portLabel && (
          <>
            <span className="text-[var(--wf-line-strong)]">·</span>
            <span className="font-mono text-[10.5px] text-[var(--wf-dim)]">{portLabel}</span>
          </>
        )}
      </div>

      <div ref={scrollRef} className="wf-detail-diff wf-serial-output">
        {lines.length === 0 ? (
          <div className="px-5 py-6 text-[12px] text-[var(--wf-dim)]">
            No serial output. {connected ? "Waiting for device data…" : "Connect to a port to start monitoring."}
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`wf-serial-line wf-serial-line--${line.type}`}>
              <span className="wf-serial-time">{line.time}</span>
              <span className={`wf-serial-badge wf-serial-badge--${line.type}`}>
                {line.type === "rx" ? "RX" : line.type === "tx" ? "TX" : line.type === "error" ? "ERR" : "INF"}
              </span>
              <span className="wf-serial-text">{line.text}</span>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2.5">
        {!connected ? (
          <button
            onClick={connect}
            className="wf-serial-btn wf-serial-btn--connect"
            disabled={busy || isOffline}
            title={isOffline ? "Backend unavailable" : "Open serial session"}
          >
            <Wifi className="h-3 w-3" strokeWidth={2} />
            {busy ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <>
            <button
              onClick={disconnect}
              className="wf-serial-btn wf-serial-btn--disconnect"
              disabled={busy}
            >
              <WifiOff className="h-3 w-3" strokeWidth={2} />
              Disconnect
            </button>
            <button onClick={reset} className="wf-serial-btn" disabled={busy}>
              <RotateCcw className="h-3 w-3" strokeWidth={1.8} />
              Reset
            </button>
          </>
        )}
        <button onClick={clear} className="wf-serial-btn">
          <Trash2 className="h-3 w-3" strokeWidth={1.8} />
          Clear
        </button>
        <div className="ml-auto flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void sendCommand()
            }}
            placeholder="Send command..."
            className="wf-serial-input flex-1"
            disabled={!connected}
          />
          <button
            onClick={() => void sendCommand()}
            disabled={!connected || !input.trim()}
            className="wf-serial-btn wf-serial-btn--send"
          >
            <Send className="h-3 w-3" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}

export const serialToolPlugin: ToolPlugin<Detail | null> = {
  id: "serial-tool",
  name: "Serial Monitor",
  icon: Terminal,
  priority: 90,
  component: SerialTool,
  match: (nodeType) => nodeType === "build-flash" || nodeType === "debug",
}
