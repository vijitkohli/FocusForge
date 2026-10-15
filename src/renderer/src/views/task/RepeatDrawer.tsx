import { useState, type JSX } from 'react'
import type { ProjectTask } from 'src/common/types'
import { weekdayOf } from 'src/common/recurrence'
import { localDateKey } from 'src/common/schedule'
import { isValidDateKey } from 'src/common/outline'
import { Button, DateInput, Drawer, Select } from '../../ui'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function tenWeeksAfter(key: string): string {
  const d = new Date(`${key}T00:00:00`)
  d.setDate(d.getDate() + 70)
  return localDateKey(d)
}

interface RepeatDrawerProps {
  open: boolean
  task: ProjectTask
  onClose: () => void
  onSave: (weekday: number, until: string) => Promise<void>
}

/** "Repeat weekly…": weekday and end date for a task series (this task is week 1). */
export function RepeatDrawer({ open, task, onClose, onSave }: RepeatDrawerProps): JSX.Element {
  const rule = task.recurrence
  const [weekday, setWeekday] = useState(String(rule?.weekday ?? weekdayOf(task.deadline)))
  const [until, setUntil] = useState(rule?.until ?? tenWeeksAfter(task.deadline))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (!isValidDateKey(until) || until <= task.deadline) {
      setError('Choose an end date after this task is due.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(Number(weekday), until)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => {
        if (!saving) onClose()
      }}
      title="Repeat weekly"
      description="A fresh copy of these steps appears a week before each due date. This task stays week 1."
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Select
          label="Due every"
          value={weekday}
          onChange={(event) => setWeekday(event.target.value)}
        >
          {WEEKDAYS.map((day, index) => (
            <option key={day} value={String(index)}>
              {day}
            </option>
          ))}
        </Select>
        <div className="w-[200px]">
          <DateInput
            label="Until"
            pickerLabel="Open calendar for the last week"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
            error={error ?? undefined}
          />
        </div>
        <p className="text-sm text-fg-2">
          Completed steps, Focus time and notes are never copied. Deleting one week&rsquo;s copy
          doesn&rsquo;t bring it back.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={saving} loadingLabel="Saving">
            {rule ? 'Update' : 'Repeat weekly'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
