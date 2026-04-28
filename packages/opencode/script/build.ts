#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
// --only=<os>-<arch>[-baseline][-musl] restricts the build to one target.
// Accepts comma-separated list, e.g. --only=linux-x64,linux-arm64. Useful
// when you want a single artefact without cross-compiling everything.
const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length)
const onlyFilters = onlyArg ? onlyArg.split(",").map((s) => s.trim()).filter(Boolean) : null
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const matchesOnly = (item: (typeof allTargets)[number], filter: string) => {
  const parts = filter.split("-")
  const os = parts[0]
  const arch = parts[1]
  const rest = new Set(parts.slice(2))
  if (item.os !== os || item.arch !== arch) return false
  const wantBaseline = rest.has("baseline")
  const wantMusl = rest.has("musl")
  if (wantBaseline !== (item.avx2 === false)) return false
  if (wantMusl !== (item.abi === "musl")) return false
  return true
}

const targets = onlyFilters
  ? allTargets.filter((item) => onlyFilters.some((f) => matchesOnly(item, f)))
  : singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/cmd/tui/worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/opencode`,
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {},
    entrypoints: ["./src/index.ts", parserWorker, workerPath, ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : [])],
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MIGRATIONS: JSON.stringify(migrations),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
    },
  })

  // Smoke test: only run if binary is for current platform.
  // We run TWO checks:
  //   1. `--version` — verifies CLI arg parsing and the cheap startup path.
  //   2. `serve` — actually binds the HTTP listener, exercising the full
  //      module graph (experimental routes, session/prompt, retrieve, etc.).
  //      This is the regression guard against `bun --compile` startup-time
  //      module-loader deadlocks: a hung binary can produce a working
  //      `--version` but never bind the port. See git bisect 54d99fb9f for
  //      the prior incident that motivated this check.
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/opencode`
    console.log(`Running smoke test (--version): ${binaryPath}`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`  --version OK: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test --version failed for ${name}:`, e)
      process.exit(1)
    }

    // Pick a free port. `0` is not reliably honoured by all server stacks,
    // so we ask the kernel for an ephemeral port and reuse it.
    const net = await import("node:net")
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer()
      srv.unref()
      srv.on("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address()
        if (addr && typeof addr === "object") {
          srv.close(() => resolve(addr.port))
        } else {
          srv.close(() => reject(new Error("could not get ephemeral port")))
        }
      })
    })

    console.log(`Running smoke test (serve probe on 127.0.0.1:${port}): ${binaryPath}`)
    const proc = Bun.spawn([binaryPath, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    })
    const startedAt = Date.now()
    const BOOT_TIMEOUT_MS = 25_000
    const POLL_INTERVAL_MS = 250
    let bound = false
    let lastErr: unknown = null
    try {
      while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
        if (proc.exitCode !== null) {
          throw new Error(`serve exited prematurely with code ${proc.exitCode}`)
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/openapi.json`, {
            signal: AbortSignal.timeout(2000),
          })
          if (res.status > 0) {
            await res.body?.cancel().catch(() => {})
            bound = true
            break
          }
        } catch (e) {
          lastErr = e
        }
        await Bun.sleep(POLL_INTERVAL_MS)
      }
      if (!bound) {
        const stderrText = await new Response(proc.stderr).text().catch(() => "")
        const stdoutText = await new Response(proc.stdout).text().catch(() => "")
        console.error(
          `Smoke test serve failed for ${name}: server did not bind 127.0.0.1:${port} within ${BOOT_TIMEOUT_MS}ms.`,
        )
        console.error(`  last fetch error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
        if (stderrText) console.error(`  stderr (truncated): ${stderrText.slice(-2000)}`)
        if (stdoutText) console.error(`  stdout (truncated): ${stdoutText.slice(-2000)}`)
        throw new Error("serve did not bind in time — likely AOT module-loader hang")
      }
      console.log(`  serve probe OK (HTTP responded on /openapi.json)`)
    } catch (e) {
      try {
        proc.kill("SIGKILL")
      } catch {}
      console.error(`Smoke test serve failed for ${name}:`, e)
      process.exit(1)
    } finally {
      try {
        proc.kill("SIGTERM")
        // Give it a moment to shut down cleanly, then force.
        const racer = Promise.race([proc.exited, Bun.sleep(2000)])
        await racer
        if (proc.exitCode === null) {
          try {
            proc.kill("SIGKILL")
          } catch {}
        }
      } catch {}
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
