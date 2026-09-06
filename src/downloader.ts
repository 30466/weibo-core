import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { WeiboApiClient } from './api/client.js'
import {
  resolvePostMedia,
  stableMediaKey,
  type ResolvedMediaItem,
} from './api/media.js'
import type { CrawlResult, ExportedWeiboPost } from './types.js'

const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
const URL_REFRESH_WINDOW_MS = 2 * 60_000

export interface DownloadProgress {
  phase: 'resolving' | 'downloading' | 'complete' | 'skipped' | 'refreshing'
  postId: string
  item?: ResolvedMediaItem
  filePath?: string
}

export interface DownloadPostOptions {
  client?: WeiboApiClient
  outputDir?: string
  includeRetweet?: boolean
  downloadImages?: boolean
  downloadVideos?: boolean
  force?: boolean
  screenName?: string
  createdAt?: string | null
  onProgress?: (progress: DownloadProgress) => void
}

export interface DownloadedMediaFile {
  key: string
  path: string
  relativePath: string
  bytes: number
  sha256: string
  skipped: boolean
  item: ResolvedMediaItem
}

export interface DownloadPostResult {
  postId: string
  postUrl: string
  screenName: string
  postDir: string
  manifestPath: string
  files: DownloadedMediaFile[]
  unresolvedVideoCount: number
}

export interface BatchDownloadOptions extends DownloadPostOptions {
  limit?: number
  year?: number
  month?: number
  onPostComplete?: (completed: number, total: number, result: DownloadPostResult) => void
  onPostError?: (completed: number, total: number, post: ExportedWeiboPost, error: Error) => void
}

export interface BatchDownloadResult {
  selectedPosts: number
  completedPosts: number
  failedPosts: number
  downloadedFiles: number
  skippedFiles: number
  errors: Array<{ postId: string; message: string }>
}

export class DownloadHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

interface ManifestEntry {
  postId: string
  sourcePostId: string
  mediaId: string
  source: ResolvedMediaItem['source']
  kind: ResolvedMediaItem['kind']
  index: number
  path: string
  width: number | null
  height: number | null
  bitrate: number | null
  quality: string
  mimeType: string
  bytes: number
  sha256: string
  downloadedAt: string
}

interface DownloadManifest {
  version: 1
  sourceAccount: string
  updatedAt: string
  entries: Record<string, ManifestEntry>
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[\u0000-\u001f/\\?%*:|"<>]/g, '_').trim() || 'unknown'
}

function postFolderName(value: string | null | undefined, postId: string): string {
  const parsed = value ? new Date(value) : null
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return `unknown-time_${sanitizePathSegment(postId)}`
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed)
  const valueOf = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? '00'
  const timestamp =
    `${valueOf('year')}-${valueOf('month')}-${valueOf('day')}_` +
    `${valueOf('hour')}-${valueOf('minute')}-${valueOf('second')}`
  return `${timestamp}_${sanitizePathSegment(postId)}`
}

function filenameFor(item: ResolvedMediaItem): string {
  const prefix = item.source === 'post'
    ? 'post'
    : `retweeted_${sanitizePathSegment(item.sourcePostId)}`
  const suffix = item.kind === 'video'
    ? `v${item.index}`
    : item.kind.startsWith('live-photo')
      ? `lp${item.index}`
      : `p${item.index}`
  const extension = /^\.[a-zA-Z0-9]{2,5}$/.test(item.extension) ? item.extension.toLowerCase() : '.bin'
  return `${prefix}_${suffix}${extension}`
}

function isImage(item: ResolvedMediaItem): boolean {
  return item.kind === 'image' || item.kind === 'gif' || item.kind === 'live-photo-image'
}

function itemSelected(item: ResolvedMediaItem, options: DownloadPostOptions): boolean {
  const images = options.downloadImages !== false
  const videos = options.downloadVideos !== false
  return isImage(item) ? images : videos
}

function expiringSoon(item: ResolvedMediaItem): boolean {
  if (!item.expiresAt) return false
  const expiresAt = Date.parse(item.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt - Date.now() < URL_REFRESH_WINDOW_MS
}

function isRefreshable(error: unknown): boolean {
  return error instanceof DownloadHttpError && [401, 402, 403, 404, 410].includes(error.status ?? 0)
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function existingSize(filePath: string): Promise<number> {
  try {
    return (await fsp.stat(filePath)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/** Download one already-resolved CDN URL atomically, resuming a retained .part file when possible. */
export async function downloadUrlToFile(
  url: string,
  destination: string,
  options: { force?: boolean } = {},
): Promise<{ bytes: number; sha256: string; skipped: boolean }> {
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  if (!options.force) {
    const bytes = await existingSize(destination)
    if (bytes > 0) return { bytes, sha256: await sha256File(destination), skipped: true }
  }

  const partial = `${destination}.part`
  if (options.force) await fsp.rm(partial, { force: true })
  let offset = await existingSize(partial)
  const headers: Record<string, string> = {
    Accept: '*/*',
    Referer: 'https://weibo.com/',
    'User-Agent': DOWNLOAD_USER_AGENT,
  }
  if (offset > 0) headers.Range = `bytes=${offset}-`

  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60_000),
  })
  if (response.status === 416 && offset > 0) {
    const total = Number(response.headers.get('content-range')?.match(/\*\/(\d+)/)?.[1])
    if (Number.isFinite(total) && total === offset) {
      if (options.force) await fsp.rm(destination, { force: true })
      await fsp.rename(partial, destination)
      return { bytes: offset, sha256: await sha256File(destination), skipped: false }
    }
    await fsp.rm(partial, { force: true })
    return downloadUrlToFile(url, destination, options)
  }
  if (!response.ok || !response.body) {
    throw new DownloadHttpError(`媒体下载失败：HTTP ${response.status}`, response.status)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (/text\/html|application\/json/i.test(contentType)) {
    throw new DownloadHttpError(`媒体下载返回了 ${contentType}，签名可能已失效`, response.status)
  }

  const append = offset > 0 && response.status === 206
  if (!append) offset = 0
  await pipeline(
    Readable.fromWeb(response.body as any),
    createWriteStream(partial, { flags: append ? 'a' : 'w' }),
  )
  if (options.force) await fsp.rm(destination, { force: true })
  await fsp.rename(partial, destination)
  const bytes = await existingSize(destination)
  if (bytes <= 0) throw new Error(`媒体下载结果为空：${destination}`)
  return { bytes, sha256: await sha256File(destination), skipped: false }
}

async function loadManifest(manifestPath: string, screenName: string): Promise<DownloadManifest> {
  try {
    const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as DownloadManifest
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { version: 1, sourceAccount: screenName, updatedAt: new Date().toISOString(), entries: {} }
}

async function saveManifest(manifestPath: string, manifest: DownloadManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString()
  const partial = `${manifestPath}.${process.pid}.tmp`
  await fsp.writeFile(partial, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fsp.rename(partial, manifestPath)
}

async function refreshItem(
  postId: string,
  original: ResolvedMediaItem,
  client: WeiboApiClient,
  includeRetweet: boolean,
): Promise<ResolvedMediaItem> {
  const refreshed = await resolvePostMedia(postId, { client, includeRetweet })
  const key = stableMediaKey(original)
  const match = refreshed.items.find(item => stableMediaKey(item) === key)
  if (!match) throw new Error(`刷新微博 ${postId} 后找不到媒体 ${original.id}`)
  return match
}

export async function downloadPostMedia(
  postInput: string,
  options: DownloadPostOptions = {},
): Promise<DownloadPostResult> {
  if (options.downloadImages === false && options.downloadVideos === false) {
    throw new Error('图片和视频不能同时排除')
  }
  const client = options.client ?? new WeiboApiClient()
  options.onProgress?.({ phase: 'resolving', postId: postInput })
  const resolved = await resolvePostMedia(postInput, {
    client,
    includeRetweet: options.includeRetweet !== false,
  })
  const screenName = sanitizePathSegment(options.screenName || resolved.screenName || 'unknown')
  const accountDir = path.resolve(options.outputDir ?? 'downloads', screenName)
  const postDir = path.join(
    accountDir,
    postFolderName(options.createdAt ?? resolved.createdAtRaw, resolved.postId),
  )
  const manifestPath = path.join(accountDir, 'download-manifest.json')
  await fsp.mkdir(postDir, { recursive: true })
  const manifest = await loadManifest(manifestPath, screenName)
  const files: DownloadedMediaFile[] = []

  for (const original of resolved.items.filter(item => itemSelected(item, options))) {
    let item = original
    if (expiringSoon(item)) {
      options.onProgress?.({ phase: 'refreshing', postId: resolved.postId, item })
      item = await refreshItem(resolved.postId, original, client, options.includeRetweet !== false)
    }
    const destination = path.join(postDir, filenameFor(item))
    options.onProgress?.({ phase: 'downloading', postId: resolved.postId, item, filePath: destination })
    let downloaded: Awaited<ReturnType<typeof downloadUrlToFile>>
    try {
      downloaded = await downloadUrlToFile(item.url, destination, { force: options.force })
    } catch (error) {
      if (!isRefreshable(error)) throw error
      options.onProgress?.({ phase: 'refreshing', postId: resolved.postId, item })
      item = await refreshItem(resolved.postId, original, client, options.includeRetweet !== false)
      downloaded = await downloadUrlToFile(item.url, destination, { force: options.force })
    }

    const relativePath = path.relative(accountDir, destination).split(path.sep).join('/')
    const file: DownloadedMediaFile = {
      key: stableMediaKey(item),
      path: destination,
      relativePath,
      ...downloaded,
      item,
    }
    files.push(file)
    manifest.entries[file.key] = {
      postId: resolved.postId,
      sourcePostId: item.sourcePostId,
      mediaId: item.id,
      source: item.source,
      kind: item.kind,
      index: item.index,
      path: relativePath,
      width: item.width,
      height: item.height,
      bitrate: item.bitrate,
      quality: item.quality,
      mimeType: item.mimeType,
      bytes: file.bytes,
      sha256: file.sha256,
      downloadedAt: new Date().toISOString(),
    }
    await saveManifest(manifestPath, manifest)
    options.onProgress?.({
      phase: downloaded.skipped ? 'skipped' : 'complete',
      postId: resolved.postId,
      item,
      filePath: destination,
    })
  }

  return {
    postId: resolved.postId,
    postUrl: resolved.postUrl,
    screenName,
    postDir,
    manifestPath,
    files,
    unresolvedVideoCount: resolved.unresolvedVideoCount,
  }
}

function postHasSelectedMedia(post: ExportedWeiboPost, options: BatchDownloadOptions): boolean {
  const own = (options.downloadImages !== false && post.pictureCount > 0) ||
    (options.downloadVideos !== false && post.videoCount > 0)
  if (own || options.includeRetweet === false || !post.retweetedStatus) return own
  return (options.downloadImages !== false && post.retweetedStatus.pictureCount > 0) ||
    (options.downloadVideos !== false && post.retweetedStatus.videoCount > 0)
}

function postBeijingParts(post: ExportedWeiboPost): { year: number; month: number } | null {
  const value = post.createdAt ?? post.createdAtRaw
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date)
  return {
    year: Number(parts.find(part => part.type === 'year')?.value),
    month: Number(parts.find(part => part.type === 'month')?.value),
  }
}

export async function downloadCrawlResult(
  crawl: CrawlResult,
  options: BatchDownloadOptions = {},
): Promise<BatchDownloadResult> {
  if (options.year !== undefined && (!Number.isInteger(options.year) || options.year < 1)) {
    throw new Error('year 必须是正整数')
  }
  if (options.month !== undefined && (!Number.isInteger(options.month) || options.month < 1 || options.month > 12)) {
    throw new Error('month 必须是 1 到 12')
  }
  if (options.month !== undefined && options.year === undefined) {
    throw new Error('按月份筛选时必须同时指定 year')
  }
  const posts = Object.values(crawl.posts)
    .filter(post => postHasSelectedMedia(post, options))
    .filter(post => {
      const parts = postBeijingParts(post)
      return options.year === undefined || parts?.year === options.year &&
        (options.month === undefined || parts.month === options.month)
    })
    .slice(0, options.limit ?? Object.keys(crawl.posts).length)
  const client = options.client ?? new WeiboApiClient()
  const result: BatchDownloadResult = {
    selectedPosts: posts.length,
    completedPosts: 0,
    failedPosts: 0,
    downloadedFiles: 0,
    skippedFiles: 0,
    errors: [],
  }
  let processed = 0
  for (const post of posts) {
    try {
      const downloaded = await downloadPostMedia(post.id, {
        ...options,
        client,
        screenName: crawl.account.screenName,
        createdAt: post.createdAt ?? post.createdAtRaw,
      })
      result.completedPosts++
      result.downloadedFiles += downloaded.files.filter(file => !file.skipped).length
      result.skippedFiles += downloaded.files.filter(file => file.skipped).length
      processed++
      options.onPostComplete?.(processed, posts.length, downloaded)
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      result.failedPosts++
      result.errors.push({ postId: post.id, message: normalized.message })
      processed++
      options.onPostError?.(processed, posts.length, post, normalized)
    }
  }
  return result
}

export function postIdFromInput(input: string): string {
  const value = input.trim()
  if (/^[A-Za-z0-9]+$/.test(value)) return value
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/').filter(Boolean)
    const candidate = parts.at(-1) === 'detail' ? '' : parts.at(-1)
    if (candidate && /^[A-Za-z0-9]+$/.test(candidate)) return candidate
    const detailIndex = parts.lastIndexOf('detail')
    const detailId = detailIndex >= 0 ? parts[detailIndex + 1] : ''
    if (detailId && /^[A-Za-z0-9]+$/.test(detailId)) return detailId
  } catch {
    // The final error below gives the accepted forms without exposing URL internals.
  }
  throw new Error('微博参数必须是帖子 ID/BID，或 weibo.com、m.weibo.cn 的帖子链接')
}
