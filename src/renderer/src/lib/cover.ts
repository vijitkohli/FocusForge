export interface ProjectCover {
  hue: 'cover-1' | 'cover-2' | 'cover-3' | 'cover-4' | 'cover-5'
  band: 0 | 1 | 2 | 3
  lines: [string, string]
}

export function coverFor(projectId: string, name: string): ProjectCover {
  let hash = 0
  for (let i = 0; i < projectId.length; i++) {
    hash = (Math.imul(hash, 31) + projectId.charCodeAt(i)) >>> 0
  }
  const title = name.trim()
  // Course codes match case-insensitively ("comp9321", "COMP 6991") and render uppercase.
  const course = /^([a-z]{4})\s*(\d{4})$/i.exec(title)
  const words = title.split(/\s+/)
  return {
    hue: `cover-${(hash % 5) + 1}` as ProjectCover['hue'],
    band: (hash % 4) as ProjectCover['band'],
    lines: course ? [course[1].toUpperCase(), course[2]] : [words[0] ?? '', words[1] ?? '']
  }
}
