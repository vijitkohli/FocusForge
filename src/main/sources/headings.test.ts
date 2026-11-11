import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PathGuard } from './guard'
import { readHeadings } from './headings'

let tmp: string
let vault: string
let uni: string
let g: PathGuard

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-headings-')))
  vault = path.join(tmp, 'vault')
  uni = path.join(tmp, 'uni')
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'Life'), { recursive: true })
  fs.mkdirSync(uni, { recursive: true })
  fs.writeFileSync(
    path.join(vault, 'Projects', 'IDEAS TO DO.md'),
    [
      '---',
      '# not a heading: yaml comment',
      'tags: [x]',
      '---',
      '## FocusForge',
      '- [ ] thing BODY-NOT-NEEDED',
      '#hashtag is not a heading',
      '```',
      '# code comment',
      '```',
      '### Garden ###',
      '## Random Idea',
      '## FocusForge',
      'plain body'
    ].join('\n')
  )
  fs.writeFileSync(path.join(vault, 'Life', 'goals.md'), '# Secret goal')
  fs.writeFileSync(path.join(uni, 'api-token.md'), '# Token')
  g = new PathGuard({
    sourceRoots: [uni],
    vaultRoots: [vault],
    readableVault: vault,
    caseInsensitive: true
  })
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('readHeadings', () => {
  it('returns heading lines only', async () => {
    const h = await readHeadings(g, path.join(vault, 'Projects', 'IDEAS TO DO.md'))
    expect(h).toEqual(['FocusForge', 'Garden', 'Random Idea'])
    expect(JSON.stringify(h)).not.toContain('BODY')
  })

  it('caps bytes', async () => {
    const file = path.join(vault, 'Projects', 'IDEAS TO DO.md')
    const full = fs.readFileSync(file, 'utf8')
    const cut = full.indexOf('### Garden') + 6 // mid-heading
    expect(await readHeadings(g, file, cut)).toEqual(['FocusForge'])
  })

  it('refuses Life and secret paths through the guard', async () => {
    expect(await readHeadings(g, path.join(vault, 'Life', 'goals.md'))).toEqual([])
    expect(await readHeadings(g, path.join(uni, 'api-token.md'))).toEqual([])
    expect(await readHeadings(g, path.join(tmp, 'elsewhere.md'))).toEqual([])
    expect(await readHeadings(g, path.join(vault, 'Projects'))).toEqual([])
  })
})
