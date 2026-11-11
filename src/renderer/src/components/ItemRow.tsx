import { useEffect, useRef, useState, type JSX } from 'react'
import { EyeOff, FileText, FolderPlus, Folder, Pencil, X } from 'lucide-react'
import type { CandidateSource } from 'src/common/discovery'
import type { WorkstreamKind, WorkstreamStatus } from 'src/common/types'
import { CATEGORIES, type ItemCategory } from 'src/common/workstreams'
import type { ApprovalAction, ItemRowState } from '../lib/itemApproval'
import { Button, Checkbox, Cover, IconButton, Input, Menu, SegmentedControl, Select } from '../ui'

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'archived', label: 'Archived' }
] as const satisfies readonly { value: WorkstreamStatus; label: string }[]

const KIND_LABELS: Record<WorkstreamKind, string> = {
  deadline: 'Deadline',
  passion: 'Passion',
  ongoing: 'Ongoing'
}

const MATCH_NOTES: Partial<Record<CandidateSource['match'], string>> = {
  similar: 'Similar name',
  merge: 'Merged'
}

export interface ItemRowProps {
  row: ItemRowState
  dispatch: (action: ApprovalAction) => void
  /** Opens the native picker and attaches what's picked to this row. */
  onAttachSource: (key: string) => void
  notice?: string
  disabled?: boolean
}

function SourceChip({
  source,
  onDetach,
  disabled
}: {
  source: CandidateSource
  onDetach: () => void
  disabled: boolean
}): JSX.Element {
  const Icon = source.type === 'folder' || source.type === 'vault-folder' ? Folder : FileText
  const note = MATCH_NOTES[source.match]
  return (
    <li className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-bg-2 py-0.5 pr-0.5 pl-2.5 text-[12.5px] leading-[1.4] text-fg-2">
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-fg-3" />
      <span className="truncate">{source.label}</span>
      {note && <span className="shrink-0 text-fg-3">· {note}</span>}
      <IconButton
        label={`Detach ${source.label}`}
        icon={X}
        disabled={disabled}
        onClick={onDetach}
        className="size-6!"
      />
    </li>
  )
}

export function ItemRow({
  row,
  dispatch,
  onAttachSource,
  notice,
  disabled = false
}: ItemRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = (): void => {
    if (draft.trim() && draft.trim() !== row.name) {
      dispatch({ type: 'rename', key: row.key, name: draft })
    } else setDraft(row.name)
    setEditing(false)
  }

  const menuItems = [
    {
      id: 'rename',
      label: 'Rename',
      icon: Pencil,
      onSelect: () => {
        setDraft(row.name)
        setEditing(true)
      }
    },
    ...(row.suggestedName && row.suggestedName !== row.name
      ? [
          {
            id: 'suggested',
            label: `Call it ${row.suggestedName}`,
            onSelect: () => dispatch({ type: 'rename', key: row.key, name: row.suggestedName! })
          }
        ]
      : []),
    ...(!row.manual
      ? [
          {
            id: 'attach',
            label: 'Add a folder or note',
            icon: FolderPlus,
            onSelect: () => onAttachSource(row.key)
          }
        ]
      : []),
    {
      id: 'hide',
      label: 'Hide',
      icon: EyeOff,
      disabled: row.existing,
      onSelect: () => dispatch({ type: 'hide', key: row.key })
    }
  ]

  return (
    <li
      data-item-key={row.key}
      className={`flex flex-wrap items-start gap-x-4 gap-y-3 rounded-md border border-line bg-bg-1 p-4 transition-opacity motion-reduce:transition-none ${
        row.included ? '' : 'opacity-75'
      }`}
    >
      <div className="flex min-w-0 flex-[1_1_320px] items-start gap-3">
        <div className="flex h-10 items-center">
          {row.existing ? (
            <span className="size-[18px]" aria-hidden="true" />
          ) : (
            <Checkbox
              aria-label={`Include ${row.name}`}
              checked={row.included}
              disabled={disabled}
              onChange={() => dispatch({ type: 'toggleInclude', key: row.key })}
            />
          )}
        </div>
        <Cover projectId={row.adoptsProjectId ?? row.key} name={row.name} size={40} decorative />
        <div className="min-w-0 flex-1 space-y-1.5">
          {editing ? (
            <Input
              ref={inputRef}
              aria-label={`Name for ${row.name}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(row.name)
                  setEditing(false)
                }
              }}
            />
          ) : (
            <h3 className="flex flex-wrap items-baseline gap-x-2 text-[15px] leading-[1.35] font-[550] text-fg-1">
              <span className="min-w-0 break-words">{row.name}</span>
              {row.existing && (
                <span className="text-[12.5px] font-normal text-fg-3">Already in FocusForge</span>
              )}
            </h3>
          )}
          {row.sources.length > 0 && (
            <ul aria-label={`Sources for ${row.name}`} className="flex flex-wrap gap-1.5">
              {row.sources.map((source) => (
                <SourceChip
                  key={source.path}
                  source={source}
                  disabled={disabled}
                  onDetach={() =>
                    dispatch({ type: 'detachSource', key: row.key, path: source.path })
                  }
                />
              ))}
            </ul>
          )}
          {row.reasons.length > 0 && (
            <p className="text-[12.5px] leading-[1.4] text-fg-3">
              {row.reasons
                .filter((r) => r !== 'Already in FocusForge')
                .slice(0, 2)
                .join(' · ')}
            </p>
          )}
          {row.manual && (
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={FolderPlus}
              disabled={disabled}
              onClick={() => onAttachSource(row.key)}
            >
              Add a folder or note
            </Button>
          )}
          {notice && (
            <p role="alert" className="text-[12.5px] leading-[1.4] text-medium">
              {notice}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {row.included && (
          <SegmentedControl
            label={`Status for ${row.name}`}
            options={STATUS_OPTIONS}
            value={row.status}
            disabled={disabled}
            onChange={(status) => dispatch({ type: 'setStatus', key: row.key, status })}
          />
        )}
        <div className="w-[128px]">
          <Select
            aria-label={`Category for ${row.name}`}
            value={row.category}
            disabled={disabled}
            onChange={(event) =>
              dispatch({
                type: 'setCategory',
                key: row.key,
                category: event.target.value as ItemCategory
              })
            }
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        {row.included && (
          <div className="w-[120px]">
            <Select
              aria-label={`Kind for ${row.name}`}
              value={row.kind}
              disabled={disabled}
              onChange={(event) =>
                dispatch({
                  type: 'setKind',
                  key: row.key,
                  kind: event.target.value as WorkstreamKind
                })
              }
            >
              {(Object.keys(KIND_LABELS) as WorkstreamKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
        )}
        <Menu label={`More for ${row.name}`} disabled={disabled} items={menuItems} />
      </div>
    </li>
  )
}
