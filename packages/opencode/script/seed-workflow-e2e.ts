import path from "path"
import { $ } from "bun"
import { Effect } from "effect"

const dir = process.env.OPENCODE_E2E_PROJECT_DIR ?? path.resolve(import.meta.dir, "../../..")
const title = process.env.OPENCODE_E2E_WORKFLOW_TITLE ?? "Workflow Demo"
const model = process.env.OPENCODE_E2E_MODEL ?? "opencode/gpt-5-nano"
const parts = model.split("/")
const providerID = parts[0] ?? "opencode"
const modelID = parts[1] ?? "gpt-5-nano"

async function text(file: string) {
  const target = Bun.file(path.join(dir, file))
  if (!(await target.exists())) return ""
  return target.text()
}

async function before(file: string) {
  return $`git show HEAD:${file}`.cwd(dir).quiet().nothrow().text()
}

async function diff(file: string) {
  const prev = await before(file)
  const next = await text(file)
  return {
    file,
    before: prev,
    after: next,
    additions: next ? next.split("\n").length : 0,
    deletions: prev ? prev.split("\n").length : 0,
    status: !prev && next ? "added" : prev && !next ? "deleted" : "modified",
  } as const
}

async function result(data: Record<string, unknown>) {
  const json = JSON.stringify(data, null, 2)
  const file = process.env.OPENCODE_E2E_OUTPUT
  if (file) await Bun.write(file, json)
  console.log(json)
}

const seed = async () => {
  const { Instance } = await import("../src/project/instance")
  const { InstanceBootstrap } = await import("../src/project/bootstrap")
  const { Session } = await import("../src/session")
  const { Workflow } = await import("../src/workflow")
  const { Storage } = await import("../src/storage")
  const { AppRuntime } = await import("../src/effect/app-runtime")
  const { MessageID, PartID, SessionID } = await import("../src/session/schema")
  const { ProviderID, ModelID } = await import("../src/provider/schema")

  const prompt = (sessionID: string, agent: string, text: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.Service
        const now = Date.now()
        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: SessionID.make(sessionID),
          role: "user",
          time: { created: now },
          agent,
          model: { providerID: ProviderID.make(providerID), modelID: ModelID.make(modelID) },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: SessionID.make(sessionID),
          messageID,
          type: "text",
          text,
          time: { start: now },
        })
      }),
    )

  const createSession = (input: { title?: string; parentID?: string }) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.create({
          title: input.title,
          parentID: input.parentID ? SessionID.make(input.parentID) : undefined,
        })
      }),
    )

  const writeDiff = (sessionID: string, value: unknown) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        yield* storage.write(["session_diff", sessionID], value)
      }),
    )

  await Instance.provide({
    directory: dir,
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: async () => {
      const root = await createSession({ title })
      const coding = await createSession({ parentID: root.id, title: "Coding Node" })
      const build = await createSession({ parentID: root.id, title: "Build / Flash Node" })

      await Promise.all([
        prompt(root.id, "orchestrator", "Plan coding, build/flash, and debug for the embedded workflow."),
        prompt(
          root.id,
          "orchestrator",
          "Plan confirmed: create the workflow graph first, then start coding, then build/flash, and only start debug after the board is ready.",
        ),
        prompt(coding.id, "coding", "Implement workflow runtime, graph UI, and workflow tools."),
        prompt(build.id, "build-flash", "Prepare build artifacts and stage flashing pipeline."),
      ])

      await Promise.all([
        writeDiff(root.id, [await diff("multiagent.md")]),
        writeDiff(coding.id, [
          await diff("packages/app/src/pages/session/workflow-panel.tsx"),
          await diff("packages/app/src/pages/session.tsx"),
        ]),
        writeDiff(build.id, [await diff("packages/opencode/src/workflow/index.ts")]),
      ])

      const workflow = await Workflow.create({
        session_id: root.id,
        title,
        summary: {
          objective: "Validate the workflow topology view, node sessions, and aggregated review panel.",
        },
        nodes: [
          {
            id: "node-coding",
            title: "Coding",
            agent: "coding",
            model: { providerID, modelID },
            status: "pending",
            result_status: "unknown",
            max_attempts: 2,
            position: 0,
          },
          {
            id: "node-build",
            title: "Build / Flash",
            agent: "build-flash",
            model: { providerID, modelID },
            status: "pending",
            result_status: "unknown",
            max_attempts: 3,
            position: 1,
          },
          {
            id: "node-debug",
            title: "Debug",
            agent: "debug",
            model: { providerID, modelID },
            status: "ready",
            result_status: "unknown",
            max_attempts: 2,
            position: 2,
          },
        ],
        edges: [
          { from_node_id: "node-coding", to_node_id: "node-build", label: "handoff" },
          { from_node_id: "node-build", to_node_id: "node-debug", label: "verify" },
        ],
        checkpoints: [
          { node_id: "node-coding", label: "Code Review", status: "pending" },
          { node_id: "node-build", label: "Board Ready", status: "pending" },
        ],
      })

      const snapshot = await Workflow.get(workflow.id)
      const review = snapshot.checkpoints.find((item) => item.node_id === "node-coding")
      const board = snapshot.checkpoints.find((item) => item.node_id === "node-build")

      await Workflow.patchNode({
        nodeID: "node-coding",
        source: "coding",
        patch: {
          session_id: coding.id,
          status: "completed",
          result_status: "success",
          attempt_delta: 1,
          state_json: {
            value: {
              stage: "implemented",
              review: "ready",
            },
          },
          result_json: {
            value: {
              files: [
                "packages/app/src/pages/session/workflow-panel.tsx",
                "packages/app/src/pages/session.tsx",
              ],
            },
          },
        },
        event: {
          kind: "node.completed",
          payload: {
            summary: "Workflow runtime and graph UI wiring completed.",
          },
        },
      })

      if (review) {
        await Workflow.setCheckpoint({
          checkpointID: review.id,
          status: "passed",
          result_json: {
            note: "Review required before merging coding changes into the main workspace.",
          },
        })
      }

      await Workflow.patchNode({
        nodeID: "node-build",
        source: "build-flash",
        patch: {
          session_id: build.id,
          status: "running",
          result_status: "partial",
          attempt_delta: 1,
          state_json: {
            value: {
              stage: "flash_pending",
              board: "/dev/ttyUSB0",
            },
          },
          result_json: {
            value: {
              artifact: "output/demo.bin",
            },
          },
        },
        event: {
          kind: "node.started",
          payload: {
            summary: "Binary built and waiting for flashing confirmation.",
          },
        },
      })

      await Workflow.control({
        workflowID: workflow.id,
        nodeID: "node-build",
        source: "orchestrator",
        command: "inject_context",
        payload: {
          prompt: "Confirm the target board is connected before flashing.",
        },
      })

      if (board) {
        await Workflow.setCheckpoint({
          checkpointID: board.id,
          status: "pending",
          result_json: {
            note: "Waiting for board availability and user confirmation.",
          },
        })
      }

      await Workflow.patchNode({
        nodeID: "node-debug",
        source: "debug",
        patch: {
          status: "ready",
          result_status: "unknown",
          state_json: {
            value: {
              stage: "blocked_by_build",
            },
          },
        },
        event: {
          kind: "node.blocked",
          payload: {
            blocked_by: "node-build",
          },
        },
      })

      await result({
        workflowID: workflow.id,
        rootSessionID: root.id,
        nodeSessionIDs: {
          coding: coding.id,
          build: build.id,
        },
      })
    },
  })
}

await seed()
