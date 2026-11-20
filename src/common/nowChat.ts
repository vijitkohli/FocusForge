// Shared shapes for the Now screen chat (main ⇄ renderer).

export interface NowChatPick {
  projectId: string
  taskId: string
  subtaskId: string
  title: string
  itemName: string
}

export interface NowChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** The step this reply put in the "What next?" card, if any. */
  pick?: NowChatPick | null
}

export interface NowChatReply {
  ok: boolean
  message: string
  pick: NowChatPick | null
  replies: string[]
  cancelled?: boolean
}

/** "today", "yesterday", "3 days ago" from an ISO timestamp, in local days. */
export function touchedLabel(iso: string | undefined, now = new Date()): string | undefined {
  if (!iso) return undefined
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return undefined
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(then)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
