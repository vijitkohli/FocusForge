// src/main/sources/rules.ts
// Name-level rules that mirror the owner's data access rules (instruction.md,
// local only). Everything here is pure: no fs, no electron. The guard
// (guard.ts) is the only place these are applied to real paths.
//
// Keep this list in step with instruction.md. Overblocking is always safe;
// underblocking breaks a binding rule.

/**
 * "Life/ is off limits" (instruction.md, Obsidian vault). Matched on the
 * folded (NFC + lowercase) name of the FIRST segment under a vault root.
 * ' 2', ' 3'... are iCloud conflict copies of the folder.
 */
export const LIFE_DIR_PATTERN = /^life( \d+)?$/

/**
 * "Pending exception: ... read none of them until the owner names the exact
 * files". Vault-relative exact FILE paths (e.g. 'Life/SomeNote.md'). Empty
 * until the owner lists files in instruction.md. Files only: never walked.
 */
export const LIFE_ALLOWLIST: readonly string[] = []

/** "Ignore .obsidian/ (app config)". `.trash` is Obsidian's deleted-notes bin. */
export const VAULT_CONFIG_DIRS: readonly string[] = ['.obsidian', '.trash']

/**
 * The app's own vault folder (Phase 4 writes notes there). Readable, but
 * discovery never suggests it back as an item.
 */
export const APP_VAULT_DIR = 'FocusForge'

/** "noise: node_modules/, .git/ internals, .venv/env/, build output, caches". */
export const NOISE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage',
  'target',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  'chroma_db',
  '.db'
])

/** Every dot-directory is noise (.git, .venv, .obsidian, .trash, .vscode, unknown caches). */
export const SKIP_ALL_DOT_DIRS = true

/**
 * "secrets and credentials: anything with 'PAT', 'token', 'secret' or 'key'
 * in the name". Owner decision (PHASE2_PLAN_REV2 §C1): substring match for
 * these, whole-word match for key/PAT (so keyboard.md and patterns.md stay
 * readable).
 */
export const SECRET_SUBSTRINGS: readonly string[] = [
  'secret',
  'token',
  'password',
  'credential',
  'apikey',
  'api-key',
  'api_key',
  'privatekey',
  'private_key'
]
export const SECRET_WORDS: ReadonlySet<string> = new Set([
  'pat',
  'pats',
  'key',
  'keys',
  'keyfile',
  'keystore',
  'keychain'
])
/** "*.pem" plus other key/cert containers. */
export const SECRET_EXTENSIONS: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.keychain',
  '.asc',
  '.gpg'
]
/** "config.yaml holding API keys" plus well-known credential files. */
export const SECRET_EXACT: ReadonlySet<string> = new Set([
  'config.yaml',
  'config.yml',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'credentials'
])
/** ".env*" */
export const ENV_FILE = /^\.env(\..*)?$|^\.envrc$/
/** iCloud evicted-file placeholder: `.Thesis.md.icloud` is checked as `Thesis.md`. */
export const ICLOUD_STUB = /^\.(.+)\.icloud$/

/** NFC + lowercase. Life and secret matching always fold, on every platform. */
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** `.Thesis.md.icloud` -> `Thesis.md`; any other name is returned unchanged. */
export function unwrapICloudStub(name: string): string {
  const m = ICLOUD_STUB.exec(name)
  return m ? m[1] : name
}

/** True for `Life`, `life`, `LIFE`, `Life 2` (iCloud copy), NFD forms, and their iCloud stubs. */
export function isLifeDirName(name: string): boolean {
  return LIFE_DIR_PATTERN.test(foldName(unwrapICloudStub(name)))
}

/** Splits on non-alphanumerics, letter/digit changes and camelCase/acronym boundaries. */
export function nameWords(name: string): string[] {
  return name
    .normalize('NFC')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** Whether a file or folder name falls under the secrets rule. iCloud stubs are unwrapped first. */
export function isSecretName(rawName: string): boolean {
  const name = unwrapICloudStub(rawName)
  const folded = foldName(name)
  if (ENV_FILE.test(folded)) return true
  if (SECRET_EXACT.has(folded)) return true
  if (SECRET_EXTENSIONS.some((ext) => folded.endsWith(ext))) return true
  if (SECRET_SUBSTRINGS.some((s) => folded.includes(s))) return true
  return nameWords(name).some((w) => SECRET_WORDS.has(w))
}

/** Whether a directory name is noise (never descended into). */
export function isNoiseDir(rawName: string): boolean {
  const folded = foldName(unwrapICloudStub(rawName))
  if (SKIP_ALL_DOT_DIRS && folded.startsWith('.')) return true
  return NOISE_DIRS.has(folded)
}

/** Whether a name is an Obsidian config dir (`.obsidian`, `.trash`) at a vault's top level. */
export function isVaultConfigName(rawName: string): boolean {
  return VAULT_CONFIG_DIRS.includes(foldName(rawName))
}

/**
 * Whether a configured vault category may be scanned: a single plain folder
 * name that isn't Life (any case or iCloud copy), Obsidian config, a dot
 * folder or the app's own folder.
 */
export function isScannableVaultCategory(name: string): boolean {
  const n = name.trim()
  return (
    n !== '' &&
    !/[\\/\0]/.test(n) &&
    !n.startsWith('.') &&
    n !== '..' &&
    !isLifeDirName(n) &&
    !isVaultConfigName(n) &&
    foldName(n) !== foldName(APP_VAULT_DIR)
  )
}
