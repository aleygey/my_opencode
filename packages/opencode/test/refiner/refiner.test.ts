import { beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
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
  } as unknown as Parameters<typeof Session.updatePart>[0])
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

async function waitForCount(pattern: string, cwd: string, count: number, timeout = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const files = await Glob.scan(pattern, { cwd, absolute: true, dot: true }).catch(() => [] as string[])
    if (files.length >= count) return files
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return [] as string[]
}

beforeEach(async () => {
  await resetDatabase()
  Refiner.setRouteOverrideForTest(undefined)
  Refiner.setRefineOverrideForTest(undefined)
})

describe("Refiner", () => {
  test("creates a new experience on first observation when route says 'new'", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "候选引入了全新的流程规则",
          kind: "workflow_rule",
          title: "提交前必须执行 lint",
          abstract: "在提交代码前应先跑 lint 校验，确保代码通过静态检查再进入提交流程。",
          scope: "repo",
          task_type: "coding",
        }))

        const session = await Session.create({})
        const messageID = await addUserMessage(session.id, "每次 commit 之前都要先跑 lint 再提交")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const experiences = await waitFor("experiences/**/*.md", base)
        expect(experiences.length).toBe(1)

        const doc = matter(await Filesystem.readText(experiences[0]!))
        expect(doc.data.kind).toBe("workflow_rule")
        expect(doc.data.title).toBe("提交前必须执行 lint")
        expect(doc.data.observations.length).toBe(1)
        expect(doc.data.refinement_history.length).toBe(0)
        expect(experiences[0]).toContain("/workflow_rule/")
      },
    })
  })

  test("attaches and re-refines when route says 'attach'; observations grow, refinement_history grows", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // First message: create
        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "首次引入",
          kind: "workflow_rule",
          title: "提交前必须执行 lint",
          abstract: "所有代码提交之前都必须先跑 lint 校验，以保证静态检查通过。",
          scope: "repo",
        }))

        const session = await Session.create({})
        const m1 = await addUserMessage(session.id, "commit 之前要先 lint")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID: m1 })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const initial = await waitFor("experiences/**/*.md", base)
        expect(initial.length).toBe(1)
        const initialDoc = matter(await Filesystem.readText(initial[0]!))
        const targetID = String(initialDoc.data.id)

        // Subsequent messages: attach + refine
        let refineCount = 0
        Refiner.setRouteOverrideForTest(async () => ({
          action: "attach",
          experience_id: targetID,
          reason: "与既有规则等价",
        }))
        Refiner.setRefineOverrideForTest(async () => {
          refineCount++
          return {
            kind: "workflow_rule",
            title: `提交前必须执行 lint v${refineCount + 1}`,
            abstract: `版本 ${refineCount + 1}: 所有代码提交前先执行 lint，纳入 CI 前的本地门禁步骤。`,
            scope: "repo",
          }
        })

        const m2 = await addUserMessage(session.id, "每次 commit 请记得先 lint")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID: m2 })

        // wait for refinement_history.length to become 1
        let doc = matter(await Filesystem.readText(initial[0]!))
        for (let i = 0; i < 60 && !(doc.data.refinement_history?.length >= 1); i++) {
          await new Promise((r) => setTimeout(r, 50))
          doc = matter(await Filesystem.readText(initial[0]!))
        }
        expect(doc.data.observations.length).toBe(2)
        expect(doc.data.refinement_history.length).toBe(1)

        const m3 = await addUserMessage(session.id, "commit 需要先跑 lint 再推")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID: m3 })

        for (let i = 0; i < 60 && doc.data.refinement_history?.length < 2; i++) {
          await new Promise((r) => setTimeout(r, 50))
          doc = matter(await Filesystem.readText(initial[0]!))
        }
        expect(doc.data.observations.length).toBe(3)
        expect(doc.data.refinement_history.length).toBe(2)
        expect(String(doc.data.abstract)).toContain("版本 3")
      },
    })
  })

  test("noise decisions append to rejected.ndjson and write no experience", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Refiner.setRouteOverrideForTest(async () => ({
          action: "noise",
          reason: "仅为礼貌性表达，无复用价值",
        }))

        const session = await Session.create({})
        const messageID = await addUserMessage(session.id, "谢谢你！")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")

        // Wait for rejected.ndjson to appear
        const rejectedPath = path.join(base, "rejected.ndjson")
        const start = Date.now()
        while (Date.now() - start < 3000) {
          if (await Filesystem.exists(rejectedPath)) break
          await new Promise((r) => setTimeout(r, 50))
        }
        expect(await Filesystem.exists(rejectedPath)).toBe(true)

        const rejectedText = await readFile(rejectedPath, "utf-8")
        expect(rejectedText.trim().length).toBeGreaterThan(0)
        const firstLine = JSON.parse(rejectedText.trim().split("\n")[0]!)
        expect(firstLine.stage).toBe("route")
        expect(firstLine.reason).toContain("礼貌")

        const experiences = await waitFor("experiences/**/*.md", base, 300)
        expect(experiences.length).toBe(0)
      },
    })
  })

  test("custom:<slug> kind is recorded in taxonomy.json with count", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "本地开发特有的环境加载步骤",
          kind: "custom:env-setup",
          title: "本地开发前需加载环境变量",
          abstract: "启动任何本地开发流程前，需先加载项目的环境变量文件，确保配置与运行态一致。",
          scope: "repo",
        }))

        const session = await Session.create({})
        const messageID = await addUserMessage(session.id, "开始前记得 source .env.local")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const files = await waitFor("experiences/**/*.md", base)
        expect(files.length).toBe(1)
        expect(files[0]).toContain("/custom_env-setup/")

        const taxonomyPath = path.join(base, "taxonomy.json")
        expect(await Filesystem.exists(taxonomyPath)).toBe(true)
        const taxonomy = JSON.parse(await readFile(taxonomyPath, "utf-8"))
        expect(taxonomy.custom["env-setup"]).toBeDefined()
        expect(taxonomy.custom["env-setup"].count).toBe(1)
        expect(taxonomy.custom["env-setup"].sample_experience_ids.length).toBeGreaterThan(0)

        const api = await Refiner.taxonomy()
        expect(api.core.some((k: { slug: string }) => k.slug === "workflow_rule")).toBe(true)
        expect(api.custom.some((c: { slug: string }) => c.slug === "env-setup")).toBe(true)
      },
    })
  })

  test("originality guard: abstract=raw on new creation is rejected to rejected.ndjson without writing experience", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rawText = "我希望你把整个中间的显示工具插件化不再固定diff的展示形式"
        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "表面看是新规则",
          kind: "know_how",
          title: "插件化显示工具",
          abstract: rawText, // identical to user_text → should trip originality guard
          scope: "repo",
        }))

        const session = await Session.create({})
        const messageID = await addUserMessage(session.id, rawText)
        await Refiner.observeUserMessage({ sessionID: session.id, messageID })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const rejectedPath = path.join(base, "rejected.ndjson")

        const start = Date.now()
        while (Date.now() - start < 3000) {
          if (await Filesystem.exists(rejectedPath)) break
          await new Promise((r) => setTimeout(r, 50))
        }
        expect(await Filesystem.exists(rejectedPath)).toBe(true)
        const rejected = await readFile(rejectedPath, "utf-8")
        expect(rejected).toContain("new_abstract_equals_raw")

        const experiences = await waitFor("experiences/**/*.md", base, 300)
        expect(experiences.length).toBe(0)
      },
    })
  })

  test("originality guard on attach: raw abstract after retry demotes to noise and does not mutate experience", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // First: create a legit experience
        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "首次",
          kind: "workflow_rule",
          title: "提交前必须跑 lint",
          abstract: "代码提交前需要先执行 lint 校验，确保通过静态检查。",
          scope: "repo",
        }))
        const session = await Session.create({})
        const m1 = await addUserMessage(session.id, "commit 前 lint")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID: m1 })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const initial = await waitFor("experiences/**/*.md", base)
        const initialDoc = matter(await Filesystem.readText(initial[0]!))
        const targetID = String(initialDoc.data.id)
        const originalAbstract = String(initialDoc.data.abstract)
        const originalObsCount = (initialDoc.data.observations as unknown[]).length

        // Second: attach, but refine returns raw text
        const rawM2 = "每次 commit 都要先跑 lint 否则不让合并"
        Refiner.setRouteOverrideForTest(async () => ({
          action: "attach",
          experience_id: targetID,
          reason: "与既有规则等价",
        }))
        Refiner.setRefineOverrideForTest(async () => ({
          kind: "workflow_rule",
          title: "提交前必须跑 lint",
          abstract: rawM2, // equal to incoming observation user_text → should trip guard on both retries
          scope: "repo",
        }))

        const m2 = await addUserMessage(session.id, rawM2)
        await Refiner.observeUserMessage({ sessionID: session.id, messageID: m2 })

        // Wait for rejection to be recorded
        const rejectedPath = path.join(base, "rejected.ndjson")
        const start = Date.now()
        while (Date.now() - start < 3000) {
          if (await Filesystem.exists(rejectedPath)) break
          await new Promise((r) => setTimeout(r, 50))
        }
        const rejectedText = await readFile(rejectedPath, "utf-8")
        expect(rejectedText).toContain("abstract_equals_raw_after_retry")

        // Experience file should be unchanged
        const afterDoc = matter(await Filesystem.readText(initial[0]!))
        expect(String(afterDoc.data.abstract)).toBe(originalAbstract)
        expect((afterDoc.data.observations as unknown[]).length).toBe(originalObsCount)
        expect((afterDoc.data.refinement_history as unknown[]).length).toBe(0)
      },
    })
  })

  test("overview endpoint returns graph with has_observation edges for each observation", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "新规则",
          kind: "workflow_rule",
          title: "提交前必须执行 lint",
          abstract: "所有代码在提交前必须先完成 lint 检查。",
          scope: "repo",
        }))

        const session = await Session.create({})
        const m1 = await addUserMessage(session.id, "commit 之前先 lint")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID: m1 })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        await waitFor("experiences/**/*.md", base)

        const overview = await Refiner.overview({})
        expect(overview.schema_version).toBe(2)
        expect(overview.experiences.length).toBe(1)
        expect(overview.status.total_experiences).toBe(1)
        expect(overview.status.total_observations).toBe(1)
        expect(overview.graph.edges.some((e) => e.kind === "has_observation")).toBe(true)
        expect(overview.graph.nodes.some((n) => n.type === "experience")).toBe(true)
        expect(overview.graph.nodes.some((n) => n.type === "observation")).toBe(true)
      },
    })
  })

  test("branching observation creates a second experience with distinct id and kind", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "第一条:流程规则",
          kind: "workflow_rule",
          title: "提交前必须跑 lint",
          abstract: "在提交代码前必须先运行 lint 校验。",
          scope: "repo",
        }))
        const session = await Session.create({})
        const m1 = await addUserMessage(session.id, "commit 前 lint")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID: m1 })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const first = await waitFor("experiences/**/*.md", base)
        expect(first.length).toBe(1)

        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "第二条:领域知识,完全不相关",
          kind: "domain_knowledge",
          title: "Q3 季度的口径定义",
          abstract: "Q3 在本项目语境中指 7 月到 9 月这三个自然月。",
          scope: "project",
        }))
        const m2 = await addUserMessage(session.id, "我们说的 Q3 是 7-9 月")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID: m2 })

        const all = await waitForCount("experiences/**/*.md", base, 2)
        expect(all.length).toBe(2)

        const doc1 = matter(await Filesystem.readText(all[0]!))
        const doc2 = matter(await Filesystem.readText(all[1]!))
        expect(doc1.data.id).not.toBe(doc2.data.id)
        expect(doc1.data.kind).not.toBe(doc2.data.kind)
      },
    })
  })

  test("captures workflow_snapshot in observation when session is bound to a workflow", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Refiner.setRouteOverrideForTest(async () => ({
          action: "new",
          reason: "流程缺口",
          kind: "workflow_gap",
          title: "交付阶段需接入 gerrit 与 jenkins",
          abstract: "交付类工作流需显式纳入推送到 gerrit 与触发 jenkins 构建验证的步骤。",
          scope: "repo",
          task_type: "delivery",
        }))

        const session = await Session.create({})
        await Workflow.create({
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

        const messageID = await addUserMessage(
          session.id,
          "修改后帮我推送到 gerrit 并在 jenkins 上跑构建验证",
        )
        await Refiner.observeUserMessage({ sessionID: session.id, messageID })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const files = await waitFor("experiences/**/*.md", base)
        expect(files.length).toBe(1)
        const doc = matter(await Filesystem.readText(files[0]!))
        const obs = (doc.data.observations as any[])[0]
        expect(obs.agent_context.workflow_snapshot).toBeDefined()
        expect(obs.agent_context.workflow_snapshot.node_id).toBeDefined()
      },
    })
  })

  // A single user message can contain several independent reusable ideas.
  // The route LLM (mocked here) emits an array of decisions and the runtime
  // must create / attach / reject each one independently. This guards the
  // schema upgrade from single-decision to {decisions: [...]}.
  test("fans out a single message into multiple experiences when route returns an array", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Refiner.setRouteOverrideForTest(async () => [
          {
            action: "new",
            reason: "规则 A",
            kind: "workflow_rule",
            title: "提交前必须执行 lint",
            abstract: "提交代码前必须先跑 lint 校验再推送。",
            scope: "repo",
          },
          {
            action: "new",
            reason: "规则 B",
            kind: "constraint_or_policy",
            title: "UI 文案禁用 emoji",
            abstract: "所有用户可见的界面文案均不允许使用 emoji 字符。",
            scope: "project",
          },
          {
            action: "noise",
            reason: "礼貌性结尾",
          },
        ])

        const session = await Session.create({})
        const messageID = await addUserMessage(
          session.id,
          "帮忙改下：commit 前要跑 lint；UI 文字别用 emoji。辛苦啦",
        )
        await Refiner.observeUserMessage({ sessionID: session.id, messageID })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const files = await waitForCount("experiences/**/*.md", base, 2)
        expect(files.length).toBe(2)
        const kinds = await Promise.all(
          files.map(async (f) => String(matter(await Filesystem.readText(f)).data.kind)),
        )
        expect(kinds.sort()).toEqual(["constraint_or_policy", "workflow_rule"])

        const rejectedPath = path.join(base, "rejected.ndjson")
        const rejected = await readFile(rejectedPath, "utf8").catch(() => "")
        expect(rejected.split("\n").filter(Boolean).length).toBe(1)
      },
    })
  })

  // When the array contains duplicates, attachAndRefine / createExperience
  // must be called only once per target. A chatty model shouldn't double-
  // apply.
  test("dedupes repeated decisions in the same fan-out", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Refiner.setRouteOverrideForTest(async () => [
          {
            action: "new",
            reason: "A",
            kind: "know_how",
            title: "跑测试的正确姿势",
            abstract: "使用 bun test 并加 30 秒超时以避免 flaky 案例卡死。",
            scope: "repo",
          },
          {
            action: "new",
            reason: "A-dup",
            kind: "know_how",
            title: "跑测试的正确姿势",
            abstract: "同上。",
            scope: "repo",
          },
        ])

        const session = await Session.create({})
        const messageID = await addUserMessage(session.id, "bun test --timeout 30000")
        await Refiner.observeUserMessage({ sessionID: session.id, messageID })

        const base = path.join(tmp.path, ".opencode", "refiner-memory")
        const files = await waitFor("experiences/**/*.md", base)
        expect(files.length).toBe(1)
      },
    })
  })
})
