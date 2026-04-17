import type { SerialPort, PortInfo, SerialOpts } from "./serial"

export type { Disp, Exit, PortInfo, SerialOpts, SerialPort } from "./serial"

export async function listPorts(): Promise<PortInfo[]> {
  try {
    const { SerialPort: SP } = await import("serialport")
    return await SP.list()
  } catch {
    return []
  }
}

export function open(path: string, opts: SerialOpts): SerialPort {
  try {
    // Bun does not have native serialport bindings;
    // dynamic import will likely fail, in which case we throw.
    const mod = require("serialport")
    const port = new mod.SerialPort({
      path,
      baudRate: opts.baudRate,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? "none",
      rtscts: opts.flowControl ?? false,
      autoOpen: false,
    })
    port.open()
    return {
      onData(listener) {
        port.on("data", (buf: Buffer) => listener(buf.toString("utf-8")))
        return { dispose: () => port.removeListener("data", listener) }
      },
      onExit(listener) {
        port.on("close", () => listener({ exitCode: 0 }))
        return { dispose: () => port.removeListener("close", listener) }
      },
      write(data) {
        port.write(data)
      },
      close() {
        port.close()
      },
    }
  } catch {
    throw new Error("serialport is not available on this platform (Bun runtime)")
  }
}
