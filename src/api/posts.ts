import { htmlToText } from '../html.js'
import { mapConcurrent } from '../concurrency.js'
import { nextBeijingMidnightUnix, toUtcIso } from '../time.js'
import type {
  CrawlSourceMeta,
  ProfileListingEndpoint,
  ProfileListingSource,
  WeiboAccount,
  WeiboMediaType,
  WeiboPost,
} from '../types.js'
import {
  DEEP_PROFILE_FEED_POST_THRESHOLD,
  DEEP_PROFILE_FEED_REQUEST_DELAY_MS,
  WeiboApiClient,
} from './client.js'

export type { ProfileListingEndpoint, ProfileListingSource } from '../types.js'

type RawObject = Record<string, any>

interface ProfileData {
  user?: RawObject
}

interface FeedData {
  total?: number | string
  since_id?: number | string
  list?: RawObject[]
}

interface ExtendedTextData {
  longTextContent?: string
}

export interface AsyncTaskGate {
  run<T>(task: () => Promise<T>): Promise<T>
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0
}

function isoDate(value: string): string | null {
  return toUtcIso(value)
}

function isAudioPage(raw: RawObject): boolean {
  const pageInfo = raw.page_info
  if (!pageInfo || typeof pageInfo !== 'object') return false
  const objectType = String(pageInfo.object_type ?? '').toLowerCase()
  return objectType === 'podcast_audio' || objectType === 'audio'
}

function extractAudioTitle(raw: RawObject): string | null {
  if (!isAudioPage(raw)) return null
  const pageInfo = raw.page_info ?? {}
  const candidates = [
    pageInfo.card_info?.title,
    pageInfo.media_info?.title,
  ]
  for (const candidate of candidates) {
    const title = htmlToText(String(candidate ?? '')).trim()
    if (title) return title
  }
  return null
}

function extractMediaSummary(raw: RawObject): {
  mediaType: WeiboMediaType
  mediaCount: number
  pictureCount: number
  videoCount: number
} {
  const mixedItems = Array.isArray(raw.mix_media_info?.items) ? raw.mix_media_info.items : []
  let pictureCount = mixedItems.filter((item: RawObject) => item?.type === 'pic').length
  let videoCount = mixedItems.filter((item: RawObject) => item?.type === 'video').length
  if (mixedItems.length === 0) {
    const standaloneVideo = raw.page_info?.object_type === 'video'
    videoCount = standaloneVideo ? 1 : 0
    pictureCount = standaloneVideo ? 0 : Math.max(numberValue(raw.pic_num), Array.isArray(raw.pics) ? raw.pics.length : 0)
  }
  const mediaCount = pictureCount + videoCount
  let mediaType: WeiboMediaType = 'none'
  if (pictureCount > 0 && videoCount > 0) mediaType = 'mixed'
  else if (videoCount > 0) mediaType = 'video'
  else if (pictureCount > 0) mediaType = 'pictures'
  else if (isAudioPage(raw)) mediaType = 'audio'
  else if (raw.page_info && typeof raw.page_info === 'object') mediaType = 'link'
  return {
    mediaType,
    mediaCount: mediaCount || (mediaType === 'link' || mediaType === 'audio' ? 1 : 0),
    pictureCount,
    videoCount,
  }
}

export function needsLongText(raw: RawObject): boolean {
  if (raw.isLongText !== true) return false

  const declaredLength = Number(raw.textLength)
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) return true

  const visibleText = typeof raw.text_raw === 'string'
    ? raw.text_raw
    : htmlToText(String(raw.text ?? ''))

  // Weibo also sets isLongText on some short media posts. Their declared
  // length is close to the already returned text and the longtext endpoint is
  // empty. Real truncated posts have a much larger declared body.
  return declaredLength > 280 || declaredLength > visibleText.length + 50
}

export function normalizePost(raw: RawObject, pinned = false): WeiboPost {
  const user = raw.user ?? {}
  const userId = String(user.id ?? raw.user_id ?? '')
  const bid = String(raw.bid ?? raw.mblogid ?? '')
  const textHtml = String(raw.text ?? '')
  const hasRetweetedStatus = Boolean(raw.retweeted_status && typeof raw.retweeted_status === 'object')
  const normalizedRetweeted = hasRetweetedStatus ? normalizePost(raw.retweeted_status) : null
  // Deleted/private originals are returned as text-only placeholders without
  // an author. Keep the accessible top-level repost, but do not export a fake
  // original post with an empty URL.
  const retweeted = normalizedRetweeted?.url ? normalizedRetweeted : null
  const media = extractMediaSummary(raw)

  return {
    id: String(raw.id ?? raw.mid ?? ''),
    mid: String(raw.mid ?? raw.id ?? ''),
    bid,
    url: bid && userId ? `https://weibo.com/${userId}/${bid}` : '',
    userId,
    screenName: String(user.screen_name ?? ''),
    createdAt: isoDate(String(raw.created_at ?? '')),
    createdAtRaw: String(raw.created_at ?? ''),
    text: htmlToText(textHtml),
    textHtml,
    textComplete: !needsLongText(raw),
    source: htmlToText(String(raw.source ?? '')),
    regionName: String(raw.region_name ?? ''),
    attitudesCount: numberValue(raw.attitudes_count),
    commentsCount: numberValue(raw.comments_count),
    repostsCount: numberValue(raw.reposts_count),
    isPinned: pinned || raw.isTop === 1,
    isRetweet: hasRetweetedStatus,
    listingSources: [],
    ...media,
    audioTitle: extractAudioTitle(raw),
    retweetedStatus: retweeted,
  }
}

export async function getAccount(
  uid: string,
  client = new WeiboApiClient(),
): Promise<WeiboAccount> {
  const data = await client.get<ProfileData>('/ajax/profile/info', {
    uid,
  })
  const user = data.user
  if (!user?.id || !user?.screen_name) throw new Error(`未找到微博 UID ${uid}`)
  return {
    id: String(user.id),
    screenName: String(user.screen_name),
    description: String(user.description ?? ''),
    followersCount: user.followers_count ?? 0,
    verified: user.verified === true,
    verifiedReason: String(user.verified_reason ?? ''),
    statusesCount: numberValue(user.statuses_count),
    followCount: numberValue(user.follow_count),
    mbrank: numberValue(user.mbrank),
    profileUrl: `https://weibo.com/u/${uid}`,
  }
}

export interface FetchPostsOptions {
  limit?: number
  maxPages?: number
  fetchLongText?: boolean
  /** Internal switch used while combined mode enumerates each source before merging. */
  enrichDetails?: boolean
  detailConcurrency?: number
  /** Optional separately throttled client for long-text and audio-title detail requests. */
  detailClient?: WeiboApiClient
  /** Optional client dedicated to the legacy profile timeline. */
  profileFeedClient?: WeiboApiClient
  /** Optional shared gate limiting how many accounts enumerate the legacy timeline at once. */
  profileFeedGate?: AsyncTaskGate
  /**
   * `combined` runs both independent profile indexes and merges them by post
   * ID. A single endpoint can still be selected for diagnostics.
   */
  listingSource?: ProfileListingSource
  onPage?: (
    page: number,
    fetched: number,
    total: number | null,
    source: ProfileListingEndpoint,
  ) => void
  onDetail?: (completed: number, total: number) => void
  onSourceComplete?: (stats: CrawlSourceMeta, source: ProfileListingEndpoint) => void
  /** Raise only this account's legacy-timeline delay after this many collected posts. */
  profileFeedDeepThreshold?: number
  profileFeedDeepDelayMs?: number
  onProfileFeedDeepDelay?: (fetched: number, delayMs: number) => void
}

export interface FetchPostsResult {
  posts: WeiboPost[]
  listingSource: ProfileListingSource
  sourceStats: Partial<Record<ProfileListingEndpoint, CrawlSourceMeta>>
  reportedTotal: number | null
  pagesFetched: number
  exhausted: boolean
  stoppedReason: 'exhausted' | 'limit' | 'max-pages' | 'pagination-stalled'
  fullTextFailures: number
  audioTitleFailures: number
  filteredOutCount: number
}

async function fetchProfilePage(
  uid: string,
  page: number,
  listingSource: ProfileListingEndpoint,
  searchEndTime: number,
  sinceId: string | number | undefined,
  client: WeiboApiClient,
): Promise<FeedData> {
  const cursor: Record<string, string | number> = {}
  if (sinceId !== undefined) cursor.since_id = sinceId
  if (listingSource === 'profile-feed') {
    // Retained for compatibility and endpoint comparison. This is the
    // unfiltered profile timeline shown before the user submits the desktop
    // advanced-search form; it may omit public posts.
    return client.get<FeedData>('/ajax/statuses/mymblog', {
      uid,
      page,
      feature: 0,
      ...cursor,
    }, { allowEmpty: true })
  }

  // These are the six checked-by-default content types in Weibo's desktop
  // profile advanced search. The frontend maps the URL controls to these API
  // names and removes the legacy `feature` parameter before requesting.
  return client.get<FeedData>('/ajax/statuses/searchProfile', {
    uid,
    page,
    hasori: 1,
    hasret: 1,
    hastext: 1,
    haspic: 1,
    hasvideo: 1,
    hasmusic: 1,
    endtime: searchEndTime,
    ...cursor,
  }, { allowEmpty: true })
}

async function enrichLongText(post: WeiboPost, client: WeiboApiClient): Promise<boolean> {
  if (post.textComplete) return true
  try {
    const data = await client.get<ExtendedTextData>('/ajax/statuses/longtext', { id: post.id })
    if (!data.longTextContent) {
      // Desktop feeds sometimes mark short media posts as isLongText even
      // though no extended body exists. An explicit empty payload means the
      // list text is already the complete available body, not a failed fetch.
      post.textComplete = true
      return true
    }
    post.textHtml = data.longTextContent
    post.text = htmlToText(data.longTextContent)
    post.textComplete = true
    return true
  } catch {
    return false
  }
}

function needsAudioTitle(post: WeiboPost): boolean {
  return (post.mediaType === 'audio' && !post.audioTitle) ||
    (post.retweetedStatus?.mediaType === 'audio' && !post.retweetedStatus.audioTitle)
}

async function enrichAudioTitle(post: WeiboPost, client: WeiboApiClient): Promise<boolean> {
  if (!needsAudioTitle(post)) return true
  try {
    const raw = await client.getRaw<RawObject>('/ajax/statuses/show', {
      id: post.id,
      locale: 'zh-CN',
      isGetLongText: 'true',
    })
    if (post.mediaType === 'audio' && !post.audioTitle) {
      post.audioTitle = extractAudioTitle(raw)
    }
    if (post.retweetedStatus?.mediaType === 'audio' && !post.retweetedStatus.audioTitle) {
      post.retweetedStatus.audioTitle = extractAudioTitle(raw.retweeted_status ?? {})
    }
    return !needsAudioTitle(post)
  } catch {
    return false
  }
}

async function enrichPostDetails(
  posts: WeiboPost[],
  options: FetchPostsOptions,
  client: WeiboApiClient,
): Promise<{ fullTextFailures: number; audioTitleFailures: number }> {
  const longTextPending = options.fetchLongText === false
    ? []
    : posts.filter(post => !post.textComplete)
  const audioPending = posts.filter(needsAudioTitle)
  const detailConcurrency = Math.max(1, Math.floor(options.detailConcurrency ?? 3))
  const total = longTextPending.length + audioPending.length
  let completed = 0

  const longTextOutcomes = await mapConcurrent(longTextPending, detailConcurrency, async post => {
    const ok = await enrichLongText(post, options.detailClient ?? client)
    options.onDetail?.(++completed, total)
    return ok
  })
  const audioOutcomes = await mapConcurrent(audioPending, detailConcurrency, async post => {
    const ok = await enrichAudioTitle(post, options.detailClient ?? client)
    options.onDetail?.(++completed, total)
    return ok
  })
  return {
    fullTextFailures: longTextOutcomes.filter(ok => !ok).length,
    audioTitleFailures: audioOutcomes.filter(ok => !ok).length,
  }
}

export async function fetchAllPosts(
  uid: string,
  options: FetchPostsOptions = {},
  client = new WeiboApiClient(),
): Promise<FetchPostsResult> {
  const listingSource = options.listingSource ?? 'combined'
  if (listingSource !== 'combined') {
    const sourceClient = listingSource === 'profile-feed'
      ? options.profileFeedClient ?? client
      : client
    return fetchPostsFromSourceWithGate(uid, listingSource, options, sourceClient)
  }

  // Keep the two endpoint crawls sequential for one account. A real-account
  // regression showed that interleaving their page requests made
  // searchProfile return fewer IDs, while an immediate standalone rerun
  // recovered them. Details remain disabled until after the union, so a post
  // returned by both sources is enriched only once.
  const sourceOptions: FetchPostsOptions = { ...options, fetchLongText: false, enrichDetails: false }
  const advanced = await fetchPostsFromSource(uid, 'profile-search', sourceOptions, client)
  const legacy = await fetchPostsFromSourceWithGate(
    uid,
    'profile-feed',
    sourceOptions,
    options.profileFeedClient ?? client,
  )

  const mergedById = new Map<string, WeiboPost>()
  for (const sourceResult of [advanced, legacy]) {
    for (const post of sourceResult.posts) {
      const existing = mergedById.get(post.id)
      if (!existing) {
        mergedById.set(post.id, post)
        continue
      }

      const sources = [...new Set([...existing.listingSources, ...post.listingSources])]
      const existingScore =
        (existing.textComplete ? 1_000_000 : 0) + existing.text.length + existing.mediaCount * 10 +
        (existing.audioTitle ? 100 : 0)
      const candidateScore =
        (post.textComplete ? 1_000_000 : 0) + post.text.length + post.mediaCount * 10 +
        (post.audioTitle ? 100 : 0)
      const chosen = candidateScore > existingScore ? post : existing
      chosen.listingSources = sources
      chosen.isPinned = existing.isPinned || post.isPinned
      mergedById.set(post.id, chosen)
    }
  }

  const limit = options.limit && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY
  const posts = [...mergedById.values()]
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
      const aTime = Date.parse(a.createdAt ?? a.createdAtRaw) || 0
      const bTime = Date.parse(b.createdAt ?? b.createdAtRaw) || 0
      return bTime - aTime || b.id.localeCompare(a.id)
    })
    .slice(0, limit)

  const details = await enrichPostDetails(posts, options, client)

  let stoppedReason: FetchPostsResult['stoppedReason']
  if (Number.isFinite(limit) && posts.length >= limit) stoppedReason = 'limit'
  else if (advanced.exhausted && legacy.exhausted) stoppedReason = 'exhausted'
  else if ([advanced.stoppedReason, legacy.stoppedReason].includes('pagination-stalled')) {
    stoppedReason = 'pagination-stalled'
  } else stoppedReason = 'max-pages'

  return {
    posts,
    listingSource: 'combined',
    sourceStats: { ...advanced.sourceStats, ...legacy.sourceStats },
    // The two totals describe overlapping, internally inconsistent indexes;
    // summing them would not describe the union.
    reportedTotal: null,
    pagesFetched: advanced.pagesFetched + legacy.pagesFetched,
    exhausted: stoppedReason === 'exhausted',
    stoppedReason,
    ...details,
    filteredOutCount: advanced.filteredOutCount + legacy.filteredOutCount,
  }
}

async function fetchPostsFromSourceWithGate(
  uid: string,
  listingSource: ProfileListingEndpoint,
  options: FetchPostsOptions,
  client: WeiboApiClient,
): Promise<FetchPostsResult> {
  const task = () => fetchPostsFromSource(uid, listingSource, options, client)
  if (listingSource === 'profile-feed' && options.profileFeedGate) {
    return options.profileFeedGate.run(task)
  }
  return task()
}

async function fetchPostsFromSource(
  uid: string,
  listingSource: ProfileListingEndpoint,
  options: FetchPostsOptions,
  client: WeiboApiClient,
): Promise<FetchPostsResult> {
  const limit = options.limit && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY
  const maxPages = options.maxPages && options.maxPages > 0 ? options.maxPages : Number.POSITIVE_INFINITY
  // Keep one fixed boundary for the whole crawl so a run crossing midnight
  // cannot change its result set between pages.
  const searchEndTime = nextBeijingMidnightUnix()
  const posts: WeiboPost[] = []
  const seen = new Set<string>()
  let page = 1
  let sinceId: string | number | undefined
  let pagesFetched = 0
  let reportedTotal: number | null = null
  let fullTextFailures = 0
  let audioTitleFailures = 0
  let filteredOutCount = 0
  let stoppedReason: FetchPostsResult['stoppedReason'] | null = null
  const profileFeedDeepThreshold = Math.max(
    0,
    Math.floor(options.profileFeedDeepThreshold ?? DEEP_PROFILE_FEED_POST_THRESHOLD),
  )
  const profileFeedDeepDelayMs = Math.max(
    0,
    Math.floor(options.profileFeedDeepDelayMs ?? DEEP_PROFILE_FEED_REQUEST_DELAY_MS),
  )
  let profileFeedDeepDelayApplied = false

  while (pagesFetched < maxPages && posts.length < limit) {
    const data = await fetchProfilePage(uid, page, listingSource, searchEndTime, sinceId, client)
    pagesFetched++
    // `since_id` is the cursor for the next page. Never retain a cursor from
    // the previous response when the current response returns no usable one.
    const cursorExhausted = data.since_id !== undefined && String(data.since_id) === ''
    sinceId = data.since_id !== undefined && String(data.since_id) !== ''
      ? data.since_id
      : undefined
    if (reportedTotal === null) {
      const total = Number(data.total)
      if (Number.isFinite(total) && total >= 0) reportedTotal = total
    }

    const rawPosts = data.list ?? []
    const pagePosts: WeiboPost[] = []
    let newlySeenRawPosts = 0
    for (const raw of rawPosts) {
      const rawId = String(raw.id ?? raw.mid ?? '')
      if (!rawId || seen.has(rawId)) continue
      seen.add(rawId)
      newlySeenRawPosts++
      const post = normalizePost(raw, raw.isTop === 1)
      post.listingSources = [listingSource]
      // The profile endpoint can inject posts merely liked by the target
      // account (title: “她…赞过的微博”). They are valid links but are not
      // authored/reposted by this account, so they do not belong in its export.
      // Authorless deleted/private placeholders are excluded by the same rule.
      if (post.userId !== uid) {
        filteredOutCount++
        continue
      }
      pagePosts.push(post)
    }

    for (const post of pagePosts) {
      posts.push(post)
      if (posts.length >= limit) break
    }

    options.onPage?.(pagesFetched, posts.length, reportedTotal, listingSource)
    if (posts.length >= limit) {
      stoppedReason = 'limit'
      break
    }
    if (rawPosts.length === 0) {
      stoppedReason = 'exhausted'
      break
    }
    // An explicit empty cursor means this is the final page. Do not probe the
    // next page without a cursor: Weibo can then repeat an earlier page and
    // make a naturally exhausted source look like `pagination-stalled`.
    if (cursorExhausted) {
      stoppedReason = 'exhausted'
      break
    }
    if (newlySeenRawPosts === 0) {
      stoppedReason = 'pagination-stalled'
      break
    }
    if (
      listingSource === 'profile-feed' &&
      !profileFeedDeepDelayApplied &&
      profileFeedDeepThreshold > 0 &&
      profileFeedDeepDelayMs > 0 &&
      posts.length >= profileFeedDeepThreshold &&
      pagesFetched < maxPages
    ) {
      profileFeedDeepDelayApplied = true
      if (client.ensureProfileFeedRequestDelay(profileFeedDeepDelayMs)) {
        options.onProfileFeedDeepDelay?.(posts.length, profileFeedDeepDelayMs)
      }
    }
    page++
  }

  if (stoppedReason === null) stoppedReason = pagesFetched >= maxPages ? 'max-pages' : 'exhausted'

  // Phase 2: page discovery is complete. Fetch only genuinely truncated
  // bodies and missing audio titles, so detail calls never block pagination.
  if (options.enrichDetails !== false) {
    const details = await enrichPostDetails(posts, options, client)
    fullTextFailures = details.fullTextFailures
    audioTitleFailures = details.audioTitleFailures
  }

  const sourceMeta: CrawlSourceMeta = {
    reportedTotal,
    pagesFetched,
    returnedCount: posts.length,
    filteredOutCount,
    exhausted: stoppedReason === 'exhausted',
    stoppedReason,
  }
  options.onSourceComplete?.(sourceMeta, listingSource)

  return {
    posts,
    listingSource,
    sourceStats: { [listingSource]: sourceMeta },
    reportedTotal,
    pagesFetched,
    exhausted: stoppedReason === 'exhausted',
    stoppedReason,
    fullTextFailures,
    audioTitleFailures,
    filteredOutCount,
  }
}
