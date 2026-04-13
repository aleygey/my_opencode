/** @jsxImportSource react */
import { useMemo } from 'react'
import { Marked } from 'marked'

const marked = new Marked({
  breaks: true,
  gfm: true,
})

/**
 * Minimal markdown renderer for chat messages.
 * Uses `marked` (already in deps) to parse, then renders via innerHTML.
 */
export function Markdown({ children }: { children: string }) {
  const html = useMemo(() => {
    if (!children?.trim()) return ''
    try {
      const raw = marked.parse(children)
      // marked.parse can return string or Promise<string>; synchronous for our config
      return typeof raw === 'string' ? raw : ''
    } catch {
      return ''
    }
  }, [children])

  if (!html) {
    return <span className="whitespace-pre-wrap break-words">{children}</span>
  }

  return (
    <div
      className="wf-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
