import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { Portal } from "solid-js/web"
import "./model-picker.css"
import "./agent-picker.css"

export type AgentPickerOption = {
  name: string
  description?: string
}

export function RuneAgentPicker(props: {
  current?: string
  agents: AgentPickerOption[]
  busy?: boolean
  kicker?: string
  onChange: (agent: string) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [coords, setCoords] = createSignal({
    top: 0,
    right: 0,
    minWidth: 220,
  })
  let trigger: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined

  const options = createMemo(() => {
    const seen = new Set<string>()
    return props.agents.filter((agent) => {
      if (!agent.name || seen.has(agent.name)) return false
      seen.add(agent.name)
      return true
    })
  })

  const current = () => props.current ?? options()[0]?.name ?? "agent"

  const reposition = () => {
    if (!trigger) return
    const r = trigger.getBoundingClientRect()
    setCoords({
      top: r.bottom + 6,
      right: Math.max(8, window.innerWidth - r.right),
      minWidth: Math.max(220, r.width),
    })
  }

  const toggle = () => {
    const next = !open()
    if (next) reposition()
    setOpen(next)
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

  return (
    <>
      <button
        ref={(el) => (trigger = el)}
        type="button"
        class="rune-model-trigger rune-agent-trigger"
        aria-expanded={open() ? "true" : "false"}
        disabled={props.busy || options().length === 0}
        title={`Root agent: ${current()}`}
        onClick={toggle}
      >
        <span class="rune-agent-dot" aria-hidden>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3.5" y="5.5" width="9" height="7" rx="2" />
            <path d="M8 5.5V3.5" />
            <path d="M6.3 8.8h.01M9.7 8.8h.01" />
          </svg>
        </span>
        <Show when={props.kicker}>
          <span class="rune-model-kicker">{props.kicker}</span>
        </Show>
        <span class="rune-model-label">@{current()}</span>
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
              class="rune-model-menu rune-agent-menu"
              style={{
                top: `${coords().top}px`,
                right: `${coords().right}px`,
                "min-width": `${coords().minWidth}px`,
              }}
              role="listbox"
            >
              <Show
                when={options().length > 0}
                fallback={<div class="rune-model-empty">No available agents</div>}
              >
                <For each={options()}>
                  {(agent) => {
                    const active = () => agent.name === current()
                    return (
                      <button
                        type="button"
                        class="rune-model-item rune-agent-item"
                        data-active={active() ? "true" : "false"}
                        role="option"
                        aria-selected={active() ? "true" : "false"}
                        onClick={() => {
                          props.onChange(agent.name)
                          setOpen(false)
                        }}
                      >
                        <span class="rune-agent-item-main">
                          <span class="rune-agent-item-name">@{agent.name}</span>
                          <Show when={agent.description}>
                            <span class="rune-agent-item-desc">{agent.description}</span>
                          </Show>
                        </span>
                        <Show when={active()}>
                          <span class="rune-model-item-tick">✓</span>
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
