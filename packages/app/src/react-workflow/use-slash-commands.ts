import { useState, useCallback, useMemo } from 'react'
import { BUILTIN_SLASH_COMMANDS, type SlashCommand, type SlashCommandCallbacks } from './commands'

interface UseSlashCommandsOptions {
  callbacks: SlashCommandCallbacks
  extraCommands?: SlashCommand[]
}

export function useSlashCommands({ callbacks, extraCommands = [] }: UseSlashCommandsOptions) {
  const allCommands = useMemo(
    () => [...BUILTIN_SLASH_COMMANDS, ...extraCommands],
    [extraCommands],
  )

  const [popoverOpen, setPopoverOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    if (!filter) return allCommands
    const f = filter.toLowerCase()
    return allCommands.filter(
      (cmd) => cmd.trigger.includes(f) || cmd.description.toLowerCase().includes(f),
    )
  }, [allCommands, filter])

  const closePopover = useCallback(() => {
    setPopoverOpen(false)
    setFilter('')
    setActiveId(null)
  }, [])

  /**
   * Call this from textarea onChange.
   * If the full input value starts with "/" and has no space, open the popover.
   */
  const handleInputChange = useCallback(
    (value: string) => {
      if (value.startsWith('/') && !value.includes(' ') && !value.includes('\n')) {
        const f = value.slice(1)
        setFilter(f)
        setPopoverOpen(true)
        // Reset active to first match
        const next = f
          ? allCommands.filter((c) => c.trigger.includes(f.toLowerCase()))
          : allCommands
        setActiveId(next[0]?.id ?? null)
      } else {
        setPopoverOpen(false)
        setFilter('')
        setActiveId(null)
      }
    },
    [allCommands],
  )

  const executeCommand = useCallback(
    (cmd: SlashCommand) => {
      closePopover()
      if (cmd.action === 'send') {
        callbacks.onSendMessage?.(`/${cmd.trigger}`)
      } else if (cmd.action === 'local' && cmd.localCallbackKey) {
        const cb = callbacks[cmd.localCallbackKey]
        if (typeof cb === 'function') (cb as () => void)()
      }
    },
    [callbacks, closePopover],
  )

  /**
   * Call this from textarea onKeyDown.
   * Returns true if the key event was consumed (caller should preventDefault).
   * When Tab/Enter is consumed, the caller should also clear the input.
   */
  const handleKeyDown = useCallback(
    (key: string): boolean => {
      if (!popoverOpen || filtered.length === 0) return false

      if (key === 'ArrowDown') {
        const idx = filtered.findIndex((c) => c.id === activeId)
        const next = filtered[(idx + 1) % filtered.length]
        setActiveId(next.id)
        return true
      }
      if (key === 'ArrowUp') {
        const idx = filtered.findIndex((c) => c.id === activeId)
        const prev = filtered[(idx - 1 + filtered.length) % filtered.length]
        setActiveId(prev.id)
        return true
      }
      if (key === 'Tab' || key === 'Enter') {
        const target = filtered.find((c) => c.id === activeId) ?? filtered[0]
        if (target) {
          executeCommand(target)
          return true
        }
      }
      if (key === 'Escape') {
        closePopover()
        return true
      }
      return false
    },
    [popoverOpen, filtered, activeId, executeCommand, closePopover],
  )

  return {
    popoverOpen,
    filtered,
    activeId,
    setActiveId,
    handleInputChange,
    handleKeyDown,
    executeCommand,
    closePopover,
  }
}
