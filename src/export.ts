import fsp from 'node:fs/promises'
import path from 'node:path'
import { fetchAllPosts, getAccount, type FetchPostsOptions } from './api/posts.js'
import { SAFE_ACCOUNT_POST_THRESHOLD, WeiboApiClient } from './api/client.js'
import type { CrawlResult, ExportedWeiboPost, WeiboAccount, WeiboPost } from './types.js'

function sanitizePathSegment(value: string): string {
  return value.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'unknown'
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function postsToCsv(posts: Record<string, ExportedWeiboPost>): string {
  const headers = [
    'id', 'bid', 'created_at', 'screen_name', 'text', 'source', 'region_name',
    'attitudes_count', 'comments_count', 'reposts_count', 'is_pinned', 'is_retweet',
    'media_type', 'media_count', 'picture_count', 'video_count', 'audio_title', 'listing_sources', 'url',
    'mid', 'user_id', 'created_at_raw',
    'retweeted_id', 'retweeted_mid', 'retweeted_bid', 'retweeted_created_at',
    'retweeted_created_at_raw', 'retweeted_user_id', 'retweeted_screen_name', 'retweeted_text',
    'retweeted_source', 'retweeted_region_name', 'retweeted_attitudes_count',
    'retweeted_comments_count', 'retweeted_reposts_count', 'retweeted_is_pinned',
    'retweeted_is_retweet', 'retweeted_media_type', 'retweeted_media_count',
    'retweeted_picture_count', 'retweeted_video_count', 'retweeted_audio_title', 'retweeted_listing_sources',
    'retweeted_url',
  ]
  const rows = Object.values(posts).map(post => [
    post.id,
    post.bid,
    post.createdAt ?? post.createdAtRaw,
    post.screenName,
    post.text,
    post.source,
    post.regionName,
    post.attitudesCount,
    post.commentsCount,
    post.repostsCount,
    post.isPinned,
    post.isRetweet,
    post.mediaType,
    post.mediaCount,
    post.pictureCount,
    post.videoCount,
    post.audioTitle ?? '',
    post.listingSources.join('|'),
    post.url,
    post.mid,
    post.userId,
    post.createdAtRaw,
    post.retweetedStatus?.id ?? '',
    post.retweetedStatus?.mid ?? '',
    post.retweetedStatus?.bid ?? '',
    post.retweetedStatus
      ? post.retweetedStatus.createdAt ?? post.retweetedStatus.createdAtRaw
      : '',
    post.retweetedStatus?.createdAtRaw ?? '',
    post.retweetedStatus?.userId ?? '',
    post.retweetedStatus?.screenName ?? '',
    post.retweetedStatus?.text ?? '',
    post.retweetedStatus?.source ?? '',
    post.retweetedStatus?.regionName ?? '',
    post.retweetedStatus?.attitudesCount ?? '',
    post.retweetedStatus?.commentsCount ?? '',
    post.retweetedStatus?.repostsCount ?? '',
    post.retweetedStatus?.isPinned ?? '',
    post.retweetedStatus?.isRetweet ?? '',
    post.retweetedStatus?.mediaType ?? '',
    post.retweetedStatus?.mediaCount ?? '',
    post.retweetedStatus?.pictureCount ?? '',
    post.retweetedStatus?.videoCount ?? '',
    post.retweetedStatus?.audioTitle ?? '',
    post.retweetedStatus?.listingSources?.join('|') ?? '',
    post.retweetedStatus?.url ?? '',
  ].map(csvEscape).join(','))
  return [headers.join(','), ...rows].join('\n') + '\n'
}

export interface ExportAccountOptions extends FetchPostsOptions {
  outputDir?: string
  client?: WeiboApiClient
  /** Optional account profile already fetched by a batch preflight. */
  account?: WeiboAccount
  onLargeAccount?: (statusesCount: number, switchedToSafeMode: boolean) => void
}

export interface ExportPaths {
  result: CrawlResult
  jsonPath: string
  csvPath: string
}

function toExportedPost(post: WeiboPost): ExportedWeiboPost {
  const { textComplete: _, textHtml: __, retweetedStatus, ...stable } = post
  return { ...stable, retweetedStatus: retweetedStatus ? toExportedPost(retweetedStatus) : null }
}

export async function exportAccount(uid: string, options: ExportAccountOptions = {}): Promise<ExportPaths> {
  const client = options.client ?? new WeiboApiClient()
  const profileFeedClient = options.profileFeedClient ?? client.createSibling()
  const account = options.account ?? await getAccount(uid, client)
  if (account.statusesCount > SAFE_ACCOUNT_POST_THRESHOLD) {
    const switchedToSafeMode = profileFeedClient.enableSafeMode()
    options.onLargeAccount?.(account.statusesCount, switchedToSafeMode)
  }
  const fetched = await fetchAllPosts(uid, { ...options, profileFeedClient }, client)
  const posts = Object.fromEntries(fetched.posts.map(post => [post.id, toExportedPost(post)]))
  const limit = options.limit && options.limit > 0 ? options.limit : null
  const result: CrawlResult = {
    account,
    updatedAt: new Date().toISOString(),
    crawl: {
      sessionSource: client.session.source,
      listingSource: fetched.listingSource,
      sourceStats: fetched.sourceStats,
      requestedAll: limit === null && !options.maxPages,
      requestedLimit: limit,
      reportedTotal: fetched.reportedTotal,
      pagesFetched: fetched.pagesFetched,
      exportedCount: fetched.posts.length,
      filteredOutCount: fetched.filteredOutCount,
      exhausted: fetched.exhausted,
      stoppedReason: fetched.stoppedReason,
      completeAgainstReportedTotal:
        fetched.listingSource === 'combined'
          ? fetched.exhausted
          : fetched.exhausted && fetched.reportedTotal !== null && fetched.posts.length >= fetched.reportedTotal,
    },
    posts,
  }

  const root = path.resolve(options.outputDir ?? 'data')
  const accountDir = path.join(root, sanitizePathSegment(account.screenName))
  const jsonPath = path.join(accountDir, `${uid}.json`)
  const csvPath = path.join(accountDir, `${uid}.csv`)
  await fsp.mkdir(accountDir, { recursive: true })
  await fsp.writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8')
  await fsp.writeFile(csvPath, postsToCsv(posts), 'utf8')
  return { result, jsonPath, csvPath }
}
