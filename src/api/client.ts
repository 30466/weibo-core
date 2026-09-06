import axios, { type AxiosInstance } from 'axios'
import { SessionManager } from '../session.js'

interface WeiboEnvelope<T> {
  ok?: number
  msg?: string
  data?: T
}

export const SAFE_ACCOUNT_POST_THRESHOLD = 1_200
export const SAFE_REQUEST_DELAY_MS = 600
export const SAFE_PAUSE_EVERY = 40
export const SAFE_PAUSE_MS = 20_000
export const DEEP_PROFILE_FEED_POST_THRESHOLD = 1_200
export const DEEP_PROFILE_FEED_REQUEST_DELAY_MS = 1_200

export class WeiboApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function envNonNegativeInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function retryDelayMs(status: number | undefined, attempt: number): number {
  // There are three attempts in total, so only attempts 0 and 1 have a
  // following retry. A deep-page 414 or anti-crawl 418 usually needs a much
  // longer recovery window than a normal transient network error.
  if (status === 414 || status === 418) return [180_000, 300_000][attempt] ?? 300_000
  return Math.min(30_000, 1_000 * 2 ** attempt)
}

export interface WeiboRetryInfo {
  path: string
  status?: number
  delayMs: number
  requestDelayMs: number
  switchedToSafeMode: boolean
  nextAttempt: number
  maxAttempts: number
}

export interface WeiboPauseInfo {
  path: string
  delayMs: number
  requestCount: number
}

export interface WeiboApiClientOptions {
  delayMs?: number
  retries?: number
  safeMode?: boolean
  safeDelayMs?: number
  safeMymblogPauseEvery?: number
  safeMymblogPauseMs?: number
  scheduler?: WeiboRequestScheduler
  session?: SessionManager
  onRetry?: (info: WeiboRetryInfo) => void
  onPause?: (info: WeiboPauseInfo) => void
}

export class WeiboRequestScheduler {
  lastRequestAt = 0
  private queue: Promise<void> = Promise.resolve()

  async schedule(delayMs: number): Promise<void> {
    const turn = this.queue.then(async () => {
      const remaining = this.lastRequestAt + delayMs - Date.now()
      if (remaining > 0) await sleep(remaining)
      this.lastRequestAt = Date.now()
    })
    this.queue = turn.catch(() => undefined)
    await turn
  }
}

export class WeiboApiClient {
  private readonly mobileHttp: AxiosInstance
  private readonly desktopHttp: AxiosInstance
  readonly session: SessionManager
  private requestDelayMs: number
  private readonly retries: number
  private readonly onRetry?: (info: WeiboRetryInfo) => void
  private readonly onPause?: (info: WeiboPauseInfo) => void
  private readonly scheduler: WeiboRequestScheduler
  private readonly normalRequestDelayMs: number
  private safeRequestDelayMs: number
  private safeMymblogPauseEvery: number
  private safeMymblogPauseMs: number
  private profileFeedRequestDelayMs = 0
  private cooldownUntil = 0
  private safeModeActive: boolean
  private safeMymblogRequestCount = 0

  constructor(options: WeiboApiClientOptions = {}) {
    const configuredDelay = Number.parseInt(process.env.WEIBO_REQUEST_DELAY_MS ?? '', 10)
    const defaultDelay = Number.isFinite(configuredDelay) && configuredDelay > 0 ? configuredDelay : 300
    const requestedDelay = options.delayMs ?? defaultDelay
    this.scheduler = options.scheduler ?? new WeiboRequestScheduler()
    this.normalRequestDelayMs = requestedDelay
    const safeDelayMs = options.safeDelayMs ?? envNonNegativeInteger('WEIBO_SAFE_DELAY_MS', SAFE_REQUEST_DELAY_MS)
    const pauseEvery = options.safeMymblogPauseEvery ?? envNonNegativeInteger('WEIBO_SAFE_PAUSE_EVERY', SAFE_PAUSE_EVERY)
    const pauseMs = options.safeMymblogPauseMs ?? envNonNegativeInteger('WEIBO_SAFE_PAUSE_MS', SAFE_PAUSE_MS)
    this.safeRequestDelayMs = Math.max(safeDelayMs, requestedDelay)
    this.safeMymblogPauseEvery = Math.max(0, Math.floor(pauseEvery))
    this.safeMymblogPauseMs = Math.max(0, Math.floor(pauseMs))
    this.safeModeActive = options.safeMode === true
    this.requestDelayMs = this.safeModeActive ? this.safeRequestDelayMs : this.normalRequestDelayMs
    this.retries = options.retries ?? 3
    this.onRetry = options.onRetry
    this.onPause = options.onPause
    this.session = options.session ?? new SessionManager()
    this.mobileHttp = axios.create({
      baseURL: 'https://m.weibo.cn',
      timeout: 30_000,
      validateStatus: () => true,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://m.weibo.cn/',
        Origin: 'https://m.weibo.cn',
        'X-Requested-With': 'XMLHttpRequest',
        'mweibo-pwa': '1',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
          'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    })
    this.desktopHttp = axios.create({
      baseURL: 'https://weibo.com',
      timeout: 30_000,
      validateStatus: () => true,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://weibo.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
    })
  }

  private async throttle(path?: string): Promise<void> {
    // A retry cooldown belongs to this account client. Wait before joining the
    // shared start queue so a cooling large account does not block unrelated
    // fast accounts. The scheduler still serializes starts across all clients.
    const cooldownRemaining = this.cooldownUntil - Date.now()
    if (cooldownRemaining > 0) await sleep(cooldownRemaining)
    const delayMs = path === '/ajax/statuses/mymblog'
      ? Math.max(this.requestDelayMs, this.profileFeedRequestDelayMs)
      : this.requestDelayMs
    await this.scheduler.schedule(delayMs)
  }

  // Retained as a private test seam for the existing adapter-based tests.
  private get lastRequestAt(): number {
    return this.scheduler.lastRequestAt
  }

  private set lastRequestAt(value: number) {
    this.scheduler.lastRequestAt = value
  }

  private extendCooldown(delayMs: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delayMs)
  }

  private prepareRequest(path: string): void {
    if (
      path !== '/ajax/statuses/mymblog' ||
      !this.safeModeActive ||
      this.safeMymblogPauseEvery === 0 ||
      this.safeMymblogPauseMs === 0
    ) return
    this.safeMymblogRequestCount++
    if (this.safeMymblogRequestCount % this.safeMymblogPauseEvery !== 0) return

    // The desktop timeline endpoint can start returning 414 after a sustained
    // burst for some large targets. Pause proactively in safe mode before
    // reaching that endpoint/target-specific rolling threshold.
    const delayMs = this.safeMymblogPauseMs
    this.extendCooldown(delayMs)
    this.onPause?.({ path, delayMs, requestCount: this.safeMymblogRequestCount })
  }

  private adaptAfterFailure(status: number | undefined, attempt: number): boolean {
    const switchedToSafeMode = this.enableSafeMode()
    if (status === 414) {
      this.requestDelayMs = Math.max(this.requestDelayMs, attempt === 0 ? 1_500 : 3_000)
    }
    return switchedToSafeMode
  }

  enableSafeMode(): boolean {
    const switched = !this.safeModeActive
    this.safeModeActive = true
    this.requestDelayMs = Math.max(this.requestDelayMs, this.safeRequestDelayMs)
    if (switched) this.safeMymblogRequestCount = 0
    return switched
  }

  /** Create an independently adaptive client that shares login and request-start scheduling. */
  createSibling(): WeiboApiClient {
    return new WeiboApiClient({
      delayMs: this.normalRequestDelayMs,
      retries: this.retries,
      safeMode: this.safeModeActive,
      safeDelayMs: this.safeRequestDelayMs,
      safeMymblogPauseEvery: this.safeMymblogPauseEvery,
      safeMymblogPauseMs: this.safeMymblogPauseMs,
      scheduler: this.scheduler,
      session: this.session,
      onRetry: this.onRetry,
      onPause: this.onPause,
    })
  }

  ensureProfileFeedRequestDelay(minimumMs: number): boolean {
    const requested = Math.max(0, Math.floor(minimumMs))
    const previous = this.profileFeedRequestDelayMs
    this.profileFeedRequestDelayMs = Math.max(this.profileFeedRequestDelayMs, requested)
    return this.profileFeedRequestDelayMs !== previous
  }

  async get<T>(
    path: string,
    params: Record<string, string | number> = {},
    options: { allowEmpty?: boolean } = {},
  ): Promise<T> {
    let lastError: Error | null = null
    this.prepareRequest(path)

    for (let attempt = 0; attempt < this.retries; attempt++) {
      await this.throttle(path)
      const cookie = await this.session.getCookie()
      let retryStatus: number | undefined
      try {
        const http = path.startsWith('/ajax/') ? this.desktopHttp : this.mobileHttp
        const response = await http.get<WeiboEnvelope<T>>(path, {
          params,
          headers: {
            Cookie: cookie,
            'X-XSRF-TOKEN': cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/)?.[1] ?? '',
          },
        })

        const body = response.data
        if (response.status === 200 && body && body.ok === 1 && body.data !== undefined) {
          return body.data
        }

        if (response.status === 200 && body && body.ok === 0 && options.allowEmpty) {
          return { cards: [] } as T
        }

        if (response.status === 200 && body && body.ok === -100) {
          throw new WeiboApiError(
            '微博要求登录后才能继续翻页；请运行 node bin/weibo.js login 扫码登录',
            response.status,
            false,
          )
        }

        const status = response.status
        const isHtml = typeof body === 'string' && /<html|<!doctype/i.test(body)
        // Weibo's gateway occasionally returns 414 during deep profile
        // pagination even though the actual request URI is short. Retrying the
        // same page after backoff succeeds, so treat it as transient alongside
        // the platform's other anti-crawl/gateway statuses.
        const retryable = isHtml || [403, 414, 418, 429, 432].includes(status) || status >= 500
        const message = typeof body === 'object' && body?.msg ? body.msg : `HTTP ${status}`
        lastError = new WeiboApiError(`微博 API 请求失败 [${path}]: ${message}`, status, retryable)

        if (!retryable) throw lastError
        retryStatus = status
      } catch (error) {
        if (error instanceof WeiboApiError && !error.retryable) throw error
        lastError = error instanceof Error ? error : new Error(String(error))
        if (error instanceof WeiboApiError) retryStatus = error.status
      }

      if (attempt < this.retries - 1) {
        // Cool down the shared client, not only this coroutine. Otherwise
        // other account workers keep hitting the same logged-in session while
        // one failed deep-page request sleeps, so Weibo's risk window never
        // clears. The next loop iteration reuses the exact same path and params,
        // so pagination resumes at the failed page rather than page 1.
        const switchedToSafeMode = this.adaptAfterFailure(retryStatus, attempt)
        const delayMs = retryDelayMs(retryStatus, attempt)
        this.extendCooldown(delayMs)
        this.onRetry?.({
          path,
          status: retryStatus,
          delayMs,
          requestDelayMs: this.requestDelayMs,
          switchedToSafeMode,
          nextAttempt: attempt + 2,
          maxAttempts: this.retries,
        })
      }
    }

    const suffix = lastError instanceof WeiboApiError && lastError.status === 414
      ? '微博网关在深分页期间连续 3 次拒绝同一页请求；这不代表登录过期，可稍后续跑失败账号或增大 --delay。'
      : this.session.source === 'configured-cookie'
        ? '请检查 WEIBO_COOKIE 是否有效，或适当增大请求间隔。'
        : '本地登录凭证可能已过期；请先运行 node bin/weibo.js status 确认。'
    throw new Error(`${lastError?.message ?? '微博 API 请求失败'} ${suffix}`)
  }

  private async requestRaw<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number> = {},
    data?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let lastError: Error | null = null
    this.prepareRequest(path)

    for (let attempt = 0; attempt < this.retries; attempt++) {
      await this.throttle(path)
      const cookie = await this.session.getCookie()
      let retryStatus: number | undefined
      try {
        const http = path.startsWith('/ajax/') || path.startsWith('/tv/')
          ? this.desktopHttp
          : this.mobileHttp
        const response = await http.request<T>({
          method,
          url: path,
          params,
          data,
          headers: {
            Cookie: cookie,
            'X-XSRF-TOKEN': cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/)?.[1] ?? '',
            ...extraHeaders,
          },
        })
        const body = response.data as T & { ok?: number; msg?: string; error?: string }

        if (response.status === 200 && body && typeof body === 'object') {
          if (body.ok === -100) {
            throw new WeiboApiError(
              '微博要求登录后才能读取媒体详情；请运行 node bin/weibo.js login 扫码登录',
              response.status,
              false,
            )
          }
          if (body.ok === 0 || body.error) {
            throw new WeiboApiError(
              `微博 API 请求失败 [${path}]: ${body.msg ?? body.error ?? '未知错误'}`,
              response.status,
              false,
            )
          }
          return body
        }

        const status = response.status
        const isHtml = typeof body === 'string' && /<html|<!doctype/i.test(body)
        const retryable = isHtml || [403, 414, 418, 429, 432].includes(status) || status >= 500
        lastError = new WeiboApiError(`微博 API 请求失败 [${path}]: HTTP ${status}`, status, retryable)
        if (!retryable) throw lastError
        retryStatus = status
      } catch (error) {
        if (error instanceof WeiboApiError && !error.retryable) throw error
        lastError = error instanceof Error ? error : new Error(String(error))
        if (error instanceof WeiboApiError) retryStatus = error.status
      }

      if (attempt < this.retries - 1) {
        const switchedToSafeMode = this.adaptAfterFailure(retryStatus, attempt)
        const delayMs = retryDelayMs(retryStatus, attempt)
        this.extendCooldown(delayMs)
        this.onRetry?.({
          path,
          status: retryStatus,
          delayMs,
          requestDelayMs: this.requestDelayMs,
          switchedToSafeMode,
          nextAttempt: attempt + 2,
          maxAttempts: this.retries,
        })
      }
    }

    throw new Error(`${lastError?.message ?? '微博 API 请求失败'} 本地登录凭证可能已过期。`)
  }

  /** Return endpoints such as statuses/show whose successful body is not wrapped in data. */
  async getRaw<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    return this.requestRaw<T>('GET', path, params)
  }

  /** POST a form body and return the unwrapped JSON response. */
  async postRaw<T>(
    path: string,
    data: string,
    params: Record<string, string | number> = {},
    headers: Record<string, string> = {},
  ): Promise<T> {
    return this.requestRaw<T>('POST', path, params, data, headers)
  }

  async getHtml(url: string, params: Record<string, string | number> = {}): Promise<string> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < this.retries; attempt++) {
      await this.throttle()
      const cookie = await this.session.getCookie()
      try {
        const response = await axios.get<string>(url, {
          params,
          timeout: 30_000,
          validateStatus: () => true,
          headers: {
            Cookie: cookie,
            Accept: 'text/html,application/xhtml+xml',
            Referer: 'https://s.weibo.com/',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
          },
        })
        if (response.status === 200 && typeof response.data === 'string' && response.data.length > 0) return response.data
        const retryable = [403, 418, 429, 432].includes(response.status) || response.status >= 500
        lastError = new WeiboApiError(`微博网页请求失败 [${url}]: HTTP ${response.status}`, response.status, retryable)
        if (!retryable) throw lastError
      } catch (error) {
        if (error instanceof WeiboApiError && !error.retryable) throw error
        lastError = error instanceof Error ? error : new Error(String(error))
      }
      if (attempt < this.retries - 1) await sleep(1000 * 2 ** attempt)
    }
    throw new Error(`${lastError?.message ?? '微博网页请求失败'} 本地登录凭证可能已过期。`)
  }
}
