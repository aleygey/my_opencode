import { Log } from "../util"

/**
 * Strip control characters and shell metacharacters for safe
 * use in command arguments. Defense in depth — Bun.spawn
 * doesn't use a shell, but this guards against accidental misuse.
 */
function sanitize(str: string): string {
  return str
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/`/g, "'")
    .replace(/\$/g, "")
}

/** Escape a string for AppleScript double-quoted string literals. */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export async function notify(title: string, body: string): Promise<boolean> {
  const safeTitle = sanitize(title)
  const safeBody = sanitize(body)

  if (process.platform === "darwin") return darwin(safeTitle, safeBody)
  if (process.platform === "linux") return linux(safeTitle, safeBody)

  Log.Default.info("desktop notification not supported", { platform: process.platform })
  return false
}

async function darwin(title: string, body: string): Promise<boolean> {
  const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`
  try {
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode === 0) return true
    const stderr = await new Response(proc.stderr).text()
    Log.Default.warn("notification failed", { platform: "darwin", error: stderr })
    return false
  } catch {
    Log.Default.info("osascript not available", { platform: "darwin" })
    return false
  }
}

async function linux(title: string, body: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["notify-send", title, body], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode === 0) return true
    const stderr = await new Response(proc.stderr).text()
    Log.Default.warn("notification failed", { platform: "linux", error: stderr })
    return false
  } catch {
    Log.Default.info("notify-send not available", { platform: "linux" })
    return false
  }
}
