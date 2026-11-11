import { describe, expect, it } from 'vitest'
import { isLifeDirName, isNoiseDir, isSecretName, nameWords, unwrapICloudStub } from './rules'

describe('isSecretName', () => {
  const blocked = [
    'REPO PAT.rtf',
    'SERVICE PAT.rtf',
    'my_pat.txt',
    'api_key.txt',
    'api-key.json',
    'apikey',
    'aws-keys.json',
    'deploy.key',
    'my.pem',
    'cert.p12',
    'tokenizer.py',
    'access_token.json',
    'client_secret.json',
    'Secrets.md',
    'passwords.csv',
    'credentials',
    'aws_credentials.ini',
    'config.yaml',
    'config.yml',
    'id_rsa',
    '.netrc',
    '.npmrc',
    '.env',
    '.env.local',
    '.env.production',
    '.envrc',
    'myApiKey.ts',
    'REPOPat.txt',
    'pat2024.txt',
    '.REPO PAT.rtf.icloud',
    '.api_key.txt.icloud'
  ]
  const allowed = [
    'keyboard.md',
    'monkey.md',
    'patterns.md',
    'paths.ts',
    'dispatch.py',
    'Thesis.md',
    'README.md',
    'environment.md',
    'turkey-recipes.md',
    'config.json',
    'notes.env.md'
  ]
  it.each(blocked)('blocks %s', (name) => expect(isSecretName(name)).toBe(true))
  it.each(allowed)('allows %s', (name) => expect(isSecretName(name)).toBe(false))
})

describe('isNoiseDir', () => {
  it.each([
    'node_modules',
    '.git',
    '.venv',
    'venv',
    'env',
    'dist',
    'out',
    'build',
    'target',
    '__pycache__',
    '.obsidian',
    '.trash',
    '.vscode',
    'Node_Modules',
    '.anything'
  ])('noise: %s', (name) => expect(isNoiseDir(name)).toBe(true))
  it.each(['src', 'notes', 'research', 'builds-log', 'environment'])('not noise: %s', (name) =>
    expect(isNoiseDir(name)).toBe(false)
  )
})

describe('isLifeDirName', () => {
  it.each(['Life', 'life', 'LIFE', 'LiFe', 'Life 2', 'life 13', 'Life'.normalize('NFD')])(
    'life: %s',
    (n) => expect(isLifeDirName(n)).toBe(true)
  )
  it.each(['Life Sciences', 'Lifestyle', 'my life', 'Life2', 'Life.md'])('not life: %s', (n) =>
    expect(isLifeDirName(n)).toBe(false)
  )
})

describe('helpers', () => {
  it('splits camelCase, acronyms and digits', () => {
    expect(nameWords('REPO PAT.rtf')).toEqual(['repo', 'pat', 'rtf'])
    expect(nameWords('myApiKey2.ts')).toEqual(['my', 'api', 'key', '2', 'ts'])
    expect(nameWords('HTTPServer')).toEqual(['http', 'server'])
  })
  it('unwraps iCloud stubs only', () => {
    expect(unwrapICloudStub('.Thesis.md.icloud')).toBe('Thesis.md')
    expect(unwrapICloudStub('Thesis.md')).toBe('Thesis.md')
  })
})
