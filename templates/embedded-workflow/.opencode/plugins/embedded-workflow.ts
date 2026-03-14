import type { Plugin } from "@opencode-ai/plugin"

function classify(command: string) {
  const value = command.toLowerCase()
  if (
    value.includes("openocd") ||
    value.includes("esptool") ||
    value.includes("west flash") ||
    value.includes("dfu-util")
  ) {
    return "flash"
  }
  if (
    value.includes("cmake") ||
    value.includes("ninja") ||
    value.includes("make") ||
    value.includes("idf.py build") ||
    value.includes("west build")
  ) {
    return "build"
  }
  if (
    value.includes("minicom") ||
    value.includes("screen") ||
    value.includes("picocom") ||
    value.includes("pyserial")
  ) {
    return "serial"
  }
  return "other"
}

export const EmbeddedWorkflowPlugin: Plugin = async ({ client }) => {
  return {
    "shell.env": async (_input, output) => {
      output.env.OPENCODE_EMBEDDED = output.env.OPENCODE_EMBEDDED || "1"
      output.env.EMBEDDED_TARGET = output.env.EMBEDDED_TARGET || "unknown"
      output.env.EMBEDDED_PLATFORM = output.env.EMBEDDED_PLATFORM || "unknown"
      output.env.EMBEDDED_PROFILE_DIR = output.env.EMBEDDED_PROFILE_DIR || ".opencode/profiles"
      output.env.EMBEDDED_LOG_DIR = output.env.EMBEDDED_LOG_DIR || ".opencode/logs"
    },
    "tool.execute.after": async (input) => {
      if (input.tool !== "bash") return
      const command = String(input.args.command || "")
      const kind = classify(command)
      if (kind === "other") return

      await client.app.log({
        body: {
          service: "embedded-workflow-plugin",
          level: "info",
          message: "embedded command executed",
          extra: {
            kind,
            command,
          },
        },
      })
    },
  }
}
