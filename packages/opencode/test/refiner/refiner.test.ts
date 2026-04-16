import { beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import matter from "gray-matter"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Workflow } from "../../src/workflow"
import { Refiner } from "../../src/refiner"
import { Glob } from "../../src/util/glob"
import { Filesystem } from "../../src/util/filesystem"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function addUserMessage(sessionID: string, text: string) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  })
  return id
}

async function waitFor(pattern: string, cwd: string, timeout = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const files = await Glob.scan(pattern, { cwd, absolute: true, dot: true }).catch(() => [] as string[])
    if (files.length > 0) return files
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return [] as string[]
}

beforeEach(async () => {
  await resetDatabase()
})

describe("Refiner", () => {
  test("auto-observes workflow user messages and writes inbox plus experience records", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Workflow.create({
          session_id: session.id,
          title: "Firmware patch workflow",
          nodes: [
            {
              id: "node-build",
              title: "Implement firmware change",
              agent: "build",
              status: "waiting",
            },
          ],
        })

        await addUserMessage(
          session.id,
          "修改后请帮我做提交，后续推送到 gerrit，并在 jenkins 上编译验证固件，提交信息需要符合固定格式。",
        )

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const inbox = await waitFor("inbox/**/*.md", base)
        const experiences = await waitFor("experiences/**/*.md", base)

        expect(inbox.length).toBeGreaterThan(0)
        expect(experiences.length).toBeGreaterThan(0)

        const inboxText = await Filesystem.readText(inbox[0]!)
        expect(inboxText.includes("## Observation")).toBe(true)
        expect(inboxText.includes("```json")).toBe(false)

        const experienceDoc = matter(await Filesystem.readText(experiences[0]!))
        expect(experienceDoc.data.kind).toBe("workflow_experience")
        expect(experienceDoc.data.long_term_value).toBe(true)
        expect(["workflow_orchestration_completion", "constraint_or_policy", "tool_gap_completion"]).toContain(
          experienceDoc.data.classification,
        )
        expect(experienceDoc.data.task_type).toBe("coding")

        const experienceText = await Filesystem.readText(experiences[0]!)
        expect(experienceText.includes("## Applies When")).toBe(true)
        expect(experienceText.includes("```json")).toBe(false)
      },
    })
  })

  test("marks pending experience evidence as successful after later workflow recovery", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const workflow = await Workflow.create({
          session_id: session.id,
          title: "Delivery workflow",
          nodes: [
            {
              id: "node-deliver",
              title: "Deliver change",
              agent: "build",
              status: "running",
              session_id: session.id,
            },
          ],
        })

        await Refiner.observeWorkflowEvent({
          id: 1,
          workflow_id: workflow.id,
          node_id: "node-deliver",
          session_id: session.id,
          target_node_id: "node-deliver",
          kind: "node.attempt_reported",
          source: "node",
          payload: {
            result: "fail",
            summary: "Blocked because the workflow still needs gerrit delivery and jenkins validation",
            needs: ["Need gerrit push step", "Need jenkins build validation step"],
            errors: [{ source: "build", reason: "missing downstream delivery workflow" }],
          },
          time_created: Date.now(),
        })

        await Refiner.observeWorkflowEvent({
          id: 2,
          workflow_id: workflow.id,
          node_id: "node-deliver",
          session_id: session.id,
          target_node_id: "node-deliver",
          kind: "node.updated",
          source: "node",
          payload: {
            status: "completed",
            result_status: "success",
          },
          time_created: Date.now() + 1,
        })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const experiences = await waitFor("experiences/**/*.md", base)
        expect(experiences.length).toBeGreaterThan(0)

        const experienceDoc = matter(await Filesystem.readText(experiences[0]!))
        expect(experienceDoc.data.kind).toBe("workflow_experience")
        expect(experienceDoc.data.evidence.success_count).toBeGreaterThan(0)
        expect(experienceDoc.data.evidence.count).toBeGreaterThan(0)
      },
    })
  })
})
