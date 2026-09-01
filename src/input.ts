export interface AccountInput {
  raw: string
  uid?: string
  name?: string
}

function uidFromUrl(value: string): string | null {
  const match = value.match(/(?:weibo\.com|weibo\.cn)\/(?:u\/)?(\d{5,})/i)
  return match?.[1] ?? null
}

export function parseAccountInput(line: string): AccountInput | null {
  const raw = line.trim()
  if (!raw || raw.startsWith('#')) return null

  const withoutInlineComment = raw.replace(/\s+#.*$/, '').trim()
  const urlUid = uidFromUrl(withoutInlineComment)
  if (urlUid) return { raw, uid: urlUid }

  const uidWithLabel = withoutInlineComment.match(/^(\d{5,})(?:\s+.*)?$/)
  if (uidWithLabel) return { raw, uid: uidWithLabel[1] }

  const name = withoutInlineComment.replace(/^@/, '').trim()
  return name ? { raw, name } : null
}

export function parseAccountList(content: string): AccountInput[] {
  const seen = new Set<string>()
  const result: AccountInput[] = []
  for (const line of content.split(/\r?\n/)) {
    const input = parseAccountInput(line)
    if (!input) continue
    const key = input.uid ? `uid:${input.uid}` : `name:${input.name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(input)
  }
  return result
}
