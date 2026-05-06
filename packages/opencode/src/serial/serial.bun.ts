import type { SerialPort, PortInfo, SerialOpts } from "./serial"

export type { Disp, Exit, PortInfo, SerialOpts, SerialPort } from "./serial"

// serialport is declared in opencode/package.json as an `optionalDependencies`,
// so the package may be absent on hosts that couldn't fetch the prebuilt binary
// (and lack a local toolchain). We load it dynamically and silently degrade
// rather than crashing the whole runtime in that case.
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
  } catch (err) {
    throw new Error(
      "serialport native bindings are not available — install `serialport` (or its prebuilds) for this platform.",
      { cause: err as Error },
    )
  }
}
