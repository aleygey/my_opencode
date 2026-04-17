export type Disp = { dispose(): void }

export type Exit = { exitCode: number }

export type PortInfo = {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  vendorId?: string
  productId?: string
}

export type SerialOpts = {
  baudRate: number
  dataBits?: number
  stopBits?: number
  parity?: "none" | "even" | "odd" | "mark" | "space"
  flowControl?: boolean
}

export type SerialPort = {
  onData(listener: (data: string) => void): Disp
  onExit(listener: (event: Exit) => void): Disp
  write(data: string): void
  close(): void
}
