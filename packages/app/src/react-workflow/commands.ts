export type SlashCommandCategory = 'session' | 'navigation' | 'config'

export interface SlashCommandCallbacks {
  onSendMessage?: (msg: string) => void
  onNewSession?: () => void
  onModelPickerOpen?: () => void
  /**
   * Called for `action: 'insert'` commands — receives the text to put in
   * the input box (typically `"/<trigger> "` with a trailing space) so the
   * user can keep typing arguments before pressing Enter. The chat panel
   * is responsible for setting the textarea value and placing the caret at
   * the end.
   */
  onInsertText?: (text: string) => void
}

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description: string
  category: SlashCommandCategory
  /**
   * - 'send':   calls onSendMessage("/<trigger>") immediately on Tab/Enter.
   *             Use for zero-arg commands (`/compact`, `/undo`, …).
   * - 'local':  calls the named callback without sending (`/new`, `/model`).
   * - 'insert': fills the input with "/<trigger> " (trailing space) and
   *             leaves it for the user to type arguments. Use for commands
   *             that take a user-supplied message (`/notrack <msg>`,
   *             `/tmp <msg>`, etc.).
   */
  action: 'send' | 'local' | 'insert'
  localCallbackKey?: keyof SlashCommandCallbacks
}

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'undo',
    trigger: 'undo',
    title: 'Undo',
    description: 'Revert the last message',
    category: 'session',
    action: 'send',
  },
  {
    id: 'redo',
    trigger: 'redo',
    title: 'Redo',
    description: 'Re-apply the reverted message',
    category: 'session',
    action: 'send',
  },
  {
    id: 'compact',
    trigger: 'compact',
    title: 'Compact',
    description: 'Summarize and compress the context',
    category: 'session',
    action: 'send',
  },
  {
    id: 'fork',
    trigger: 'fork',
    title: 'Fork',
    description: 'Fork this session into a new branch',
    category: 'session',
    action: 'send',
  },
  {
    id: 'new',
    trigger: 'new',
    title: 'New Session',
    description: 'Start a new conversation',
    category: 'navigation',
    action: 'local',
    localCallbackKey: 'onNewSession',
  },
  {
    id: 'model',
    trigger: 'model',
    title: 'Model',
    description: 'Change the AI model',
    category: 'config',
    action: 'local',
    localCallbackKey: 'onModelPickerOpen',
  },
]
