/** @jsxImportSource react */
import { Bot, Code2, Terminal, User } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

type Role = 'system' | 'assistant' | 'user' | 'tool'

interface Msg {
  id: string
  role: Role
  content: string
  timestamp: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  messages: Msg[]
  title?: string
  subtitle?: string
}

const icons: Record<Role, React.ElementType> = {
  system: Terminal,
  assistant: Bot,
  user: User,
  tool: Code2,
}

const names: Record<Role, string> = {
  system: 'System',
  assistant: 'Assistant',
  user: 'User',
  tool: 'Tool',
}

export function SessionDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-[900px] border-[var(--wf-line)] bg-[var(--wf-bg)] p-0 shadow-[0_22px_60px_rgba(15,23,42,0.18)]">
        <DialogHeader className="border-b border-[var(--wf-line)] px-6 py-5">
          <DialogTitle className="text-[20px] font-medium tracking-[-0.02em] text-[var(--wf-ink)]">Session Conversation</DialogTitle>
          <DialogDescription className="space-y-1 text-left">
            {props.title ? <span className="block text-[13px] text-[var(--wf-ink-soft)]">{props.title}</span> : null}
            {props.subtitle ? <span className="block font-mono text-[11px] text-[var(--wf-dim)]">{props.subtitle}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-auto px-6 py-5">
          <div className="space-y-3">
            {props.messages.map((item) => {
              const Icon = icons[item.role]
              return (
                <div key={item.id} className="rounded-[14px] border border-[var(--wf-line)] bg-[var(--wf-panel)] p-4">
                  <div className="flex gap-3">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--wf-bg)]">
                      <Icon className="h-4 w-4 text-[var(--wf-dim)]" strokeWidth={1.7} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[11px] text-[var(--wf-dim)]">
                        <span className="font-medium text-[var(--wf-ink)]">{names[item.role]}</span>
                        <span>{item.timestamp}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-[var(--wf-ink-soft)]">{item.content}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
