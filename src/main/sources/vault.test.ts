import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-flowstate-test' } }))
import { detectVault, isVaultDir, readObsidianVaults } from './vault'
import { buildGuardConfig, discoverRoots } from './config'
import { normalizeSettings } from '../settings'
import type { VaultInfo } from '../../common/discovery'

let tmp: string
let appData: string
let home: string

function vaultAt(name: string): string {
  const p = path.join(home, name)
  fs.mkdirSync(path.join(p, '.obsidian'), { recursive: true })
  return p
}

function writeConfig(vaults: Record<string, unknown>): void {
  fs.mkdirSync(path.join(appData, 'obsidian'), { recursive: true })
  fs.writeFileSync(path.join(appData, 'obsidian', 'obsidian.json'), JSON.stringify({ vaults }))
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vault-')))
  appData = path.join(tmp, 'appdata')
  home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('vault detection', () => {
  it('prefers the open vault', async () => {
    const a = vaultAt('A')
    const b = vaultAt('B')
    writeConfig({ x: { path: a, ts: 9, open: false }, y: { path: b, ts: 1, open: true } })
    const v = await detectVault(
      { vaultPath: '' },
      await readObsidianVaults(appData),
      undefined,
      home
    )
    expect(v).toEqual({ path: b, source: 'obsidian', valid: true, others: [a] })
  })

  it('falls back to newest ts', async () => {
    const a = vaultAt('A')
    const b = vaultAt('B')
    writeConfig({ x: { path: a, ts: 9 }, y: { path: b, ts: 1 } })
    const v = await detectVault(
      { vaultPath: '' },
      await readObsidianVaults(appData),
      undefined,
      home
    )
    expect(v.path).toBe(a)
  })

  it('ignores missing paths and dirs without .obsidian', async () => {
    const plain = path.join(home, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    const c = vaultAt('C')
    writeConfig({
      x: { path: path.join(home, 'missing'), ts: 99, open: true },
      y: { path: plain, ts: 50 },
      z: { path: c, ts: 1 },
      bad: { path: 'relative/path', ts: 100 }
    })
    const vaults = await readObsidianVaults(appData)
    expect(vaults).toHaveLength(3)
    const v = await detectVault({ vaultPath: '' }, vaults, undefined, home)
    expect(v).toEqual({ path: c, source: 'obsidian', valid: true, others: [] })
    expect(await isVaultDir(plain, undefined, home)).toBe(false)
    expect(await isVaultDir(home, undefined, home)).toBe(false)
    expect(await isVaultDir('/', undefined, home)).toBe(false)
  })

  it('settings path wins when valid', async () => {
    const a = vaultAt('A')
    const s = vaultAt('Settings Vault')
    writeConfig({ x: { path: a, ts: 9, open: true } })
    const v = await detectVault(
      { vaultPath: '~/Settings Vault' },
      await readObsidianVaults(appData),
      undefined,
      home
    )
    expect(v).toEqual({ path: s, source: 'settings', valid: true, others: [a] })
  })

  it('a configured vault that is gone is invalid, not swapped for another', async () => {
    const a = vaultAt('A')
    writeConfig({ x: { path: a, ts: 9, open: true } })
    const v = await detectVault(
      { vaultPath: '~/Gone' },
      await readObsidianVaults(appData),
      undefined,
      home
    )
    expect(v).toEqual({
      path: path.join(home, 'Gone'),
      source: 'settings',
      valid: false,
      others: [a]
    })
  })

  it('returns none when obsidian.json is missing or malformed', async () => {
    fs.rmSync(path.join(appData, 'obsidian'), { recursive: true, force: true })
    expect(await readObsidianVaults(appData)).toEqual([])
    expect(await detectVault({ vaultPath: '' }, [], undefined, home)).toEqual({
      path: null,
      source: 'none',
      valid: false,
      others: []
    })
    fs.mkdirSync(path.join(appData, 'obsidian'), { recursive: true })
    fs.writeFileSync(path.join(appData, 'obsidian', 'obsidian.json'), '{not json')
    expect(await readObsidianVaults(appData)).toEqual([])
    fs.writeFileSync(path.join(appData, 'obsidian', 'obsidian.json'), '{"vaults": 3}')
    expect(await readObsidianVaults(appData)).toEqual([])
  })
})

describe('guard config', () => {
  it('turns on vault writes only for a saved vault with vaultNotes on', () => {
    const base = {
      obsidianVaults: [],
      home: '/h',
      writableRoots: ['/h/Documents/FlowState']
    }
    const saved: VaultInfo = { path: '/v/main', source: 'settings', valid: true, others: [] }
    const gate = (s: Record<string, unknown>, vault = saved): boolean | undefined =>
      buildGuardConfig({ ...base, settings: normalizeSettings(s), vault }).appVaultWrite
    expect(gate({ vaultPath: '/v/main' })).toBe(true)
    expect(gate({ vaultPath: '/v/main', vaultNotes: false })).toBe(false)
    // auto-detected (not saved) vault never gets writes
    expect(gate({ vaultPath: '' }, { ...saved, source: 'obsidian' })).toBe(false)
    // saved path is no longer a vault (no .obsidian)
    expect(gate({ vaultPath: '/v/main' }, { ...saved, valid: false })).toBe(false)
    expect(gate({ vaultPath: '~' }, { ...saved, path: '/h' })).toBe(false)
  })

  it('denies Life in every known vault but reads only the chosen one', () => {
    const settings = normalizeSettings({
      vaultPath: '',
      sourceRoots: [
        { path: '~/UNI', category: 'Learning' },
        { path: '~', category: 'Projects' },
        { path: '/', category: 'Projects' },
        { path: 'relative', category: 'Projects' }
      ]
    })
    const cfg = buildGuardConfig({
      settings,
      obsidianVaults: [
        { path: '/v/old', open: false, ts: 1 },
        { path: '/v/main', open: true, ts: 2 }
      ],
      vault: { path: '/v/main', source: 'obsidian', valid: true, others: ['/v/old'] },
      home: '/h',
      writableRoots: ['/h/Documents/FlowState']
    })
    expect(cfg.sourceRoots).toEqual([path.join('/h', 'UNI')])
    expect(cfg.readableVault).toBe('/v/main')
    expect(cfg.vaultRoots.sort()).toEqual(['/v/main', '/v/old'])
    expect(discoverRoots(settings, '/h')).toEqual([
      { path: path.join('/h', 'UNI'), label: '~/UNI', category: 'Learning' }
    ])
  })
})
