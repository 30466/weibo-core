import dotenv from 'dotenv'
import path from 'node:path'
import type { SessionSource } from './types.js'
import { loadCredential } from './auth.js'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

function configuredCookie(): string {
  const value = process.env.WEIBO_COOKIE?.trim() ?? ''
  return value === 'your cookie' ? '' : value
}

export class SessionManager {
  private cookie = ''
  private currentSource: SessionSource | null = null

  get source(): SessionSource {
    if (!this.currentSource) throw new Error('微博会话尚未初始化')
    return this.currentSource
  }

  async getCookie(): Promise<string> {
    if (this.cookie) return this.cookie

    const envCookie = configuredCookie()
    if (envCookie) {
      this.cookie = envCookie
      this.currentSource = 'configured-cookie'
      return this.cookie
    }

    const saved = await loadCredential()
    if (saved?.cookie) {
      this.cookie = saved.cookie
      this.currentSource = 'saved-credential'
      return this.cookie
    }

    throw new Error('未登录微博。请先运行: node bin/weibo.js login')
  }
}
