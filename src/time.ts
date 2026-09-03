export const BEIJING_TIME_ZONE = 'Asia/Shanghai'

// China has used UTC+08:00 continuously since 1991. This conversion is only
// used for the crawler's current/future next-midnight boundary; display and
// civil-date extraction still use the IANA zone above.
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

const beijingPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BEIJING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export interface BeijingDateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function hasExplicitTimeZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})(?:\s+\d{4})?$/i.test(value.trim())
}

function toAbsoluteDate(value: Date | string | number): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null
  }
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date : null
  }
  if (!hasExplicitTimeZone(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time) : null
}

export function toUtcIso(value: Date | string | number): string | null {
  return toAbsoluteDate(value)?.toISOString() ?? null
}

export function getBeijingParts(value: Date | string | number = Date.now()): BeijingDateTimeParts | null {
  const date = toAbsoluteDate(value)
  if (!date) return null

  const values: Partial<BeijingDateTimeParts> = {}
  for (const part of beijingPartsFormatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      const key = part.type as keyof BeijingDateTimeParts
      values[key] = Number(part.value)
    }
  }
  if (Object.values(values).some(valuePart => !Number.isFinite(valuePart))) return null
  return values as BeijingDateTimeParts
}

export function formatBeijingDateTime(value: Date | string | number): string {
  const parts = getBeijingParts(value)
  if (!parts) return ''
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
}

export function nextBeijingMidnightUnix(now: Date | string | number = Date.now()): number {
  const parts = getBeijingParts(now)
  if (!parts) throw new TypeError('无效的绝对时间')
  const nextMidnightUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day + 1) - BEIJING_UTC_OFFSET_MS
  return Math.floor(nextMidnightUtcMs / 1000)
}
