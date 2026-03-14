import path from "node:path"
import { existsSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import z from "zod"
import { load, shell, text } from "./lib/embedded"

const server = new McpServer({
  name: "embedded_flash",
  version: "0.1.0",
})

server.tool(
  "flash_plan",
  "Show flash command, script and validation",
  {
    platform: z.string(),
    product: z.string(),
    firmware: z.string().optional(),
    port: z.string().optional(),
  },
  async (args) => {
    const state = await load(args.platform, args.product)
    const flash = state.product?.flash ?? {}
    const script = resolvePath(flash.script)
    const firmware = resolvePath(args.firmware ?? flash.default_firmware)
    const port = args.port ?? flash.default_port ?? process.env.FLASH_PORT ?? "/dev/ttyUSB0"

    return text({
      platform: args.platform,
      product: args.product,
      script,
      script_exists: script ? existsSync(script) : false,
      firmware,
      firmware_exists: firmware ? existsSync(firmware) : false,
      port,
      command: flash.command,
      env: flash.env ?? {},
    })
  },
)

server.tool(
  "flash_run",
  "Run flash command or local flash script",
  {
    platform: z.string(),
    product: z.string(),
    firmware: z.string().optional(),
    port: z.string().optional(),
    command: z.string().optional(),
    dry_run: z.boolean().default(false),
  },
  async (args) => {
    const state = await load(args.platform, args.product)
    const flash = state.product?.flash ?? {}
    const script = resolvePath(flash.script)
    const firmware = resolvePath(args.firmware ?? flash.default_firmware)
    const port = args.port ?? flash.default_port ?? process.env.FLASH_PORT ?? "/dev/ttyUSB0"
    const command =
      args.command ?? flash.command ?? (script && firmware ? `${script} ${quote(firmware)} ${quote(port)}` : "")

    if (!command) {
      return text({
        ok: false,
        error: "missing flash command",
        hint: "set product.flash.command or product.flash.script",
      })
    }

    if (args.dry_run) {
      return text({
        ok: true,
        dry_run: true,
        command,
        script,
        firmware,
        port,
      })
    }

    const out = shell(command, process.cwd(), flash.env ?? {})
    return text({
      ...out,
      script,
      firmware,
      port,
    })
  },
)

function resolvePath(input: string | undefined) {
  if (!input) return ""
  const base = input.startsWith("~/") ? path.join(process.env.HOME ?? "", input.slice(2)) : input
  if (path.isAbsolute(base)) return base
  return path.resolve(process.cwd(), base)
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

await server.connect(new StdioServerTransport())
