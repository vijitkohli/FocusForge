const tails = new Map<string, Promise<void>>()

/**
 * Runs `fn` after every earlier call with the same key has settled, so
 * read-modify-write sequences on one file never interleave. Keys in use:
 *   project:<id>  project_data.json (taken first)
 *   ledger:<id>   context_<id>.md   (may be taken inside project:<id>)
 *   registry      master_index.json (may be taken inside project:<id>)
 *   profile       user_profile.md
 *   settings      settings.json
 *   nudges        nudges.json
 *   discovery     discovery.json (item suggestions cache)
 *   whatnext      system/whatnext.json and skips.jsonl (Phase 6)
 *   vaultnote:<id> one item's vault notes (Phase 4 writer flush / reader ingest)
 *   vaultstate    system/vault/state.json (vault sync state)
 *   vaultlog:<id> system/vault/log/<id>.json (the notes' Log section)
 * Order: vaultnote:<id> -> project:<id> -> registry / ledger:<id>, and
 * vaultstate / vaultlog:<id> last (each held only for its own short
 * read-modify-write, never while waiting on another key). Phase 4 locks are
 * never taken inside reader:<id> or project:<id>.
 * Never take an outer key while holding an inner one, and never re-enter a key.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}
