// src/main/sources/queue.ts
// The digest queue: one entry per item, lower priority number first
// (0 manual, 1 watch/start, 2 rescan). A newer request for a queued item
// upgrades its priority (never downgrades) and keeps its place among equals.
// Pure; ReaderService runs one entry at a time.

export type DigestPriority = 0 | 1 | 2

export interface QueueEntry {
  id: string
  p: DigestPriority
  reason: string
  /** Manual refreshes force a digest even when nothing changed. */
  force: boolean
  seq: number
}

export class DigestQueue {
  private entries = new Map<string, QueueEntry>()
  private seq = 0

  enqueue(id: string, p: DigestPriority, reason: string, force = false): void {
    const cur = this.entries.get(id)
    if (cur) {
      if (p < cur.p) {
        cur.p = p
        cur.reason = reason
      }
      cur.force = cur.force || force
      return
    }
    this.entries.set(id, { id, p, reason, force, seq: this.seq++ })
  }

  /** Removes and returns the next entry, or null. */
  take(): QueueEntry | null {
    let best: QueueEntry | null = null
    for (const e of this.entries.values()) {
      if (!best || e.p < best.p || (e.p === best.p && e.seq < best.seq)) best = e
    }
    if (best) this.entries.delete(best.id)
    return best
  }

  peek(): QueueEntry | null {
    let best: QueueEntry | null = null
    for (const e of this.entries.values()) {
      if (!best || e.p < best.p || (e.p === best.p && e.seq < best.seq)) best = e
    }
    return best
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  size(): number {
    return this.entries.size
  }
}
