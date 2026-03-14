import path from "node:path"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"

const fallbackRoot = ".opencode/embedded/manifest"

function parseList(input: string | undefined) {
  if (!input) return []
  return input
    .split(":")
    .map((x) => x.trim())
    .filter(Boolean)
}

function abs(input: string) {
  if (input.startsWith("~/")) return path.join(process.env.HOME ?? "", input.slice(2))
  if (path.isAbsolute(input)) return input
  return path.resolve(process.cwd(), input)
}

export function root() {
  return abs(process.env.EMBEDDED_MANIFEST_ROOT ?? fallbackRoot)
}

export function platformFile(name: string) {
  return path.join(root(), "platforms", `${name}.json`)
}

export function productFile(name: string) {
  return path.join(root(), "products", `${name}.json`)
}

export async function readJson(file: string) {
  if (!existsSync(file)) return undefined
  const text = await Bun.file(file).text()
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function listNames(kind: "platforms" | "products") {
  const dir = path.join(root(), kind)
  if (!existsSync(dir)) return []
  const items = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir, absolute: false }))
  return items.map((x) => x.replace(/\.json$/, "")).sort()
}

export async function load(platform: string, product?: string) {
  const plat = await readJson(platformFile(platform))
  const prod = product ? await readJson(productFile(product)) : undefined
  return {
    platform: plat,
    product: prod,
  }
}

export function expandRoots(values: string[] | undefined) {
  return (values ?? []).flatMap((x) => {
    if (x.startsWith("$")) {
      const env = process.env[x.slice(1)]
      return parseList(env).map(abs)
    }
    return [abs(x)]
  })
}

export function checkPaths(values: string[]) {
  return values.map((item) => ({
    path: item,
    exists: existsSync(item),
  }))
}

export function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  }
}

export function shell(command: string, cwd?: string, env?: Record<string, string>) {
  const out = Bun.spawnSync({
    cmd: ["bash", "-lc", command],
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = out.stdout.toString()
  const stderr = out.stderr.toString()
  return {
    ok: out.exitCode === 0,
    exit_code: out.exitCode,
    stdout: stdout.length > 12000 ? `${stdout.slice(0, 12000)}\n...<truncated>` : stdout,
    stderr: stderr.length > 12000 ? `${stderr.slice(0, 12000)}\n...<truncated>` : stderr,
    command,
    cwd: cwd ?? process.cwd(),
  }
}
