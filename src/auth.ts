/*
 * The Weibo Passport QR authentication flow in this file is adapted from
 * jackwener/weibo-cli's Python implementation, which declares Apache-2.0.
 * This TypeScript adaptation replaces the HTTP/cookie/persistence layers and
 * adds QR activation delay, PNG output, credential verification and 0600 storage.
 * See THIRD_PARTY_NOTICES.md and LICENSES/Apache-2.0.txt.
 */

import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import fsp from 'node:fs/promises'
import path from 'node:path'
import QRCode from 'qrcode'
import { CookieJar, type SerializedCookie } from 'tough-cookie'

export const CREDENTIAL_PATH = path.resolve(process.cwd(), '.cache', 'weibo', 'credential.json')

const PASSPORT_URL = 'https://passport.weibo.com'
const SIGNIN_URL = `${PASSPORT_URL}/sso/signin`
const QR_IMAGE_URL = `${PASSPORT_URL}/sso/v2/qrcode/image`
const QR_CHECK_URL = `${PASSPORT_URL}/sso/v2/qrcode/check`
const QR_ENTRY = 'miniblog'
const QR_REDIRECT_URL = 'https://weibo.com/'
const QR_VERSION = '20250520'

const RETCODE_SUCCESS = 20_000_000
const RETCODE_WAITING = 50_114_001
const RETCODE_SCANNED = 50_114_002
const RETCODE_EXPIRED = 50_114_004

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

export interface StoredCredential {
  cookie: string
  savedAt: string
}

interface QrResponse {
  retcode?: number
  msg?: string
  data?: {
    qrid?: string
    image?: string
    url?: string
    alt?: string
  }
}

interface LoginOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  activationDelayMs?: number
  qrFile?: string
  onQr?: (terminalQr: string, scanUrl: string) => void
  onStatus?: (message: string) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getWithJar<T>(
  jar: CookieJar,
  url: string,
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<T>> {
  let currentUrl = url
  for (let redirect = 0; redirect <= 10; redirect++) {
    const cookie = await jar.getCookieString(currentUrl)
    const response = await axios.get<T>(currentUrl, {
      ...config,
      params: redirect === 0 ? config.params : undefined,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        ...config.headers,
        Cookie: cookie,
      },
    })
    for (const setCookie of response.headers['set-cookie'] ?? []) {
      await jar.setCookie(setCookie, currentUrl).catch(() => {})
    }
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      currentUrl = new URL(response.headers.location, currentUrl).toString()
      continue
    }
    if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${currentUrl}`)
    return response
  }
  throw new Error(`微博 SSO 重定向次数过多: ${url}`)
}

export function extractQrScanUrl(imageUrl: string, qrid: string): string {
  try {
    return new URL(imageUrl).searchParams.get('data') ||
      `https://passport.weibo.cn/signin/qrcode/scan?qr=${encodeURIComponent(qrid)}`
  } catch {
    return `https://passport.weibo.cn/signin/qrcode/scan?qr=${encodeURIComponent(qrid)}`
  }
}

function domainPriority(cookie: SerializedCookie): number {
  const domain = typeof cookie.domain === 'string' ? cookie.domain : ''
  if (domain.endsWith('weibo.cn')) return 3
  if (domain.endsWith('weibo.com')) return 2
  if (domain.endsWith('sina.com.cn')) return 1
  return 0
}

export function cookieHeaderFromSerialized(cookies: SerializedCookie[]): string {
  const selected = new Map<string, SerializedCookie>()
  for (const cookie of cookies) {
    if (!cookie.key || !cookie.value) continue
    const previous = selected.get(cookie.key)
    if (!previous || domainPriority(cookie) >= domainPriority(previous)) selected.set(cookie.key, cookie)
  }
  return [...selected.values()].map(cookie => `${cookie.key}=${cookie.value}`).join('; ')
}

export async function saveCredential(cookie: string): Promise<void> {
  const credential: StoredCredential = { cookie, savedAt: new Date().toISOString() }
  await fsp.mkdir(path.dirname(CREDENTIAL_PATH), { recursive: true })
  await fsp.writeFile(CREDENTIAL_PATH, JSON.stringify(credential, null, 2), { mode: 0o600 })
  await fsp.chmod(CREDENTIAL_PATH, 0o600).catch(() => {})
}

export async function loadCredential(): Promise<StoredCredential | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(CREDENTIAL_PATH, 'utf8')) as StoredCredential
    return parsed.cookie ? parsed : null
  } catch {
    return null
  }
}

export async function clearCredential(): Promise<boolean> {
  try {
    await fsp.unlink(CREDENTIAL_PATH)
    return true
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function verifyCredential(cookie: string): Promise<{ loggedIn: boolean; uid?: string }> {
  try {
    // Profile endpoints return ok=-100 without an authenticated desktop-domain
    // session. A stable public UID lets us validate the session without reading
    // or exposing the signed-in account's identity.
    const response = await axios.get('https://weibo.com/ajax/profile/info', {
      params: { uid: '1000000001' },
      timeout: 20_000,
      validateStatus: () => true,
      headers: {
        Cookie: cookie,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://weibo.com/',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
      },
    })
    return { loggedIn: response.status === 200 && response.data?.ok === 1 }
  } catch {
    return { loggedIn: false }
  }
}

export async function loginWithQr(options: LoginOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 240_000
  const pollIntervalMs = options.pollIntervalMs ?? 2_000
  const onStatus = options.onStatus ?? (() => {})
  const jar = new CookieJar()
  const referer = `${SIGNIN_URL}?entry=miniblog&source=miniblog&url=https://weibo.com/`

  await getWithJar(jar, SIGNIN_URL, {
    timeout: 30_000,
    headers: { Referer: referer },
    params: { entry: QR_ENTRY, source: QR_ENTRY, url: QR_REDIRECT_URL },
  })
  const passportCookies = await jar.getCookies(PASSPORT_URL)
  const csrf = passportCookies.find(cookie => cookie.key === 'X-CSRF-TOKEN')?.value
  if (!csrf) throw new Error('无法从微博 Passport 获取 X-CSRF-TOKEN')
  const passportHeaders = { Referer: referer, 'x-csrf-token': csrf }

  const qrResponse = await getWithJar<QrResponse>(jar, QR_IMAGE_URL, {
    timeout: 30_000,
    headers: passportHeaders,
    params: { entry: QR_ENTRY, size: '180' },
  })
  if (qrResponse.data.retcode !== RETCODE_SUCCESS) {
    throw new Error(`申请微博登录二维码失败: ${qrResponse.data.msg ?? '未知错误'}`)
  }
  const qrid = qrResponse.data.data?.qrid
  const imageUrl = qrResponse.data.data?.image
  if (!qrid || !imageUrl) throw new Error('微博二维码响应缺少 qrid 或 image')
  const scanUrl = extractQrScanUrl(imageUrl, qrid)
  const deadline = Date.now() + timeoutMs
  const terminalQr = await QRCode.toString(scanUrl, {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'L',
    margin: 1,
  })
  if (options.qrFile) {
    await fsp.mkdir(path.dirname(options.qrFile), { recursive: true })
    // Render the scan URL directly. Fetching the CDN image adds another request
    // to the short-lived QR session and has proven less reliable in practice.
    await QRCode.toFile(options.qrFile, scanUrl, { errorCorrectionLevel: 'L', margin: 2, width: 360 })
  }
  const activationDelayMs = Math.max(0, options.activationDelayMs ?? 0)
  if (activationDelayMs > 0) {
    onStatus(`二维码已生成，等待 ${Math.ceil(activationDelayMs / 1000)} 秒后展示，避免 Passport 同步延迟`)
    await sleep(activationDelayMs)
  }
  options.onQr?.(terminalQr, scanUrl)

  let lastCode: number | undefined
  while (Date.now() < deadline) {
    const checkResponse = await getWithJar<QrResponse>(jar, QR_CHECK_URL, {
      timeout: 30_000,
      headers: passportHeaders,
      params: {
        entry: QR_ENTRY,
        source: QR_ENTRY,
        url: QR_REDIRECT_URL,
        qrid,
        rid: '',
        ver: QR_VERSION,
      },
    })
    const body = checkResponse.data
    if (body.retcode !== lastCode) {
      if (body.retcode === RETCODE_WAITING) onStatus('等待扫码')
      else if (body.retcode === RETCODE_SCANNED) onStatus('已扫码，请在手机上确认')
      else if (body.msg) onStatus(body.msg)
      lastCode = body.retcode
    }

    if (body.retcode === RETCODE_SUCCESS) {
      onStatus('扫码确认成功，正在交换登录凭证')
      const crossUrl = body.data?.url
      const alt = body.data?.alt
      if (crossUrl) await getWithJar(jar, crossUrl, { timeout: 30_000 }).catch(() => {})
      if (alt) {
        await getWithJar(jar, 'https://login.sina.com.cn/sso/login.php', {
          timeout: 30_000,
          params: { entry: QR_ENTRY, alt, returntype: 'TEXT' },
        }).catch(() => {})
      }
      await getWithJar(jar, 'https://weibo.com/', { timeout: 30_000 }).catch(() => {})
      const serialized = await jar.serialize()
      const cookie = cookieHeaderFromSerialized(serialized.cookies)
      if (!/(?:^|;\s*)SUB=/.test(cookie)) {
        throw new Error('扫码已确认，但 SSO 没有返回 SUB Cookie')
      }
      return cookie
    }
    if (body.retcode === RETCODE_EXPIRED) throw new Error('微博登录二维码已过期，请重新运行 login')
    await sleep(pollIntervalMs)
  }
  throw new Error('等待微博扫码登录超时，请重新运行 login')
}
