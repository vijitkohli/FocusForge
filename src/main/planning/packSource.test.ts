import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FixturePackSource,
  NullPackSource,
  registerPackSource,
  resolvePackSource,
  StorePackSource
} from './packSource'
import { packToPromptText } from '../sources/packPrompt'
import type { ContextPack } from '../../common/readers'

function pack(): ContextPack {
  return {
    version: 1,
    itemId: 'data9001',
    builtAt: '',
    budget: {
      maxChars: 1,
      perFileChars: 1,
      maxFiles: 1,
      gitCommits: 1,
      gitChars: 1,
      vaultChars: 1,
      briefChars: 1,
      indexChars: 1,
      maxReadBytesPerBuild: 1
    },
    totalChars: 10,
    truncated: false,
    sources: [],
    files: [
      {
        id: 'F1',
        label: 'data9001/CONTEXT.md',
        ref: '/secret/abs/path/CONTEXT.md',
        kind: 'context',
        mtimeMs: new Date(2026, 10, 10, 12).getTime(),
        size: 5,
        hash: 'h',
        chars: 5,
        truncated: false,
        redactions: 0,
        changed: false,
        text: 'hello'
      }
    ],
    git: [
      { id: 'G1', label: 'git:data9001', head: 'abc', commits: [], text: '2026-11-10 abc first' }
    ],
    index: [{ label: 'data9001/old.md', date: '2026-10-01' }],
    seen: {},
    activityAt: null,
    notDownloaded: 0,
    conflicts: 0,
    fingerprint: 'f'
  }
}

afterEach(() => registerPackSource(null))

describe('packSource', () => {
  it('fixture source reads <id>.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'))
    fs.writeJSONSync(path.join(dir, 'data9001.json'), {
      pack: pack(),
      digest: { goal: 'Finish A3' }
    })
    const src = new FixturePackSource(dir)
    const got = await src.getContextPack('data9001')
    expect(got?.digest?.goal).toBe('Finish A3')
    expect(got?.text).toContain(
      '=== FILE F1: data9001/CONTEXT.md (context, modified 2026-11-10) ==='
    )
    expect(got?.text).not.toContain('/secret/abs/path')
    expect(await src.getContextPack('missing')).toBeNull()
    expect(await src.getContextPack('../etc')).toBeNull()
  })

  it('null source without env', async () => {
    const src = resolvePackSource({})
    expect(src).toBeInstanceOf(NullPackSource)
    expect(await src.getContextPack('x')).toBeNull()
    expect(resolvePackSource({ FOCUSFORGE_PACK_FIXTURES: '/tmp/x' })).toBeInstanceOf(
      FixturePackSource
    )
  })

  it('store source wraps the Phase 3 pack store', async () => {
    const src = new StorePackSource({
      readPack: async (id) => (id === 'data9001' ? pack() : null),
      readDigest: async () => null
    })
    const got = await src.getContextPack('data9001')
    expect(got?.digest).toBeNull()
    expect(got?.text).toContain('=== FILE F1: data9001/CONTEXT.md')
    expect(await src.getContextPack('other')).toBeNull()
  })

  it('prefers phase 3 source when present', () => {
    const phase3 = { getContextPack: async () => null }
    registerPackSource(phase3)
    expect(resolvePackSource({ FOCUSFORGE_PACK_FIXTURES: '/tmp/x' })).toBe(phase3)
  })

  it('formats git and index blocks after files', () => {
    const text = packToPromptText(pack())
    expect(text.indexOf('=== GIT G1: git:data9001 ===')).toBeGreaterThan(
      text.indexOf('=== END F1 ===')
    )
    expect(text).toContain('data9001/old.md · 2026-10-01')
  })
})
