import { WeiboApiClient } from './client.js'
import type { WeiboUserResult } from '../types.js'
import { htmlToText } from '../html.js'

interface RawUser {
  id?: string | number
  screen_name?: string
  description?: string
  followers_count?: number | string
  verified?: boolean
  verified_reason?: string
}

interface SearchData {
  users?: RawUser[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeUser(user: RawUser): WeiboUserResult | null {
  if (user.id === undefined || !user.screen_name) return null
  return {
    id: String(user.id),
    screenName: user.screen_name,
    description: user.description ?? '',
    followersCount: user.followers_count ?? 0,
    verified: user.verified === true,
    verifiedReason: user.verified_reason ?? '',
  }
}

export function extractSearchUsers(cards: unknown[]): WeiboUserResult[] {
  const result: WeiboUserResult[] = []
  const seen = new Set<string>()

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isObject(value)) return

    if (isObject(value.user)) {
      const user = normalizeUser(value.user as RawUser)
      if (user && !seen.has(user.id)) {
        seen.add(user.id)
        result.push(user)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'user' || key === 'mblog') continue
      visit(child)
    }
  }

  visit(cards)
  return result
}

export function extractSearchPageUsers(html: string): WeiboUserResult[] {
  const result: WeiboUserResult[] = []
  const seen = new Set<string>()
  const pattern = /href="\/\/weibo\.com\/u\/(\d+)"[^>]*class="name"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<span class="s-nobr">粉丝：([^<]*)<\/span>/g
  for (const match of html.matchAll(pattern)) {
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      screenName: htmlToText(match[2]).trim(),
      description: '',
      followersCount: match[3].trim(),
      verified: false,
      verifiedReason: '',
    })
  }
  return result
}

export async function searchAccounts(
  keyword: string,
  client = new WeiboApiClient(),
): Promise<WeiboUserResult[]> {
  const query = keyword.trim().replace(/^@/, '')
  const data = await client.get<SearchData>('/ajax/side/search', { q: query })
  const seen = new Set<string>()
  const users = (data.users ?? []).flatMap(raw => {
    const user = normalizeUser(raw)
    if (!user || seen.has(user.id)) return []
    seen.add(user.id)
    return [user]
  })
  if (users.length > 0) return users
  const html = await client.getHtml('https://s.weibo.com/user', { q: query })
  return extractSearchPageUsers(html)
}

export async function lookupAccount(
  name: string,
  client = new WeiboApiClient(),
): Promise<WeiboUserResult | null> {
  const query = name.trim().replace(/^@/, '')
  const users = await searchAccounts(query, client)
  return users.find(user => user.screenName === query) ?? null
}
