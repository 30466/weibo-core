import { WeiboApiClient } from './client.js'

type RawObject = Record<string, any>

export type WeiboMediaSource = 'post' | 'retweeted'
export type ResolvedMediaKind = 'image' | 'gif' | 'live-photo-image' | 'live-photo-video' | 'video'

export interface WeiboVideoFormat {
  url: string
  formatId: string
  quality: string
  qualityIndex: number
  width: number | null
  height: number | null
  bitrate: number | null
  mimeType: string
  videoCodec: string
  audioCodec: string
  fileSize: number | null
  expiresAt: string | null
}

export interface ResolvedMediaItem {
  id: string
  source: WeiboMediaSource
  sourcePostId: string
  index: number
  kind: ResolvedMediaKind
  url: string
  extension: string
  width: number | null
  height: number | null
  bitrate: number | null
  mimeType: string
  quality: string
  expiresAt: string | null
  formats?: WeiboVideoFormat[]
}

interface UnresolvedVideo {
  id: string
  source: WeiboMediaSource
  sourcePostId: string
  index: number
}

export interface ParsedStatusMedia {
  items: ResolvedMediaItem[]
  unresolvedVideos: UnresolvedVideo[]
}

export interface ResolvedPostMedia {
  postId: string
  postUrl: string
  screenName: string
  createdAtRaw: string
  items: ResolvedMediaItem[]
  unresolvedVideoCount: number
}

const VIDEO_FALLBACK_KEYS = [
  'mp4_4k_mp4',
  'mp4_2160p_mp4',
  'mp4_2k_mp4',
  'mp4_1440p_mp4',
  'mp4_1080p_mp4',
  'mp4_720p_mp4',
  'hevc_mp4_720p',
  'hevc_mp4_hd',
  'h265_mp4_hd',
  'inch_5_5_mp4_hd',
  'inch_5_mp4_hd',
  'inch_4_mp4_hd',
  'mp4_hd_mp4',
  'mp4_hd_url',
  'stream_url_hd',
  'mp4_sd_url',
  'mp4_ld_mp4',
  'stream_url',
] as const

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function absoluteUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  return value.startsWith('//') ? `https:${value}` : value
}

function extensionFromUrl(url: string, fallback: string): string {
  try {
    const match = new URL(url).pathname.match(/\.([a-zA-Z0-9]{2,5})$/)
    return match ? `.${match[1].toLowerCase()}` : fallback
  } catch {
    return fallback
  }
}

function expiresAtFromUrl(url: string): string | null {
  try {
    const seconds = Number(new URL(url).searchParams.get('Expires'))
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
  } catch {
    return null
  }
}

function originalImageUrl(url: string): string {
  if (!url) return ''
  if (/\/(?:large)\//.test(url)) return url
  return url.replace(
    /\/(?:thumb\d+|thumbnail|wap\d+|square|bmiddle|mw\d+|orj\d+|webp\d+|woriginal)\//,
    '/large/',
  )
}

function bestImage(picInfo: RawObject): { url: string; width: number | null; height: number | null } | null {
  const candidates = [
    picInfo?.largest,
    picInfo?.original,
    picInfo?.large,
    picInfo?.bmiddle,
    picInfo?.thumbnail,
    picInfo?.pic_big,
    picInfo?.pic_middle,
    picInfo?.pic_small,
    typeof picInfo?.url === 'string' ? { url: picInfo.url } : undefined,
  ]
  for (const candidate of candidates) {
    const url = originalImageUrl(absoluteUrl(typeof candidate === 'string' ? candidate : candidate?.url))
    if (url) {
      return {
        url,
        width: numberOrNull(typeof candidate === 'object' ? candidate?.width : null),
        height: numberOrNull(typeof candidate === 'object' ? candidate?.height : null),
      }
    }
  }
  return null
}

function resolutionFromLabel(label: string): { width: number | null; height: number | null } {
  const normalized = label.toLowerCase()
  if (/2160|4k/.test(normalized)) return { width: 3840, height: 2160 }
  if (/1440|2k/.test(normalized)) return { width: 2560, height: 1440 }
  if (/1080/.test(normalized)) return { width: 1920, height: 1080 }
  if (/720/.test(normalized)) return { width: 1280, height: 720 }
  if (/480|\bhd\b/.test(normalized)) return { width: 854, height: 480 }
  if (/360|\bsd\b/.test(normalized)) return { width: 640, height: 360 }
  return { width: null, height: null }
}

function fallbackFormat(key: string, value: unknown): WeiboVideoFormat | null {
  const url = absoluteUrl(value)
  if (!url) return null
  const resolution = resolutionFromLabel(key)
  return {
    url,
    formatId: key,
    quality: key,
    qualityIndex: resolution.height ?? 0,
    ...resolution,
    bitrate: null,
    mimeType: 'video/mp4',
    videoCodec: '',
    audioCodec: '',
    fileSize: null,
    expiresAt: expiresAtFromUrl(url),
  }
}

export function parseVideoFormats(mediaInfo: RawObject | undefined): WeiboVideoFormat[] {
  if (!mediaInfo || typeof mediaInfo !== 'object') return []
  const formats = (Array.isArray(mediaInfo.playback_list) ? mediaInfo.playback_list : [])
    .map((entry: RawObject): WeiboVideoFormat | null => {
      const playInfo = entry?.play_info ?? {}
      const meta = entry?.meta ?? {}
      const url = absoluteUrl(playInfo.url)
      const mimeType = String(playInfo.mime ?? playInfo.mime_type ?? '')
      const formatId = String(playInfo.label ?? meta.quality_label ?? '')
      if (!url || mimeType.startsWith('image/') || /scrubber/i.test(formatId)) return null
      return {
        url,
        formatId,
        quality: String(playInfo.quality_desc ?? meta.quality_desc ?? meta.quality_label ?? formatId),
        qualityIndex: numberOrNull(meta.quality_index) ?? 0,
        width: numberOrNull(playInfo.width),
        height: numberOrNull(playInfo.height),
        bitrate: numberOrNull(playInfo.bitrate),
        mimeType: mimeType || 'video/mp4',
        videoCodec: String(playInfo.video_codecs ?? ''),
        audioCodec: String(playInfo.audio_codecs ?? ''),
        fileSize: numberOrNull(playInfo.size),
        expiresAt: expiresAtFromUrl(url),
      }
    })
    .filter((format: WeiboVideoFormat | null): format is WeiboVideoFormat => Boolean(format))

  if (!formats.length) {
    for (const key of VIDEO_FALLBACK_KEYS) {
      const format = fallbackFormat(key, mediaInfo[key])
      if (format) formats.push(format)
    }
  }
  if (!formats.length && mediaInfo.urls && typeof mediaInfo.urls === 'object') {
    for (const [label, url] of Object.entries(mediaInfo.urls)) {
      const format = fallbackFormat(label, url)
      if (format) formats.push(format)
    }
  }

  return formats.sort((left, right) => {
    const leftPixels = (left.width ?? 0) * (left.height ?? 0)
    const rightPixels = (right.width ?? 0) * (right.height ?? 0)
    return right.qualityIndex - left.qualityIndex ||
      rightPixels - leftPixels ||
      (right.bitrate ?? 0) - (left.bitrate ?? 0)
  })
}

function imageItems(
  picId: string,
  picInfo: RawObject,
  source: WeiboMediaSource,
  sourcePostId: string,
  index: number,
): ResolvedMediaItem[] {
  const image = bestImage(picInfo)
  if (!image) return []
  const mediaType = String(picInfo.type ?? 'pic').toLowerCase()
  const isLivePhoto = mediaType === 'livephoto'
  const isGif = mediaType === 'gif' || extensionFromUrl(image.url, '') === '.gif'
  const kind: ResolvedMediaKind = isLivePhoto ? 'live-photo-image' : isGif ? 'gif' : 'image'
  const items: ResolvedMediaItem[] = [{
    id: picId,
    source,
    sourcePostId,
    index,
    kind,
    url: image.url,
    extension: isGif ? '.gif' : extensionFromUrl(image.url, '.jpg'),
    width: image.width,
    height: image.height,
    bitrate: null,
    mimeType: isGif ? 'image/gif' : '',
    quality: 'largest',
    expiresAt: expiresAtFromUrl(image.url),
  }]

  if (isLivePhoto) {
    const fid = String(picInfo.fid ?? '')
    const videoUrl = absoluteUrl(picInfo.video ?? picInfo.videoSrc) || (fid
      ? `https://video.weibo.com/media/play?livephoto=//us.sinaimg.cn/${encodeURIComponent(fid)}.mov&KID=unistore,videomovSrc`
      : '')
    if (videoUrl) {
      items.push({
        id: picId,
        source,
        sourcePostId,
        index,
        kind: 'live-photo-video',
        url: videoUrl,
        extension: extensionFromUrl(videoUrl, '.mov'),
        width: null,
        height: null,
        bitrate: null,
        mimeType: 'video/quicktime',
        quality: 'live-photo',
        expiresAt: expiresAtFromUrl(videoUrl),
      })
    }
  }
  return items
}

function videoItem(
  id: string,
  mediaInfo: RawObject | undefined,
  directUrl: unknown,
  source: WeiboMediaSource,
  sourcePostId: string,
  index: number,
): { item?: ResolvedMediaItem; unresolved?: UnresolvedVideo } {
  const formats = parseVideoFormats(mediaInfo)
  if (!formats.length) {
    const fallback = fallbackFormat('direct', directUrl)
    if (fallback) formats.push(fallback)
  }
  const best = formats[0]
  if (!best) return { unresolved: { id, source, sourcePostId, index } }
  return {
    item: {
      id,
      source,
      sourcePostId,
      index,
      kind: 'video',
      url: best.url,
      extension: extensionFromUrl(best.url, '.mp4'),
      width: best.width,
      height: best.height,
      bitrate: best.bitrate,
      mimeType: best.mimeType,
      quality: best.quality,
      expiresAt: best.expiresAt,
      formats,
    },
  }
}

function parseOneStatus(raw: RawObject, source: WeiboMediaSource): ParsedStatusMedia {
  const items: ResolvedMediaItem[] = []
  const unresolvedVideos: UnresolvedVideo[] = []
  const sourcePostId = String(raw.id ?? raw.idstr ?? raw.mid ?? '')
  const mixed = Array.isArray(raw.mix_media_info?.items) ? raw.mix_media_info.items : []

  if (mixed.length) {
    mixed.forEach((entry: RawObject, offset: number) => {
      const data = entry?.data ?? {}
      const index = offset + 1
      const entryType = String(entry?.type ?? '').toLowerCase()
      const dataType = String(data.object_type ?? data.type ?? '').toLowerCase()
      if (entryType === 'video' || entryType === '11' || dataType === 'video' || dataType === '11') {
        const result = videoItem(
          String(data.object_id ?? entry.id ?? data.id ?? `video-${index}`),
          data.media_info ?? entry.media_info,
          data.videoSrc ?? data.video ?? data.stream_url_hd ?? data.stream_url,
          source,
          sourcePostId,
          index,
        )
        if (result.item) items.push(result.item)
        if (result.unresolved) unresolvedVideos.push(result.unresolved)
      } else {
        const picInfo = data.pic_info
          ? { ...data.pic_info, type: data.pic_info.type ?? data.type }
          : data
        const id = String(entry.id ?? data.pid ?? data.id ?? `pic-${index}`)
        items.push(...imageItems(id, picInfo, source, sourcePostId, index))
      }
    })
    return { items, unresolvedVideos }
  }

  const picIds = Array.isArray(raw.pic_ids) ? raw.pic_ids.map(String) : []
  const picInfos = raw.pic_infos ?? {}
  if (picIds.length) {
    picIds.forEach((id: string, offset: number) => {
      if (picInfos[id]) items.push(...imageItems(id, picInfos[id], source, sourcePostId, offset + 1))
    })
  } else if (Array.isArray(raw.pics)) {
    raw.pics.forEach((pic: RawObject, offset: number) => {
      const index = offset + 1
      if (['video', '11'].includes(String(pic?.type ?? '').toLowerCase())) {
        const result = videoItem(
          String(pic.pid ?? pic.id ?? `video-${index}`),
          pic.media_info,
          pic.videoSrc ?? pic.video,
          source,
          sourcePostId,
          index,
        )
        if (result.item) items.push(result.item)
        if (result.unresolved) unresolvedVideos.push(result.unresolved)
      } else {
        items.push(...imageItems(String(pic.pid ?? pic.id ?? `pic-${index}`), pic, source, sourcePostId, index))
      }
    })
  }

  const pageInfo = raw.page_info ?? {}
  const pageType = String(pageInfo.object_type ?? pageInfo.type ?? '').toLowerCase()
  if (pageType === 'video' || pageType === '11') {
    const result = videoItem(
      String(pageInfo.object_id ?? pageInfo.id ?? sourcePostId),
      pageInfo.media_info ?? pageInfo.urls,
      pageInfo.videoSrc,
      source,
      sourcePostId,
      items.length + 1,
    )
    if (result.item) {
      items.push(result.item)
      for (let index = unresolvedVideos.length - 1; index >= 0; index--) {
        if (unresolvedVideos[index].sourcePostId === sourcePostId) unresolvedVideos.splice(index, 1)
      }
    }
    if (result.unresolved) unresolvedVideos.push(result.unresolved)
  }
  if (!items.some(item => item.kind === 'video') && raw.video_info && typeof raw.video_info === 'object') {
    const result = videoItem(
      String(raw.video_info.object_id ?? raw.video_info.id ?? sourcePostId),
      raw.video_info,
      raw.video_info.videoSrc ?? raw.video_info.mp4_hd_url ?? raw.video_info.stream_url,
      source,
      sourcePostId,
      items.length + 1,
    )
    if (result.item) {
      items.push(result.item)
      for (let index = unresolvedVideos.length - 1; index >= 0; index--) {
        if (unresolvedVideos[index].sourcePostId === sourcePostId) unresolvedVideos.splice(index, 1)
      }
    }
    if (result.unresolved) unresolvedVideos.push(result.unresolved)
  }
  return { items, unresolvedVideos }
}

export function parseStatusMedia(raw: RawObject, includeRetweet = true): ParsedStatusMedia {
  const primary = parseOneStatus(raw, 'post')
  if (!includeRetweet || !raw.retweeted_status || typeof raw.retweeted_status !== 'object') return primary
  const retweeted = parseOneStatus(raw.retweeted_status, 'retweeted')
  return {
    items: [...primary.items, ...retweeted.items],
    unresolvedVideos: [...primary.unresolvedVideos, ...retweeted.unresolvedVideos],
  }
}

function componentFormats(urls: unknown): WeiboVideoFormat[] {
  if (!urls || typeof urls !== 'object') return []
  return Object.entries(urls as Record<string, unknown>)
    .map(([label, url]) => fallbackFormat(label, url))
    .filter((format: WeiboVideoFormat | null): format is WeiboVideoFormat => Boolean(format))
    .sort((left, right) => {
      const leftPixels = (left.width ?? 0) * (left.height ?? 0)
      const rightPixels = (right.width ?? 0) * (right.height ?? 0)
      return rightPixels - leftPixels || right.qualityIndex - left.qualityIndex
    })
}

async function resolveLegacyVideo(video: UnresolvedVideo, client: WeiboApiClient): Promise<ResolvedMediaItem | null> {
  if (!video.id) return null
  const body = new URLSearchParams({
    data: JSON.stringify({ Component_Play_Playinfo: { oid: video.id } }),
  }).toString()
  const response = await client.postRaw<RawObject>(
    '/tv/api/component',
    body,
    { page: `/tv/show/${video.id}` },
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      'page-referer': `/tv/show/${video.id}`,
    },
  )
  const formats = componentFormats(response.data?.Component_Play_Playinfo?.urls)
  const best = formats[0]
  if (!best) return null
  return {
    id: video.id,
    source: video.source,
    sourcePostId: video.sourcePostId,
    index: video.index,
    kind: 'video',
    url: best.url,
    extension: extensionFromUrl(best.url, '.mp4'),
    width: best.width,
    height: best.height,
    bitrate: best.bitrate,
    mimeType: best.mimeType,
    quality: best.quality,
    expiresAt: best.expiresAt,
    formats,
  }
}

export async function resolvePostMedia(
  postId: string,
  options: { client?: WeiboApiClient; includeRetweet?: boolean } = {},
): Promise<ResolvedPostMedia> {
  const client = options.client ?? new WeiboApiClient()
  const raw = await client.getRaw<RawObject>('/ajax/statuses/show', {
    id: postId,
    locale: 'zh-CN',
    isGetLongText: 'true',
  })
  const resolvedId = String(raw.id ?? raw.idstr ?? raw.mid ?? '')
  if (!resolvedId) throw new Error(`微博 ${postId} 详情不可用，可能已删除或当前账号无权查看`)

  const parsed = parseStatusMedia(raw, options.includeRetweet !== false)
  let unresolvedVideoCount = 0
  for (const video of parsed.unresolvedVideos) {
    try {
      const item = await resolveLegacyVideo(video, client)
      if (item) parsed.items.push(item)
      else unresolvedVideoCount++
    } catch {
      unresolvedVideoCount++
    }
  }

  const userId = String(raw.user?.id ?? raw.user?.idstr ?? '')
  const bid = String(raw.mblogid ?? raw.bid ?? '')
  return {
    postId: resolvedId,
    postUrl: userId && bid ? `https://weibo.com/${userId}/${bid}` : '',
    screenName: String(raw.user?.screen_name ?? ''),
    createdAtRaw: String(raw.created_at ?? ''),
    items: parsed.items,
    unresolvedVideoCount,
  }
}

export function stableMediaKey(item: ResolvedMediaItem): string {
  return [item.source, item.sourcePostId, item.kind, item.id, item.index].join(':')
}

export function publicMediaItem(item: ResolvedMediaItem): Omit<ResolvedMediaItem, 'url' | 'formats'> & {
  formatCount?: number
} {
  const { url: _, formats, ...safe } = item
  return { ...safe, ...(formats ? { formatCount: formats.length } : {}) }
}
