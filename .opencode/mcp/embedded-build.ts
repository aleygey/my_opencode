import path from "node:path"
import { existsSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import z from "zod"
import { load, shell, text } from "./lib/embedded"

const server = new McpServer({
  name: "embedded_build",
  version: "0.1.0",
})

server.tool(
  "build_profiles",
  "List build profiles for a product",
  {
    platform: z.string(),
    product: z.string(),
  },
  async (args) => {
    const state = await load(args.platform, args.product)
    const profiles = state.product?.build?.profiles ?? {}
    return text({
      platform: args.platform,
      product: args.product,
      profiles,
      defaults: {
        profile: state.product?.build?.default_profile,
        command: process.env.BUILD_CMD_DEFAULT ?? "",
      },
    })
  },
)

server.tool(
  "build_run",
  "Run embedded build command by profile",
  {
    platform: z.string(),
    product: z.string(),
    profile: z.string().optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    dry_run: z.boolean().default(false),
  },
  async (args) => {
    const state = await load(args.platform, args.product)
    const selected =
      args.profile ??
      state.product?.build?.default_profile ??
      Object.keys(state.product?.build?.profiles ?? {})[0] ??
      ""
    const profile = selected ? state.product?.build?.profiles?.[selected] : undefined
    const command = args.command ?? profile?.command ?? process.env.BUILD_CMD_DEFAULT ?? ""
    const cwd = resolveCwd(args.cwd ?? profile?.cwd)
    const env = profile?.env ?? {}

    if (!command) {
      return text({
        ok: false,
        error: "missing build command",
        hint: "set product.build.profiles.<name>.command or BUILD_CMD_DEFAULT",
      })
    }

    if (args.dry_run) {
      return text({
        ok: true,
        dry_run: true,
        profile: selected,
        command,
        cwd,
        env,
      })
    }

    const out = shell(command, cwd, env)
    return text({
      profile: selected,
      ...out,
    })
  },
)

function resolveCwd(input: string | undefined) {
  if (!input) return process.cwd()
  const base = input.startsWith("~/") ? path.join(process.env.HOME ?? "", input.slice(2)) : input
  const full = path.isAbsolute(base) ? base : path.resolve(process.cwd(), base)
  if (existsSync(full)) return full
  return process.cwd()
}

await server.connect(new StdioServerTransport())
