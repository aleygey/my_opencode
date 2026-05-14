/**
 * Automation page — manages scheduled tasks ("定时发布任务").
 *
 * Each task carries a cron / interval expression + an orchestrator prompt;
 * the backend scheduler fires the prompt into a freshly-created worktree
 * session on every tick. This page is the user-facing CRUD surface.
 *
 * Backend contract: see `packages/opencode/src/server/routes/instance/
 * automation.ts` for the HTTP shape this page consumes.
 */
import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import "./automation-page.css"

type ScheduleType = "cron" | "interval"
type TaskStatus = "idle" | "running" | "error" | "disabled"
type RunStatus = "running" | "completed" | "failed" | "skipped" | "timeout"

type Task = {
  id: string
  name: string
  type: ScheduleType
  expression: string
  prompt: string
  agent: string
  model?: { providerID?: string; modelID?: string; variant?: string } | null
  worktree_prefix?: string | null
  enabled: boolean
  status: TaskStatus
  last_run_at?: number | null
  error_message?: string | null
  consecutive_failures: number
  max_consecutive_failures: number
  max_retention: number
  time_created: number
  time_updated: number
}

type Run = {
  id: string
  task_id: string
  session_id?: string | null
  workflow_id?: string | null
  worktree_name?: string | null
  worktree_directory?: string | null
  worktree_branch?: string | null
  status: RunStatus
  error_message?: string | null
  started_at?: number | null
  finished_at?: number | null
  time_created: number
  time_updated: number
}

type ApiBase = {
  baseUrl: string
  directory: string
  password?: string
  username?: string
  fetcher?: typeof fetch
}

function buildHeaders(input: {
  directory: string
  username?: string
  password?: string
  json?: boolean
}) {
  const headers: Record<string, string> = {
    "x-opencode-directory": encodeURIComponent(input.directory),
  }
  if (input.json) headers["content-type"] = "application/json"
  if (input.password) {
    headers.Authorization = `Basic ${btoa(`${input.username ?? "opencode"}:${input.password}`)}`
  }
  return headers
}

async function call<T = unknown>(
  base: ApiBase,
  path: string,
  init: { method?: string; json?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const url = new URL(path, base.baseUrl)
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === null || v === "") continue
      url.searchParams.set(k, String(v))
    }
  }
  const res = await (base.fetcher ?? fetch)(url, {
    method: init.method ?? "GET",
    headers: buildHeaders({
      directory: base.directory,
      password: base.password,
      username: base.username,
      json: init.json !== undefined,
    }),
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })
  if (!res.ok) {
    let detail = ""
    try {
      const body = await res.text()
      detail = body ? `: ${body.slice(0, 300)}` : ""
    } catch {}
    throw new Error(`Automation request ${path} failed (${res.status})${detail}`)
  }
  const ctype = res.headers.get("content-type") ?? ""
  if (!ctype.includes("application/json")) {
    // Likely the SPA fallback — backend route not loaded (binary needs rebuild).
    const body = await res.text().catch(() => "")
    throw new Error(
      `Automation endpoint ${path} did not return JSON (got "${ctype}"). ` +
        `Backend may need a restart. Response: ${body.slice(0, 120)}`,
    )
  }
  return (await res.json()) as T
}

function fmtTime(ms?: number | null) {
  if (!ms) return "—"
  const d = new Date(ms)
  const now = Date.now()
  const diff = now - ms
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function statusBadge(status: TaskStatus) {
  const label =
    status === "idle"
      ? "空闲"
      : status === "running"
        ? "执行中"
        : status === "error"
          ? "失败"
          : "已停用"
  return (
    <span class="auto-badge" data-status={status}>
      {label}
    </span>
  )
}

function runStatusBadge(status: RunStatus) {
  const label =
    status === "running"
      ? "执行中"
      : status === "completed"
        ? "完成"
        : status === "failed"
          ? "失败"
          : status === "skipped"
            ? "跳过"
            : "超时"
  return (
    <span class="auto-badge" data-run-status={status}>
      {label}
    </span>
  )
}

type FormState = {
  name: string
  type: ScheduleType
  expression: string
  prompt: string
  agent: string
  worktree_prefix: string
  enabled: boolean
  max_retention: number
  max_consecutive_failures: number
}

function emptyForm(): FormState {
  return {
    name: "",
    type: "cron",
    expression: "0 9 * * *",
    prompt: "",
    agent: "orchestrator",
    worktree_prefix: "",
    enabled: true,
    max_retention: 20,
    max_consecutive_failures: 3,
  }
}

export default function AutomationPage() {
  const params = useParams<{ id?: string }>()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()

  const apiBase = createMemo<ApiBase | undefined>(() => {
    const current = server.current
    if (!current) return
    return {
      baseUrl: current.http.url,
      directory: sdk.directory,
      password: current.http.password,
      username: current.http.username,
      fetcher: platform.fetch,
    }
  })

  const [refreshTick, setRefreshTick] = createSignal(0)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [tasks] = createResource(
    () => [refreshTick(), apiBase()] as const,
    async ([, b]) => {
      if (!b) return [] as Task[]
      // Catch missing-route / unreachable-backend errors so the page renders
      // an actionable banner instead of crashing into the global React error
      // boundary. This is the path that triggers immediately after a fresh
      // build before the binary has loaded the new `/automation/*` routes.
      try {
        const result = await call<Task[]>(b, "/automation/task")
        setLoadError(null)
        return result
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err))
        return [] as Task[]
      }
    },
  )

  // ---------------------------------------------------------------------------
  // Form state — modal-style create/edit panel
  // ---------------------------------------------------------------------------
  const [editing, setEditing] = createSignal<Task | null>(null)
  const [showForm, setShowForm] = createSignal(false)
  const [form, setForm] = createSignal<FormState>(emptyForm())
  const [formError, setFormError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  function openCreate() {
    setEditing(null)
    setForm(emptyForm())
    setFormError(null)
    setShowForm(true)
  }
  function openEdit(t: Task) {
    setEditing(t)
    setForm({
      name: t.name,
      type: t.type,
      expression: t.expression,
      prompt: t.prompt,
      agent: t.agent,
      worktree_prefix: t.worktree_prefix ?? "",
      enabled: t.enabled,
      max_retention: t.max_retention,
      max_consecutive_failures: t.max_consecutive_failures,
    })
    setFormError(null)
    setShowForm(true)
  }
  function closeForm() {
    setShowForm(false)
    setEditing(null)
    setFormError(null)
  }

  async function submitForm() {
    const b = apiBase()
    if (!b) return
    const f = form()
    if (!f.name.trim()) return setFormError("请填写任务名称")
    if (!f.expression.trim()) return setFormError("请填写调度表达式")
    if (!f.prompt.trim()) return setFormError("请填写 prompt")
    setBusy(true)
    setFormError(null)
    try {
      const body = {
        name: f.name.trim(),
        type: f.type,
        expression: f.expression.trim(),
        prompt: f.prompt,
        agent: f.agent.trim() || "orchestrator",
        worktree_prefix: f.worktree_prefix.trim() || undefined,
        enabled: f.enabled,
        max_retention: f.max_retention,
        max_consecutive_failures: f.max_consecutive_failures,
      }
      const target = editing()
      if (target) {
        await call<Task>(b, `/automation/task/${target.id}`, { method: "PATCH", json: body })
      } else {
        await call<Task>(b, "/automation/task", { method: "POST", json: body })
      }
      setRefreshTick((n) => n + 1)
      closeForm()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function deleteTask(t: Task) {
    const b = apiBase()
    if (!b) return
    if (!window.confirm(`确认删除任务「${t.name}」？历史运行记录也会一并清理。`)) return
    try {
      await call<boolean>(b, `/automation/task/${t.id}`, { method: "DELETE" })
      setRefreshTick((n) => n + 1)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function toggleTask(t: Task) {
    const b = apiBase()
    if (!b) return
    try {
      await call<Task>(b, `/automation/task/${t.id}/toggle`, { method: "POST" })
      setRefreshTick((n) => n + 1)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  async function triggerNow(t: Task) {
    const b = apiBase()
    if (!b) return
    try {
      const result = await call<{ runID: string; status: string; error?: string }>(b, `/automation/task/${t.id}/trigger`, {
        method: "POST",
      })
      if (result.error) window.alert(`运行失败：${result.error}`)
      setRefreshTick((n) => n + 1)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  // ---------------------------------------------------------------------------
  // Run history panel — expandable per-task
  // ---------------------------------------------------------------------------
  const [historyOpenId, setHistoryOpenId] = createSignal<string | null>(null)
  const [runs] = createResource(
    () => [historyOpenId(), refreshTick(), apiBase()] as const,
    async ([id, , b]) => {
      if (!id || !b) return [] as Run[]
      try {
        return await call<Run[]>(b, "/automation/run", { query: { task_id: id, limit: 10 } })
      } catch {
        return [] as Run[]
      }
    },
  )

  // Auto-refresh every 15s so running tasks update their last_run_at without
  // forcing the user to refresh the page.
  onMount(() => {
    const t = window.setInterval(() => setRefreshTick((n) => n + 1), 15_000)
    return () => window.clearInterval(t)
  })

  return (
    <div class="auto-page">
      <header class="auto-header">
        <div>
          <h1 class="auto-title">定时任务</h1>
          <p class="auto-subtitle">
            按 cron / 固定间隔自动派发 orchestrator 任务。每次触发会创建独立 worktree + session 执行。
          </p>
        </div>
        <button class="auto-btn auto-btn--primary" onClick={openCreate}>
          + 新建任务
        </button>
      </header>

      <Show when={loadError()}>
        <div class="auto-form-error" style="margin-bottom: 16px;">
          后端 API 不可用：{loadError()}
          <div style="margin-top: 4px; font-size: 11px; opacity: 0.8;">
            一般是 opencode 二进制还没加载新路由——重建固件并重启后端即可恢复。
          </div>
        </div>
      </Show>

      <Show
        when={!tasks.loading}
        fallback={<div class="auto-empty">加载中…</div>}
      >
        <Show when={tasks() && tasks()!.length > 0} fallback={<div class="auto-empty">还没有定时任务。点右上角「新建任务」开始。</div>}>
          <table class="auto-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>调度</th>
                <th>状态</th>
                <th>上次运行</th>
                <th>失败计数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <For each={tasks()}>
                {(t) => (
                  <>
                    <tr class="auto-row" data-disabled={!t.enabled}>
                      <td>
                        <button class="auto-row-name" onClick={() => openEdit(t)} title="编辑任务">
                          {t.name}
                        </button>
                        <div class="auto-row-prompt" title={t.prompt}>
                          {t.prompt.slice(0, 80)}{t.prompt.length > 80 ? "…" : ""}
                        </div>
                      </td>
                      <td>
                        <code class="auto-expr">
                          {t.type === "cron" ? "cron" : "间隔"} · {t.expression}
                        </code>
                      </td>
                      <td>{statusBadge(t.status)}</td>
                      <td title={t.last_run_at ? new Date(t.last_run_at).toLocaleString() : ""}>
                        {fmtTime(t.last_run_at)}
                      </td>
                      <td>
                        <span class={t.consecutive_failures > 0 ? "auto-fail-count" : ""}>
                          {t.consecutive_failures} / {t.max_consecutive_failures}
                        </span>
                      </td>
                      <td>
                        <div class="auto-row-actions">
                          <button class="auto-btn auto-btn--sm" onClick={() => triggerNow(t)} title="立即运行一次">
                            ▶
                          </button>
                          <button class="auto-btn auto-btn--sm" onClick={() => toggleTask(t)} title={t.enabled ? "停用" : "启用"}>
                            {t.enabled ? "⏸" : "✓"}
                          </button>
                          <button
                            class="auto-btn auto-btn--sm"
                            onClick={() => setHistoryOpenId(historyOpenId() === t.id ? null : t.id)}
                            title="历史运行"
                          >
                            历史
                          </button>
                          <button class="auto-btn auto-btn--sm auto-btn--danger" onClick={() => deleteTask(t)} title="删除">
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                    <Show when={historyOpenId() === t.id}>
                      <tr class="auto-history-row">
                        <td colspan={6}>
                          <Show
                            when={!runs.loading}
                            fallback={<div class="auto-empty auto-empty--sm">加载历史…</div>}
                          >
                            <Show
                              when={runs() && runs()!.length > 0}
                              fallback={<div class="auto-empty auto-empty--sm">还没有运行记录。</div>}
                            >
                              <table class="auto-runs">
                                <thead>
                                  <tr>
                                    <th>状态</th>
                                    <th>开始</th>
                                    <th>结束</th>
                                    <th>Session</th>
                                    <th>Worktree</th>
                                    <th>错误</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <For each={runs()}>
                                    {(r) => (
                                      <tr>
                                        <td>{runStatusBadge(r.status)}</td>
                                        <td>{fmtTime(r.started_at)}</td>
                                        <td>{fmtTime(r.finished_at)}</td>
                                        <td>
                                          <Show when={r.session_id} fallback={<span class="auto-dim">—</span>}>
                                            <code class="auto-mono" title={r.session_id ?? ""}>
                                              {r.session_id?.slice(0, 16)}…
                                            </code>
                                          </Show>
                                        </td>
                                        <td>
                                          <Show when={r.worktree_name} fallback={<span class="auto-dim">—</span>}>
                                            <code class="auto-mono">{r.worktree_name}</code>
                                          </Show>
                                        </td>
                                        <td class="auto-error" title={r.error_message ?? ""}>
                                          {r.error_message ? r.error_message.slice(0, 80) + (r.error_message.length > 80 ? "…" : "") : ""}
                                        </td>
                                      </tr>
                                    )}
                                  </For>
                                </tbody>
                              </table>
                            </Show>
                          </Show>
                        </td>
                      </tr>
                    </Show>
                  </>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Show>

      <Show when={showForm()}>
        <div class="auto-modal-backdrop" onClick={closeForm}>
          <div class="auto-modal" onClick={(e) => e.stopPropagation()}>
            <div class="auto-modal-header">
              <h2>{editing() ? `编辑任务 · ${editing()!.name}` : "新建定时任务"}</h2>
              <button class="auto-btn auto-btn--sm" onClick={closeForm}>
                ✕
              </button>
            </div>
            <div class="auto-modal-body">
              <label class="auto-field">
                <span>任务名称</span>
                <input
                  type="text"
                  value={form().name}
                  onInput={(e) => setForm({ ...form(), name: e.currentTarget.value })}
                  placeholder="例如：每天 9 点拉取行情"
                />
              </label>

              <div class="auto-field-row">
                <label class="auto-field">
                  <span>调度类型</span>
                  <select
                    value={form().type}
                    onChange={(e) => setForm({ ...form(), type: e.currentTarget.value as ScheduleType })}
                  >
                    <option value="cron">Cron 表达式</option>
                    <option value="interval">固定间隔 (ms)</option>
                  </select>
                </label>
                <label class="auto-field auto-field--grow">
                  <span>
                    {form().type === "cron" ? "Cron 表达式" : "间隔毫秒数"}
                  </span>
                  <input
                    type="text"
                    value={form().expression}
                    onInput={(e) => setForm({ ...form(), expression: e.currentTarget.value })}
                    placeholder={form().type === "cron" ? "0 9 * * * （每天 9:00）" : "3600000 （每小时）"}
                  />
                </label>
              </div>

              <label class="auto-field">
                <span>Prompt（发给 orchestrator 的任务描述）</span>
                <textarea
                  rows={6}
                  value={form().prompt}
                  onInput={(e) => setForm({ ...form(), prompt: e.currentTarget.value })}
                  placeholder="例如：拉取今日股价并生成日报到 reports/ 目录..."
                />
              </label>

              <div class="auto-field-row">
                <label class="auto-field">
                  <span>Agent</span>
                  <input
                    type="text"
                    value={form().agent}
                    onInput={(e) => setForm({ ...form(), agent: e.currentTarget.value })}
                    placeholder="orchestrator"
                  />
                </label>
                <label class="auto-field">
                  <span>Worktree 前缀（可选）</span>
                  <input
                    type="text"
                    value={form().worktree_prefix}
                    onInput={(e) => setForm({ ...form(), worktree_prefix: e.currentTarget.value })}
                    placeholder="留空则用任务名"
                  />
                </label>
              </div>

              <div class="auto-field-row">
                <label class="auto-field">
                  <span>历史保留条数</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={form().max_retention}
                    onInput={(e) =>
                      setForm({ ...form(), max_retention: parseInt(e.currentTarget.value, 10) || 20 })
                    }
                  />
                </label>
                <label class="auto-field">
                  <span>连续失败上限（自动停用）</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={form().max_consecutive_failures}
                    onInput={(e) =>
                      setForm({ ...form(), max_consecutive_failures: parseInt(e.currentTarget.value, 10) || 3 })
                    }
                  />
                </label>
                <label class="auto-field auto-field--check">
                  <input
                    type="checkbox"
                    checked={form().enabled}
                    onChange={(e) => setForm({ ...form(), enabled: e.currentTarget.checked })}
                  />
                  <span>立即启用</span>
                </label>
              </div>

              <Show when={formError()}>
                <div class="auto-form-error">{formError()}</div>
              </Show>
            </div>
            <div class="auto-modal-footer">
              <button class="auto-btn" onClick={closeForm} disabled={busy()}>
                取消
              </button>
              <button class="auto-btn auto-btn--primary" onClick={submitForm} disabled={busy()}>
                {busy() ? "保存中…" : editing() ? "保存修改" : "创建任务"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
