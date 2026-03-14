import path from "node:path"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import z from "zod"
import {
  checkPaths,
  expandRoots,
  listNames,
  load,
  platformFile,
  productFile,
  readJson,
  root,
  text,
  writeJson,
} from "./lib/embedded"

const server = new McpServer({
  name: "embedded_sdk",
  version: "0.1.0",
})

server.tool("sdk_catalog", "List known embedded platforms and products", {}, async () => {
  const platforms = await listNames("platforms")
  const products = await listNames("products")
  return text({
    manifest_root: root(),
    platforms,
    products,
  })
})

server.tool(
  "sdk_inspect",
  "Inspect manifest data and validate SDK/toolchain paths",
  {
    platform: z.string(),
    product: z.string().optional(),
  },
  async (args) => {
    const state = await load(args.platform, args.product)
    const platformRoots = expandRoots(state.platform?.sdk_roots)
    const productRoots = expandRoots(state.product?.sdk_roots)
    const sourceRoots = expandRoots(state.product?.source_roots)
    const bins = state.platform?.toolchains?.flatMap((x: { bin?: string }) => (x.bin ? [x.bin] : [])) ?? []

    return text({
      manifest_root: root(),
      platform_file: platformFile(args.platform),
      product_file: args.product ? productFile(args.product) : undefined,
      platform_exists: existsSync(platformFile(args.platform)),
      product_exists: args.product ? existsSync(productFile(args.product)) : undefined,
      platform: state.platform,
      product: state.product,
      checks: {
        platform_sdk_roots: checkPaths(platformRoots),
        product_sdk_roots: checkPaths(productRoots),
        source_roots: checkPaths(sourceRoots),
        toolchains: bins.map((bin: string) => ({
          bin,
          found: Boolean(Bun.which(bin)),
          path: Bun.which(bin) ?? null,
        })),
      },
    })
  },
)

server.tool(
  "sdk_discover",
  "Scan common roots for SDK and source directories",
  {
    platform: z.string().optional(),
    product: z.string().optional(),
    roots: z.array(z.string()).optional(),
    depth: z.number().int().min(1).max(6).default(3),
  },
  async (args) => {
    const keywords = [args.platform, args.product, "sdk", "toolchain", "firmware", "board"].filter(Boolean)
    const roots = expandRoots(args.roots ?? parseRootEnv())
    const hits = [] as { root: string; matches: string[] }[]

    for (const base of roots) {
      if (!existsSync(base)) continue
      const found = await scan(base, keywords as string[], args.depth)
      if (!found.length) continue
      hits.push({
        root: base,
        matches: found,
      })
    }

    return text({
      roots,
      keywords,
      hits,
    })
  },
)

server.tool(
  "sdk_record",
  "Create or update platform/product manifest from exploration output",
  {
    platform: z.string(),
    product: z.string(),
    platform_manifest: z.record(z.string(), z.unknown()).optional(),
    product_manifest: z.record(z.string(), z.unknown()).optional(),
    note: z.string().optional(),
  },
  async (args) => {
    const pFile = platformFile(args.platform)
    const dFile = productFile(args.product)

    const plat = args.platform_manifest ??
      (await readJson(pFile)) ?? {
        platform: args.platform,
      }
    const prod = args.product_manifest ??
      (await readJson(dFile)) ?? {
        product: args.product,
        platform: args.platform,
      }

    await writeJson(pFile, plat)
    await writeJson(dFile, prod)

    const memo = {
      updated_at: new Date().toISOString(),
      platform: args.platform,
      product: args.product,
      note: args.note ?? "",
    }
    const discovery = path.join(root(), "discovery", `${args.platform}-${args.product}.json`)
    await writeJson(discovery, memo)

    return text({
      platform_file: pFile,
      product_file: dFile,
      discovery_file: discovery,
      platform_manifest: plat,
      product_manifest: prod,
    })
  },
)

function parseRootEnv() {
  const input = process.env.SDK_SEARCH_ROOTS ?? "$SSC377_SDK_ROOT:./sdk:./third_party:/opt"
  return input.split(":").filter(Boolean)
}

async function scan(base: string, keywords: string[], depth: number) {
  const result: string[] = []
  await walk(
    base,
    0,
    depth,
    keywords.map((x) => x.toLowerCase()),
    result,
  )
  return result.slice(0, 120)
}

async function walk(dir: string, level: number, depth: number, keywords: string[], out: string[]) {
  if (level > depth) return
  const items = await readdirSafe(dir)
  for (const item of items) {
    const full = path.join(dir, item.name)
    const name = item.name.toLowerCase()
    const hit = keywords.some((k) => name.includes(k))
    if (hit) out.push(full)
    if (!item.isDirectory()) continue
    await walk(full, level + 1, depth, keywords, out)
  }
}

async function readdirSafe(dir: string) {
  if (!existsSync(dir)) return []
  return await readdir(dir, { withFileTypes: true })
}

await server.connect(new StdioServerTransport())
