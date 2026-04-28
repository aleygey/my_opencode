import { Flag } from "@/flag/flag"
import { Hono } from "hono"
import { proxy } from "hono/proxy"
import { getMimeType } from "hono/utils/mime"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

// Runtime escape hatch for "intranet deployment via bun run + prebuilt dist":
// when set, points at a directory that contains the built React app (the same
// shape `packages/app/dist` produces). Used when the single-file binary build
// is unavailable and we still want the SolidJS shell served on the same port
// as the API. SPA fallback to index.html, identical CSP behaviour to the
// embedded virtual file path.
const filesystemUIDir = process.env.OPENCODE_WEB_UI_DIR
  ? path.resolve(process.env.OPENCODE_WEB_UI_DIR)
  : null

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

async function serveFromFilesystemDir(dir: string, requestPath: string): Promise<Response> {
  const rel = requestPath.replace(/^\//, "") || "index.html"
  // Reject path-traversal attempts; everything must resolve under `dir`.
  const candidate = path.resolve(dir, rel)
  const fallback = path.resolve(dir, "index.html")
  const inside = (p: string) => p === dir || p.startsWith(dir + path.sep)
  const target = inside(candidate) && (await fs.stat(candidate).then((s) => s.isFile()).catch(() => false))
    ? candidate
    : fallback
  if (!(await fs.stat(target).then((s) => s.isFile()).catch(() => false))) {
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }
  const mime = getMimeType(target) ?? "application/octet-stream"
  const headers: Record<string, string> = { "content-type": mime }
  if (mime.startsWith("text/html")) headers["Content-Security-Policy"] = DEFAULT_CSP
  return new Response(new Uint8Array(await fs.readFile(target)), { headers })
}

export const UIRoutes = (): Hono =>
  new Hono().all("/*", async (c) => {
    const embeddedWebUI = await embeddedUIPromise
    const path = c.req.path

    if (embeddedWebUI) {
      const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
      if (!match) return c.json({ error: "Not Found" }, 404)

      if (await fs.exists(match)) {
        const mime = getMimeType(match) ?? "text/plain"
        c.header("Content-Type", mime)
        if (mime.startsWith("text/html")) {
          c.header("Content-Security-Policy", DEFAULT_CSP)
        }
        return c.body(new Uint8Array(await fs.readFile(match)))
      } else {
        return c.json({ error: "Not Found" }, 404)
      }
    } else if (filesystemUIDir) {
      return serveFromFilesystemDir(filesystemUIDir, path)
    } else {
      const response = await proxy(`https://app.opencode.ai${path}`, {
        raw: c.req.raw,
        headers: {
          ...Object.fromEntries(c.req.raw.headers.entries()),
          host: "app.opencode.ai",
        },
      })
      const match = response.headers.get("content-type")?.includes("text/html")
        ? (await response.clone().text()).match(
            /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
          )
        : undefined
      const hash = match ? createHash("sha256").update(match[2]).digest("base64") : ""
      response.headers.set("Content-Security-Policy", csp(hash))
      return response
    }
  })
