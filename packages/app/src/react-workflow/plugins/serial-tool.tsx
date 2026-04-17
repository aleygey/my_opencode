/** @jsxImportSource react */
import { useState, useEffect, useRef } from "react"
import { Cpu, Activity, Terminal, Wifi, WifiOff, Send, RotateCcw, Settings, Trash2, ChevronUp } from "lucide-react"
import type { ToolPlugin, PluginContext, ToolData } from "./types"
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

function SerialTool({ nodeId, nodeStatus, data, detail, onAction }: PluginContext) {
  const [lines, setLines] = useState<SerialLine[]>([])
  const [input, setInput] = useState("")
  const [connected, setConnected] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [baudRate, setBaudRate] = useState(115200)
  const [port, setPort] = useState("/dev/ttyUSB0")
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const run = nodeStatus === "running"
  const d = detail as Detail | null

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
            {connected ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--wf-ok-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--wf-ok)]">
                <Wifi className="h-3 w-3" strokeWidth={2} />
                Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--wf-chip)] px-2 py-0.5 text-[10px] font-semibold text-[var(--wf-dim)]">
                <WifiOff className="h-3 w-3" strokeWidth={2} />
                Disconnected
              </span>
            )}
            <button
              className="p-1 rounded hover:bg-[var(--wf-chip)] transition"
              onClick={() => setShowSettings((v) => !v)}
              title="Settings"
            >
              {showSettings ? (
                <ChevronUp className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={2} />
              ) : (
                <Settings className="h-3.5 w-3.5 text-[var(--wf-dim)]" strokeWidth={1.8} />
              )}
            </button>
          </div>
        </div>

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
        <span className="font-mono text-[11px] text-[var(--wf-dim)]">{d?.type ?? "embedded"} device</span>
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

export const serialToolPlugin: ToolPlugin = {
  id: "serial-tool",
  name: "Serial Monitor",
  icon: Terminal,
  supportedTypes: ["build-flash", "debug"],
  priority: 90,
  component: SerialTool,
  getData: (detail: unknown): ToolData => {
    const d = detail as Detail | null
    return {
      status: "idle",
      rawData: d?.executionLog ?? [],
    }
  },
  matches: (nodeType: string, detail: unknown): boolean => {
    return nodeType === "build-flash" || nodeType === "debug"
  },
}
