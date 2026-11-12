import { useCallback, useEffect, useId, useState, type JSX } from 'react'
import { FolderSearch, ListChecks } from 'lucide-react'
import type { VaultInfo } from 'src/common/discovery'
import type { SourceRoot } from 'src/common/models'
import { Button, Skeleton } from '../ui'
import { VaultNotesSettings } from './VaultNotesSettings'

interface SourcesSettingsProps {
  /** Opens the item approval screen (a fresh look through the folders). */
  onReviewItems?: () => void
  disabled?: boolean
}

/** `/Users/x/Vault` -> `~/Vault`, for display only. */
function tildePath(p: string, home: string | null): string {
  return home && (p === home || p.startsWith(home + '/')) ? `~${p.slice(home.length)}` : p
}

export function SourcesSettings({
  onReviewItems,
  disabled = false
}: SourcesSettingsProps): JSX.Element {
  const [vault, setVault] = useState<VaultInfo | null>(null)
  const [roots, setRoots] = useState<SourceRoot[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const id = useId()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(false)
    try {
      const [info, settings] = await Promise.all([
        window.api.getVaultInfo(),
        window.api.getSettings()
      ])
      setVault(info)
      setRoots(settings.sourceRoots)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const choose = async (): Promise<void> => {
    if (choosing) return
    setChoosing(true)
    setMessage(null)
    try {
      const picked = await window.api.chooseVaultFolder()
      if (!picked) return
      if ('error' in picked) setMessage({ tone: 'warn', text: picked.error })
      else {
        setVault(picked.vault)
        setMessage({ tone: 'ok', text: 'Vault saved.' })
      }
    } catch {
      setMessage({ tone: 'warn', text: "I couldn't open that folder. Try again." })
    } finally {
      setChoosing(false)
    }
  }

  // The vault path is shown with ~ when it sits under the home folder.
  const home = vault?.path?.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/)?.[1] ?? null

  return (
    <section className="space-y-4 border-t border-line pt-6" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-lg font-bold tracking-[-0.01em] text-fg-1">
        Sources
      </h2>
      <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-2">
        Where FocusForge looks for your courses and projects. It reads names and dates, never writes
        to your folders, and your vault&apos;s Life folder stays closed.
      </p>
      {loading ? (
        <div role="status" aria-label="Loading sources" aria-busy="true" className="space-y-3">
          <Skeleton height={20} width="70%" />
          <Skeleton height={20} width="50%" />
        </div>
      ) : loadError ? (
        <div role="alert" className="space-y-3 rounded-md bg-bg-2 p-4">
          <p className="text-sm text-hard">Couldn&apos;t load your sources.</p>
          <Button onClick={() => void load()}>Retry loading</Button>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-fg-3">Obsidian vault</dt>
            <dd className="min-w-0 break-words text-fg-1">
              {vault?.valid && vault.path ? tildePath(vault.path, home) : 'Not found yet'}
            </dd>
            <dt className="text-fg-3">Folders</dt>
            <dd className="min-w-0">
              <ul aria-label="Folders FocusForge reads" className="space-y-1 text-fg-1">
                {roots.map((root) => (
                  <li key={root.path}>
                    {root.path} <span className="text-fg-3">· starts in {root.category}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[12.5px] text-fg-3">
                These are fixed for now, so nothing new gets read without you knowing.
              </p>
            </dd>
          </dl>
          {message && (
            <p
              role={message.tone === 'warn' ? 'alert' : 'status'}
              className={`text-sm ${message.tone === 'warn' ? 'text-medium' : 'text-easy'}`}
            >
              {message.text}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              leadingIcon={FolderSearch}
              loading={choosing}
              loadingLabel="Choosing vault"
              disabled={disabled}
              onClick={() => void choose()}
            >
              Choose vault folder…
            </Button>
            {onReviewItems && (
              <Button leadingIcon={ListChecks} disabled={disabled} onClick={onReviewItems}>
                Review items
              </Button>
            )}
          </div>
          <VaultNotesSettings disabled={disabled} />
        </>
      )}
    </section>
  )
}
