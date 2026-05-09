/**
 * RuneModelPicker — unified model selector for all three runtime modules
 * (refiner / workflow / retrieve).
 *
 * Each module previously rolled its own popover (rf-model-*, rt-pop-*, etc.)
 * with subtly different visuals. This is the single component that all three
 * now consume so the design language stays coherent.
 *
 * Visual contract: pixel/rune trigger button + portaled menu using --rune-*
 * tokens. The trigger is a neutral surface chip with a leading dot and a
 * trailing chevron; the menu is a fixed-position panel anchored to the
 * trigger via getBoundingClientRect, so it never gets clipped by parent
 * overflow / stacking contexts.
 */

import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useModels } from "@/context/models"
import "./model-picker.css"

export type ModelPickerSource = "override" | "agent" | "default" | "none"

const SOURCE_LABEL: Record<ModelPickerSource, string> = {
  override: "OVERRIDE",
  agent: "AGENT",
  default: "DEFAULT",
  none: "NONE",
}

function defaultModelLabel(model?: { providerID: string; modelID: string }) {
  if (!model) return "未配置"
  return `${model.providerID}/${model.modelID}`
}

export function RuneModelPicker(props: {
  current?: { providerID: string; modelID: string }
  source?: ModelPickerSource
  busy?: boolean
  /** When true, shows the "kicker" prefix (e.g. "MODEL"). */
  kicker?: string
  /** Custom label renderer; default is `${providerID}/${modelID}`. */
  formatLabel?: (model?: { providerID: string; modelID: string }) => string
  onChange: (model: { providerID: string; modelID: string }) => void
  /** Optional reset action — only shown when `source === "override"`. */
  onReset?: () => void
  /** Optional class added to the trigger wrapper. */
  class?: string
}) {
  const models = useModels()
  const [open, setOpen] = createSignal(false)
  const [coords, setCoords] = createSignal<{
    top: number
    right: number
    minWidth: number
  }>({ top: 0, right: 0, minWidth: 240 })
  let trigger: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined

  const reposition = () => {
    if (!trigger) return
    const r = trigger.getBoundingClientRect()
    setCoords({
      top: r.bottom + 6,
      right: Math.max(8, window.innerWidth - r.right),
      minWidth: Math.max(240, r.width),
    })
  }

  onMount(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open()) return
      const t = e.target as Node
      if (trigger?.contains(t)) return
      if (menu?.contains(t)) return
      setOpen(false)
    }
    const onResize = () => {
      if (open()) reposition()
    }
    const onScroll = (e: Event) => {
      if (!open()) return
      // Close on scroll outside the menu so the menu doesn't drift.
      if (menu && menu.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    window.addEventListener("resize", onResize)
    window.addEventListener("scroll", onScroll, true)
    onCleanup(() => {
      document.removeEventListener("mousedown", onDoc)
      window.removeEventListener("resize", onResize)
      window.removeEventListener("scroll", onScroll, true)
    })
  })

  const list = createMemo(() => {
    try {
      return models
        .list()
        .filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
    } catch {
      return []
    }
  })

  const grouped = createMemo(() => {
    const map = new Map<
      string,
      Array<{ providerID: string; modelID: string; name: string }>
    >()
    for (const m of list()) {
      const key = m.provider.name ?? m.provider.id
      const arr = map.get(key) ?? []
      arr.push({ providerID: m.provider.id, modelID: m.id, name: m.name })
      map.set(key, arr)
    }
    return [...map.entries()]
  })

  const labelFor = (m?: { providerID: string; modelID: string }) =>
    props.formatLabel ? props.formatLabel(m) : defaultModelLabel(m)

  const source = () => props.source ?? "none"

  const toggle = () => {
    const next = !open()
    if (next) reposition()
    setOpen(next)
  }

  return (
    <>
      <button
        ref={(el) => (trigger = el)}
        type="button"
        class={`rune-model-trigger${props.class ? " " + props.class : ""}`}
        aria-expanded={open() ? "true" : "false"}
        disabled={props.busy}
        title={`source: ${SOURCE_LABEL[source()]}`}
        onClick={toggle}
      >
        <span class="rune-model-dot" aria-hidden />
        <Show when={props.kicker}>
          <span class="rune-model-kicker">{props.kicker}</span>
        </Show>
        <span class="rune-model-label">{labelFor(props.current)}</span>
        <Show when={source() !== "none"}>
          <span class="rune-model-src" data-source={source()}>
            {SOURCE_LABEL[source()]}
          </span>
        </Show>
        <span class="rune-model-caret" aria-hidden>
          ▾
        </span>
      </button>
      <Show when={open()}>
        <Portal>
          <div class="rune-model-portal-host">
            <div
              class="rune-model-scrim"
              onClick={() => setOpen(false)}
              aria-hidden
            />
            <div
              ref={(el) => (menu = el)}
              class="rune-model-menu"
              style={{
                top: `${coords().top}px`,
                right: `${coords().right}px`,
                "min-width": `${coords().minWidth}px`,
              }}
              role="listbox"
            >
              <Show when={source() === "override" && props.onReset}>
                <button
                  type="button"
                  class="rune-model-item rune-model-reset"
                  onClick={() => {
                    props.onReset?.()
                    setOpen(false)
                  }}
                >
                  ⟲ 恢复默认（清除 override）
                </button>
                <div class="rune-model-sep" />
              </Show>
              <Show
                when={grouped().length > 0}
                fallback={<div class="rune-model-empty">暂无可用模型</div>}
              >
                <For each={grouped()}>
                  {([providerName, items]) => (
                    <>
                      <div class="rune-model-group">{providerName}</div>
                      <For each={items}>
                        {(item) => {
                          const active = () =>
                            props.current?.providerID === item.providerID &&
                            props.current?.modelID === item.modelID
                          return (
                            <button
                              type="button"
                              class="rune-model-item"
                              data-active={active() ? "true" : "false"}
                              role="option"
                              aria-selected={active() ? "true" : "false"}
                              onClick={() => {
                                props.onChange({
                                  providerID: item.providerID,
                                  modelID: item.modelID,
                                })
                                setOpen(false)
                              }}
                            >
                              <span class="rune-model-item-name">{item.name}</span>
                              <Show when={active()}>
                                <span class="rune-model-item-tick" aria-hidden>
                                  ✓
                                </span>
                              </Show>
                            </button>
                          )
                        }}
                      </For>
                    </>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
