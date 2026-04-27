/** @jsxImportSource react */
import { useState, useEffect, useRef } from "react"
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
import { Spin } from "../components/spin"

interface SerialLine {
  id: number
  type: "rx" | "tx" | "error" | "info"
  text: string
  time: string
}

function formatTime() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`
}

function SerialTool({ nodeStatus, detail, onAction }: PluginContext<Detail | null>) {
  const [lines, setLines] = useState<SerialLine[]>([])
  const [input, setInput] = useState("")
  const [connected, setConnected] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [baudRate, setBaudRate] = useState(115200)
  const [port, setPort] = useState("/dev/ttyUSB0")
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const run = nodeStatus === "running"

  // Connection status string surfaced in the header pill — tracks the real
  // lifecycle once backend wiring lands. For now: idle | connected | running-no-conn.
  const status: "connected" | "ready" | "idle" =
    connected ? "connected" : run ? "ready" : "idle"
  const statusLabel =
    status === "connected"
      ? `${port} · ${baudRate} baud`
      : status === "ready"
        ? "Ready to connect"
        : "Disconnected"

  useEffect(() => {
    if (run && connected) {
      const mock = [
        "[0x00] BOOT: STM32F103C8T6 initializing...",
        "[0x04] CLK: HSI 8MHz -> PLL 72MHz",
        "[0x08] GPIO: Port A configured (PA0-PA7)",
        "[0x12] UART: USART1 @ 115200 baud ready",
        "[0x16] FLASH: Sector 0 unlocked",
        "[0x20] WRITE: Writing firmware blob...",
        "[0x24] VERIFY: Checksum OK (0xA5C3)",
        "[0x28] DONE: Flash complete (8.2KB)",
      ]
      let idx = 0
      const timer = setInterval(() => {
        if (idx < mock.length) {
          setLines((prev) => [...prev, { id: Date.now() + idx, type: "rx", text: mock[idx], time: formatTime() }])
          idx++
        } else {
          clearInterval(timer)
        }
      }, 800)
      return () => clearInterval(timer)
    }
  }, [run, connected])

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines, autoScroll])

  const connect = () => {
    setConnected(true)
    setLines((prev) => [
      ...prev,
      { id: Date.now(), type: "info", text: `Connected to ${port} @ ${baudRate} baud`, time: formatTime() },
    ])
    onAction?.("connect", { port, baudRate })
  }

  const disconnect = () => {
    setConnected(false)
    setLines((prev) => [...prev, { id: Date.now(), type: "info", text: "Disconnected", time: formatTime() }])
    onAction?.("disconnect")
  }

  const sendCommand = () => {
    if (!input.trim() || !connected) return
    setLines((prev) => [...prev, { id: Date.now(), type: "tx", text: input, time: formatTime() }])
    setInput("")
    onAction?.("send", { data: input })
  }

  const clear = () => setLines([])

  const reset = () => {
    setLines((prev) => [...prev, { id: Date.now(), type: "info", text: "Resetting device...", time: formatTime() }])
    onAction?.("reset")
  }

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
              port and baud rate before connecting.
            </p>
            <ul className="space-y-0.5 list-disc pl-4 text-[var(--wf-dim)]">
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">RX</span> — bytes received
                from the device
              </li>
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">TX</span> — bytes you sent
                via the input box (Enter to send)
              </li>
              <li>
                <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">Reset</span> issues a soft
                device reset; <span className="font-semibold text-[var(--wf-fg,var(--wf-dim))]">Clear</span>
                {" "}wipes the local log only
              </li>
              <li>
                Status pill shows <span className="font-mono">port · baud</span> when connected and pulses
                amber when the node is running but not yet attached
              </li>
            </ul>
          </div>
        )}

        {showSettings && (
          <div className="mt-3 flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg bg-[var(--wf-panel)] border border-[var(--wf-line)]">
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-medium text-[var(--wf-dim)]">Port</label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="wf-serial-input"
                placeholder="/dev/ttyUSB0"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-medium text-[var(--wf-dim)]">Baud</label>
              <select
                value={baudRate}
                onChange={(e) => setBaudRate(Number(e.target.value))}
                className="wf-serial-select"
              >
                <option value={9600}>9600</option>
                <option value={19200}>19200</option>
                <option value={38400}>38400</option>
                <option value={57600}>57600</option>
                <option value={115200}>115200</option>
                <option value={230400}>230400</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-bg)] px-5 py-2">
        <Activity className="h-3 w-3 text-[var(--wf-dim)]" strokeWidth={1.8} />
        <span className="font-mono text-[11px] text-[var(--wf-dim)]">{detail?.type ?? "embedded"} device</span>
        <span className="text-[var(--wf-line-strong)]">·</span>
        <span className="text-[11px] text-[var(--wf-dim)]">{lines.length} lines</span>
      </div>

      <div ref={scrollRef} className="wf-detail-diff wf-serial-output">
        {lines.length === 0 ? (
          <div className="px-5 py-6 text-[12px] text-[var(--wf-dim)]">
            No serial output. Connect to device to start monitoring.
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
          <button onClick={connect} className="wf-serial-btn wf-serial-btn--connect">
            <Wifi className="h-3 w-3" strokeWidth={2} />
            Connect
          </button>
        ) : (
          <>
            <button onClick={disconnect} className="wf-serial-btn wf-serial-btn--disconnect">
              <WifiOff className="h-3 w-3" strokeWidth={2} />
              Disconnect
            </button>
            <button onClick={reset} className="wf-serial-btn">
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
              if (e.key === "Enter") sendCommand()
            }}
            placeholder="Send command..."
            className="wf-serial-input flex-1"
            disabled={!connected}
          />
          <button
            onClick={sendCommand}
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
