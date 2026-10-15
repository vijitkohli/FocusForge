// Minimal iCalendar (RFC 5545) writer for "Add to calendar" from Plan today.

export interface IcsEvent {
  uid: string
  title: string
  description?: string
  start: Date // local wall-clock time
  minutes: number
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Floating local time (no zone): the event shows at that clock time wherever it's opened. */
function localStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
}

function utcStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** Folds a content line to 75 octets per RFC 5545 §3.1 (continuations start with a space). */
export function foldLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const char of line) {
    const bytes = encoder.encode(char).length
    const limit = parts.length === 0 ? 75 : 74
    if (size + bytes > limit) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += char
    size += bytes
  }
  parts.push(current)
  return parts.join('\r\n ')
}

/** Back-to-back events starting at `start`. */
export function backToBack(
  items: readonly { key: string; title: string; minutes: number; projectName?: string }[],
  start: Date
): IcsEvent[] {
  let cursor = new Date(start)
  return items.map((item) => {
    const event: IcsEvent = {
      uid: `${item.key.replace(/[^A-Za-z0-9-]/g, '')}-${cursor.getTime()}@focusforge`,
      title: item.title,
      description: item.projectName,
      start: new Date(cursor),
      minutes: item.minutes
    }
    cursor = new Date(cursor.getTime() + item.minutes * 60_000)
    return event
  })
}

export function buildIcs(events: readonly IcsEvent[], now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FocusForge//Plan today//EN',
    'CALSCALE:GREGORIAN'
  ]
  for (const event of events) {
    const end = new Date(event.start.getTime() + event.minutes * 60_000)
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${utcStamp(now)}`,
      `DTSTART:${localStamp(event.start)}`,
      `DTEND:${localStamp(end)}`,
      `SUMMARY:${escapeText(event.title)}`,
      ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
      'END:VEVENT'
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
