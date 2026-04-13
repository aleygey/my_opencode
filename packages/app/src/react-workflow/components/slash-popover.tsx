/** @jsxImportSource react */
import { useEffect, useRef } from 'react'
import type { SlashCommand } from '../commands'

interface SlashPopoverProps {
  open: boolean
  commands: SlashCommand[]
  activeId: string | null
  onSelect: (cmd: SlashCommand) => void
  onHover: (id: string) => void
}

export function SlashPopover({ open, commands, activeId, onSelect, onHover }: SlashPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll active item into view when it changes
  useEffect(() => {
    if (!open || !activeId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-cmd-id="${activeId}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeId, open])

  if (!open || commands.length === 0) return null

  return (
    <div
      className="wf-slash-popover wf-fade-in"
      ref={listRef}
      // Prevent mousedown from blurring the textarea
      onMouseDown={(e) => e.preventDefault()}
    >
      {commands.map((cmd) => (
        <button
          key={cmd.id}
          type="button"
          data-cmd-id={cmd.id}
          className={`wf-slash-item${cmd.id === activeId ? ' wf-slash-item--active' : ''}`}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => onHover(cmd.id)}
        >
          <div className="wf-slash-item-left">
            <span className="wf-slash-trigger">/{cmd.trigger}</span>
            <span className="wf-slash-desc">{cmd.description}</span>
          </div>
          <span className="wf-slash-category">{cmd.category}</span>
        </button>
      ))}
    </div>
  )
}
