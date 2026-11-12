import { describe, expect, it } from 'vitest'
import { DigestQueue } from './queue'

describe('DigestQueue', () => {
  it('one entry per item, priority upgrade', () => {
    const q = new DigestQueue()
    q.enqueue('a', 2, 'rescan')
    q.enqueue('a', 1, 'watch')
    q.enqueue('a', 2, 'rescan')
    expect(q.size()).toBe(1)
    expect(q.take()).toMatchObject({ id: 'a', p: 1, reason: 'watch', force: false })
    expect(q.take()).toBeNull()
  })

  it('manual beats watch beats rescan; FIFO within a priority', () => {
    const q = new DigestQueue()
    q.enqueue('r', 2, 'rescan')
    q.enqueue('w1', 1, 'watch')
    q.enqueue('w2', 1, 'watch')
    q.enqueue('m', 0, 'manual', true)
    expect([q.take(), q.take(), q.take(), q.take()].map((e) => e?.id)).toEqual([
      'm',
      'w1',
      'w2',
      'r'
    ])
  })

  it('remove drops a pending item; force sticks', () => {
    const q = new DigestQueue()
    q.enqueue('a', 1, 'watch')
    q.enqueue('b', 1, 'watch', true)
    q.enqueue('b', 1, 'watch')
    q.remove('a')
    expect(q.has('a')).toBe(false)
    expect(q.take()).toMatchObject({ id: 'b', force: true })
  })
})
