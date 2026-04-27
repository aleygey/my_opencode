import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

/**
 * Permission request UI rendered inside the app's standard `<Dialog>` shell so
 * it visually matches the other modal dialogs (server picker, settings, etc.)
 * instead of the previous in-line "dock" banner that floated above the chat
 * input. Mounting/unmounting is managed by the caller via `useDialog().show()`
 * — this component is purely presentational.
 */
export function SessionPermissionDialog(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <Dialog
      fit
      transition
      title={
        <span class="flex items-center gap-2">
          <span
            class="inline-flex items-center justify-center"
            style={{ color: "var(--icon-warning-base)" }}
          >
            <Icon name="warning" size="normal" />
          </span>
          <span>{language.t("notification.permission.title")}</span>
        </span>
      }
    >
      <div class="flex flex-col gap-4 px-5 pb-5">
        <Show when={toolDescription()}>
          <p class="text-14-regular text-text-weak m-0">{toolDescription()}</p>
        </Show>

        <Show when={props.request.patterns.length > 0}>
          <div class="flex flex-col gap-1.5">
            <For each={props.request.patterns}>
              {(pattern) => (
                <code class="text-12-regular text-text-base bg-surface-base rounded-sm px-2 py-1.5 break-all">
                  {pattern}
                </code>
              )}
            </For>
          </div>
        </Show>

        <div class="flex items-center justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            size="normal"
            onClick={() => props.onDecide("reject")}
            disabled={props.responding}
          >
            {language.t("ui.permission.deny")}
          </Button>
          <Button
            variant="secondary"
            size="normal"
            onClick={() => props.onDecide("always")}
            disabled={props.responding}
          >
            {language.t("ui.permission.allowAlways")}
          </Button>
          <Button
            variant="primary"
            size="normal"
            onClick={() => props.onDecide("once")}
            disabled={props.responding}
          >
            {language.t("ui.permission.allowOnce")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
