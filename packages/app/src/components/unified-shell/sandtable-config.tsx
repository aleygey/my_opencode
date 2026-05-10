/**
 * Sand-table config dialog.
 *
 * Surfaces `experimental.sand_table.{planner_model, evaluator_model,
 * planner_agent, evaluator_agent, max_rounds}` so the user can pick
 * which agent + model the planner / evaluator roles use BEFORE the
 * orchestrator triggers a `sand_table` tool call. Settings are
 * persisted server-side via PUT /experimental/sand_table/config and
 * applied on every subsequent invocation; the orchestrator can still
 * override per-call by passing `models` in its tool args.
 *
 * Visual: portal-mounted modal with a scrim + a centred form panel.
 * Form rows: Role (planner/evaluator) × Agent + Model. Each row
 * includes a "fallback" hint so the user understands the inheritance
 * rules (evaluator falls back to planner; planner falls back to the
 * orchestrator's currently-active model).
 */

import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useModels } from "@/context/models"
import { useLocal } from "@/context/local"
import { useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import "./sandtable-config.css"

type Assignment = { providerID: string; modelID: string }
type SandTableConfig = {
  planner_model?: Assignment
  evaluator_model?: Assignment
  planner_agent?: string
  evaluator_agent?: string
  max_rounds?: number
  /* When set, every sand_table tool call pauses with
   * status="awaiting_start" and waits for the inspector's
   * confirm-and-start UI before running rounds. Off by default to
   * preserve the legacy "agent calls sand_table → run immediately"
   * behaviour. */
  confirm_before_start?: boolean
}

async function fetchConfig(input: {
  baseUrl: string
  fetcher?: typeof fetch
  password?: string
  username?: string
}): Promise<SandTableConfig> {
  const url = new URL("/experimental/sand_table/config", input.baseUrl)
  const headers: Record<string, string> = {}
  if (input.password) {
    headers.Authorization = `Basic ${btoa(`${input.username ?? "opencode"}:${input.password}`)}`
  }
  const res = await (input.fetcher ?? fetch)(url, { headers })
  if (!res.ok) return {}
  return (await res.json()) as SandTableConfig
}

async function saveConfig(input: {
  baseUrl: string
  body: Record<string, unknown>
  fetcher?: typeof fetch
  password?: string
  username?: string
}): Promise<SandTableConfig> {
  const url = new URL("/experimental/sand_table/config", input.baseUrl)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (input.password) {
    headers.Authorization = `Basic ${btoa(`${input.username ?? "opencode"}:${input.password}`)}`
  }
  const res = await (input.fetcher ?? fetch)(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(input.body),
  })
  if (!res.ok) throw new Error(`save failed: ${res.status}`)
  return (await res.json()) as SandTableConfig
}

export function SandTableConfigDialog(props: { onClose: () => void }) {
  const server = useServer()
  const _sdk = useSDK()
  const platform = usePlatform()
  const models = useModels()
  const local = useLocal()

  // Pre-fetch the persisted config so the form starts populated.
  const fetchArgs = () => {
    const current = server.current
    if (!current) return undefined
    return {
      baseUrl: current.http.url,
      fetcher: platform.fetch,
      password: current.http.password,
      username: current.http.username,
    }
  }
  const [cfg, { mutate: setCfg, refetch }] = createResource(fetchArgs, fetchConfig)

  // Local form state — initialised from the server config when it loads.
  const [plannerAgent, setPlannerAgent] = createSignal<string>("")
  const [evaluatorAgent, setEvaluatorAgent] = createSignal<string>("")
  const [plannerModel, setPlannerModel] = createSignal<string>("")
  const [evaluatorModel, setEvaluatorModel] = createSignal<string>("")
  const [maxRounds, setMaxRounds] = createSignal<string>("")
  const [confirmBeforeStart, setConfirmBeforeStart] = createSignal<boolean>(false)

  // Sync the form fields whenever the resource resolves.
  let synced = false
  const syncFromCfg = () => {
    if (synced) return
    const c = cfg()
    if (!c) return
    synced = true
    setPlannerAgent(c.planner_agent ?? "")
    setEvaluatorAgent(c.evaluator_agent ?? "")
    setPlannerModel(c.planner_model ? `${c.planner_model.providerID}/${c.planner_model.modelID}` : "")
    setEvaluatorModel(c.evaluator_model ? `${c.evaluator_model.providerID}/${c.evaluator_model.modelID}` : "")
    setMaxRounds(c.max_rounds ? String(c.max_rounds) : "")
    setConfirmBeforeStart(!!c.confirm_before_start)
  }

  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()

  // ESC closes the dialog.
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener("keydown", handler, true)
    onCleanup(() => window.removeEventListener("keydown", handler, true))
  })

  // Eligible primary agents (orchestrator + custom user agents) — same
  // filter as the workflow root agent picker.
  const agentOptions = createMemo(() => {
    try {
      return local.agent
        .list()
        .filter((a: { mode?: string; hidden?: boolean }) => a.mode !== "subagent" && a.hidden !== true)
        .map((a: { name: string; description?: string }) => ({ name: a.name, description: a.description }))
    } catch {
      return []
    }
  })

  // Visible models, grouped by provider for the <select>.
  const modelGroups = createMemo(() => {
    try {
      const list = models
        .list()
        .filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
      const groups = new Map<string, Array<{ key: string; name: string; providerID: string; modelID: string }>>()
      for (const m of list) {
        const provider = m.provider.name ?? m.provider.id
        const arr = groups.get(provider) ?? []
        arr.push({
          key: `${m.provider.id}/${m.id}`,
          name: m.name,
          providerID: m.provider.id,
          modelID: m.id,
        })
        groups.set(provider, arr)
      }
      return [...groups.entries()]
    } catch {
      return []
    }
  })

  const handleSave = async () => {
    const current = server.current
    if (!current) return
    setSaving(true)
    setError(undefined)
    try {
      // Build PATCH body — null clears, undefined leaves, value sets.
      const splitModel = (v: string): Assignment | null => {
        if (!v) return null
        const slash = v.indexOf("/")
        if (slash < 0) return null
        return {
          providerID: v.slice(0, slash),
          modelID: v.slice(slash + 1),
        }
      }
      const body: Record<string, unknown> = {
        planner_agent: plannerAgent() ? plannerAgent() : null,
        evaluator_agent: evaluatorAgent() ? evaluatorAgent() : null,
        planner_model: splitModel(plannerModel()),
        evaluator_model: splitModel(evaluatorModel()),
        max_rounds: maxRounds() ? Number(maxRounds()) : null,
        confirm_before_start: confirmBeforeStart(),
      }
      const updated = await saveConfig({
        baseUrl: current.http.url,
        body,
        fetcher: platform.fetch,
        password: current.http.password,
        username: current.http.username,
      })
      setCfg(updated)
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Portal>
      <div class="rune-stcfg-scrim" role="presentation" onClick={props.onClose}>
        <div
          class="rune-stcfg-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Sand-table config"
          onClick={(ev) => ev.stopPropagation()}
        >
          <div class="rune-stcfg-hd">
            <span class="rune-stcfg-title">Sand-table · agent / model</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              class="rune-stcfg-close"
              aria-label="Close"
              onClick={props.onClose}
            >
              ×
            </button>
          </div>

          <Show when={!cfg.loading} fallback={<div class="rune-stcfg-empty">读取中…</div>}>
            {(() => {
              syncFromCfg()
              return null
            })()}
            <div class="rune-stcfg-body">
              <p class="rune-stcfg-hint">
                每个角色独立配置 agent + model。留空表示沿用默认（planner →
                orchestrator 当前模型；evaluator → planner）。orchestrator 在
                tool 调用时仍可显式覆盖。
              </p>

              {/* Planner row */}
              <fieldset class="rune-stcfg-row">
                <legend>Planner</legend>
                <label class="rune-stcfg-field">
                  <span>Agent</span>
                  <select
                    value={plannerAgent()}
                    onChange={(e) => setPlannerAgent(e.currentTarget.value)}
                  >
                    <option value="">默认 (sandtable)</option>
                    <For each={agentOptions()}>
                      {(a) => <option value={a.name}>{a.name}</option>}
                    </For>
                  </select>
                </label>
                <label class="rune-stcfg-field">
                  <span>Model</span>
                  <select
                    value={plannerModel()}
                    onChange={(e) => setPlannerModel(e.currentTarget.value)}
                  >
                    <option value="">默认 (orchestrator current)</option>
                    <For each={modelGroups()}>
                      {([provider, items]) => (
                        <optgroup label={provider}>
                          <For each={items}>
                            {(m) => <option value={m.key}>{m.name}</option>}
                          </For>
                        </optgroup>
                      )}
                    </For>
                  </select>
                </label>
              </fieldset>

              {/* Evaluator row */}
              <fieldset class="rune-stcfg-row">
                <legend>Evaluator</legend>
                <label class="rune-stcfg-field">
                  <span>Agent</span>
                  <select
                    value={evaluatorAgent()}
                    onChange={(e) => setEvaluatorAgent(e.currentTarget.value)}
                  >
                    <option value="">默认 (sandtable)</option>
                    <For each={agentOptions()}>
                      {(a) => <option value={a.name}>{a.name}</option>}
                    </For>
                  </select>
                </label>
                <label class="rune-stcfg-field">
                  <span>Model</span>
                  <select
                    value={evaluatorModel()}
                    onChange={(e) => setEvaluatorModel(e.currentTarget.value)}
                  >
                    <option value="">沿用 planner</option>
                    <For each={modelGroups()}>
                      {([provider, items]) => (
                        <optgroup label={provider}>
                          <For each={items}>
                            {(m) => <option value={m.key}>{m.name}</option>}
                          </For>
                        </optgroup>
                      )}
                    </For>
                  </select>
                </label>
              </fieldset>

              {/* Max rounds */}
              <fieldset class="rune-stcfg-row">
                <legend>Max rounds</legend>
                <label class="rune-stcfg-field">
                  <span>Rounds</span>
                  <select
                    value={maxRounds()}
                    onChange={(e) => setMaxRounds(e.currentTarget.value)}
                  >
                    <option value="">默认 (3)</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5">5</option>
                  </select>
                </label>
              </fieldset>

              {/* Pre-start confirmation toggle */}
              <fieldset class="rune-stcfg-row">
                <legend>Pre-confirm</legend>
                <label class="rune-stcfg-field rune-stcfg-toggle">
                  <input
                    type="checkbox"
                    checked={confirmBeforeStart()}
                    onChange={(e) => setConfirmBeforeStart(e.currentTarget.checked)}
                  />
                  <span class="rune-stcfg-toggle-text">
                    每次 sand_table 调用先暂停，等待在 inspector 确认 agent /
                    model 后再执行
                  </span>
                </label>
              </fieldset>

              <Show when={error()}>
                <div class="rune-stcfg-err">⚠ {error()}</div>
              </Show>
            </div>
            <div class="rune-stcfg-foot">
              <button type="button" class="rune-btn" data-size="sm" onClick={() => void refetch()}>
                ↻ 刷新
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" class="rune-btn" data-size="sm" onClick={props.onClose}>
                取消
              </button>
              <button
                type="button"
                class="rune-btn"
                data-size="sm"
                data-variant="primary"
                disabled={saving()}
                onClick={() => void handleSave()}
              >
                {saving() ? "保存中…" : "保存"}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  )
}
