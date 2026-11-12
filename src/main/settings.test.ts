import path from 'path'
import fs from 'fs-extra'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const nodeFs = await import('fs')
  const nodeOs = await import('os')
  const nodePath = await import('path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'flowstate-settings-'))
  return { app: { getPath: () => dir } }
})

import { SETTINGS_PATH } from './store/paths'
import {
  cleanVaultCategories,
  loadSettings,
  normalizeSettings,
  sanitizeRendererSettingsPatch,
  saveSettings
} from './settings'
import { DEFAULT_SETTINGS } from '../common/models'

beforeEach(() => {
  expect(SETTINGS_PATH.includes('flowstate-settings-')).toBe(true)
  fs.removeSync(path.dirname(SETTINGS_PATH))
})

describe('settings', () => {
  it('fills new defaults', async () => {
    fs.outputJSONSync(SETTINGS_PATH, { chatModel: 'm', aiNudges: false })
    const s = await loadSettings()
    expect(s).toMatchObject({
      chatModel: 'm',
      aiNudges: false,
      vaultPath: '',
      sourceRoots: [
        { path: '~/UNI', category: 'Learning' },
        { path: '~/Projects', category: 'Projects' }
      ],
      vaultCategories: ['Learning', 'Projects', 'Career'],
      discoveryCompletedAt: null,
      discoveryDismissedAt: null
    })
  })

  it('initialActiveKeys default', async () => {
    expect((await loadSettings()).initialActiveKeys).toEqual([
      'thesis',
      'comp9321',
      'psyc1023',
      'personalwebsite',
      'focusforge'
    ])
    expect(
      normalizeSettings({ initialActiveKeys: ['Personal-Website', 3] }).initialActiveKeys
    ).toEqual(['personalwebsite'])
  })

  it('rejects malformed sourceRoots', () => {
    const d = DEFAULT_SETTINGS.sourceRoots
    expect(normalizeSettings({ sourceRoots: 'x' }).sourceRoots).toEqual(d)
    expect(normalizeSettings({ sourceRoots: [{ path: '/a' }] }).sourceRoots).toEqual(d)
    expect(
      normalizeSettings({ sourceRoots: [{ path: '/a', category: 'Learning' }, { path: '' }] })
        .sourceRoots
    ).toEqual(d)
    expect(
      normalizeSettings({ sourceRoots: [{ path: '/a', category: 'Life' }] }).sourceRoots
    ).toEqual(d)
    expect(
      normalizeSettings({ sourceRoots: [{ path: ' /a ', category: 'Career' }] }).sourceRoots
    ).toEqual([{ path: '/a', category: 'Career' }])
  })

  it('strips Life from vaultCategories', () => {
    expect(
      cleanVaultCategories([
        'Learning',
        'Life',
        'life',
        'LIFE 2',
        'Life'.normalize('NFD'),
        '.obsidian',
        'FocusForge',
        '../x',
        'a/b',
        '',
        'Career',
        'Career'
      ])
    ).toEqual(['Learning', 'Career'])
    expect(normalizeSettings({ vaultCategories: ['Life'] }).vaultCategories).toEqual([])
  })

  it('renderer patches cannot change what FocusForge reads', async () => {
    const patch = sanitizeRendererSettingsPatch({
      vaultPath: '/',
      sourceRoots: [{ path: '/', category: 'Projects' }],
      vaultCategories: ['Life'],
      aiNudges: false,
      discoveryDismissedAt: '2026-11-11T00:00:00.000Z'
    })
    expect(patch).toEqual({ aiNudges: false, discoveryDismissedAt: '2026-11-11T00:00:00.000Z' })
    const saved = await saveSettings(patch)
    expect(saved.vaultPath).toBe('')
    expect(saved.discoveryDismissedAt).toBe('2026-11-11T00:00:00.000Z')
    expect(fs.readJSONSync(SETTINGS_PATH).sourceRoots).toEqual(DEFAULT_SETTINGS.sourceRoots)
  })

  it('vaultNotes defaults true and the renderer may set it', async () => {
    expect((await loadSettings()).vaultNotes).toBe(true)
    expect(normalizeSettings({ vaultNotes: 'no' }).vaultNotes).toBe(true)
    const off = await saveSettings(sanitizeRendererSettingsPatch({ vaultNotes: false }))
    expect(off.vaultNotes).toBe(false)
    expect(fs.readJSONSync(SETTINGS_PATH).vaultNotes).toBe(false)
    // a malformed value is dropped, so it can't flip writes back on
    expect(sanitizeRendererSettingsPatch({ vaultNotes: 'yes', aiNudges: true })).toEqual({
      aiNudges: true
    })
    expect((await saveSettings(sanitizeRendererSettingsPatch({ vaultNotes: 1 }))).vaultNotes).toBe(
      false
    )
    expect(
      (await saveSettings(sanitizeRendererSettingsPatch({ vaultNotes: true }))).vaultNotes
    ).toBe(true)
  })

  it('digestModel and readersEnabled defaults and validation', async () => {
    const s = await loadSettings()
    expect(s.digestModel).toBe('cliproxy/gemini-3-flash')
    expect(s.readersEnabled).toBe(true)
    expect(normalizeSettings({ digestModel: '  ', readersEnabled: 'no' })).toMatchObject({
      digestModel: 'cliproxy/gemini-3-flash',
      readersEnabled: true
    })
    expect(normalizeSettings({ digestModel: 'gpt-4o', readersEnabled: false })).toMatchObject({
      digestModel: 'gpt-4o',
      readersEnabled: false
    })
  })

  it('save keeps defaults immutable', async () => {
    const s = await loadSettings()
    s.sourceRoots.push({ path: '/x', category: 'Projects' })
    expect(DEFAULT_SETTINGS.sourceRoots).toHaveLength(2)
  })
})
