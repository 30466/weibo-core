export interface WeiboUserResult {
  id: string
  screenName: string
  description: string
  followersCount: number | string
  verified: boolean
  verifiedReason: string
}

export interface WeiboAccount extends WeiboUserResult {
  statusesCount: number
  followCount: number
  mbrank: number
  profileUrl: string
}

export type WeiboMediaType = 'none' | 'pictures' | 'video' | 'audio' | 'mixed' | 'link'

export interface WeiboPost {
  id: string
  mid: string
  bid: string
  url: string
  userId: string
  screenName: string
  createdAt: string | null
  createdAtRaw: string
  text: string
  textHtml: string
  textComplete: boolean
  source: string
  regionName: string
  attitudesCount: number
  commentsCount: number
  repostsCount: number
  isPinned: boolean
  isRetweet: boolean
  listingSources: ProfileListingEndpoint[]
  mediaType: WeiboMediaType
  mediaCount: number
  pictureCount: number
  videoCount: number
  audioTitle: string | null
  retweetedStatus: WeiboPost | null
}

export interface ExportedWeiboPost extends Omit<WeiboPost, 'textComplete' | 'textHtml' | 'retweetedStatus'> {
  retweetedStatus: ExportedWeiboPost | null
}

export type SessionSource = 'configured-cookie' | 'saved-credential'
export type ProfileListingEndpoint = 'profile-search' | 'profile-feed'
export type ProfileListingSource = ProfileListingEndpoint | 'combined'

export interface CrawlSourceMeta {
  reportedTotal: number | null
  pagesFetched: number
  returnedCount: number
  filteredOutCount: number
  exhausted: boolean
  stoppedReason: 'exhausted' | 'limit' | 'max-pages' | 'pagination-stalled'
}

export interface CrawlMeta {
  sessionSource: SessionSource
  listingSource: ProfileListingSource
  sourceStats: Partial<Record<ProfileListingEndpoint, CrawlSourceMeta>>
  requestedAll: boolean
  requestedLimit: number | null
  reportedTotal: number | null
  pagesFetched: number
  exportedCount: number
  filteredOutCount: number
  exhausted: boolean
  stoppedReason: 'exhausted' | 'limit' | 'max-pages' | 'pagination-stalled'
  completeAgainstReportedTotal: boolean
}

export interface CrawlResult {
  account: WeiboAccount
  updatedAt: string
  crawl: CrawlMeta
  posts: Record<string, ExportedWeiboPost>
}
