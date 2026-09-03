#!/usr/bin/env node

import { Command } from 'commander'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  SAFE_ACCOUNT_POST_THRESHOLD,
  WeiboApiClient,
  WeiboRequestScheduler,
} from './api/client.js'
import { fetchAllPosts, getAccount, type ProfileListingEndpoint } from './api/posts.js'
import { lookupAccount, searchAccounts } from './api/search.js'
import { exportAccount } from './export.js'
import { parseAccountList } from './input.js'
import { AsyncTwoPhaseGate, mapConcurrent } from './concurrency.js'
import {
  CREDENTIAL_PATH,
  clearCredential,
  loginWithQr,
  saveCredential,
  verifyCredential,
} from './auth.js'
import { SessionManager } from './session.js'
import { formatBeijingDateTime } from './time.js'
import type { WeiboAccount } from './types.js'

interface CommonOptions {
  name?: string
  limit?: string
  maxPages?: string
  delay?: string
  detailConcurrency?: string
  fullText?: boolean
  safe?: boolean
}

interface ResolvedSyncAccount {
  uid: string
  label: string
  inputIndex: number
  account?: WeiboAccount
  estimatedStatusesCount: number | null
}

function positiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`)
  return parsed
}

function makeClient(
  delay?: string,
  safe = false,
  scheduler?: WeiboRequestScheduler,
  session?: SessionManager,
  scopeLabel = '',
): WeiboApiClient {
  return new WeiboApiClient({
    delayMs: positiveInteger(delay, '--delay'),
    safeMode: safe,
    scheduler,
    session,
    onRetry: ({
      path: requestPath,
      status,
      delayMs,
      requestDelayMs,
      switchedToSafeMode,
      nextAttempt,
      maxAttempts,
    }) => {
      const statusLabel = status === undefined ? '请求异常' : `HTTP ${status}`
      const adaptiveLabel =
        `${switchedToSafeMode ? '；已自动切换为保守模式' : ''}` +
        `${status === 414 ? `；后续请求间隔提高到 ${requestDelayMs}ms` : ''}`
      console.error(
        `\n  ⚠ ${scopeLabel ? `${scopeLabel} ` : ''}${statusLabel} [${requestPath}]：` +
        `当前账号请求暂停 ${Math.ceil(delayMs / 1000)} 秒，` +
        `然后重试当前页（${nextAttempt}/${maxAttempts}）${adaptiveLabel}`,
      )
    },
    onPause: ({ delayMs, requestCount }) => {
      console.error(
        `\n  ⏸ ${scopeLabel ? `${scopeLabel} ` : ''}旧时间线累计请求 ${requestCount} 页，` +
        `为避免端点风控主动暂停 ${Math.ceil(delayMs / 1000)} 秒`,
      )
    },
  })
}

function listingLabel(source: ProfileListingEndpoint): string {
  return source === 'profile-search' ? '高级搜索' : '旧时间线'
}

function stoppedReasonLabel(reason: string): string {
  if (reason === 'exhausted') return '自然耗尽'
  if (reason === 'limit') return '达到数量限制'
  if (reason === 'max-pages') return '达到页数限制'
  if (reason === 'pagination-stalled') return '分页停滞'
  return reason
}

function logSourceProgress(prefix: string, page: number, source: ProfileListingEndpoint): void {
  if (page === 1) console.error(`${prefix}${listingLabel(source)} 开始`)
  else if (page % 10 === 0) console.error(`${prefix}${listingLabel(source)} 进度：第 ${page} 页`)
}

function logSourceComplete(
  prefix: string,
  stats: { pagesFetched: number; returnedCount: number; exhausted: boolean; stoppedReason: string },
  source: ProfileListingEndpoint,
): void {
  console.error(
    `${prefix}${listingLabel(source)} 完成：${stats.pagesFetched} 页，收集 ${stats.returnedCount} 条，` +
    `${stoppedReasonLabel(stats.stoppedReason)}`,
  )
}

function logProfileFeedDeepDelay(prefix: string, fetched: number, delayMs: number): void {
  console.error(
    `  ${prefix}旧时间线已收集 ${fetched} 条，` +
    `后续请求间隔提高到 ${delayMs}ms`,
  )
}

function logDetailProgress(prefix: string, count: number, total: number): void {
  if (count === total) console.error(`${prefix}正文详情完成：处理 ${count} 条`)
  else if (count % 50 === 0) console.error(`${prefix}正文详情进度：已处理 ${count} 条`)
}

function formatDuration(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes}分${remainder}秒` : `${remainder}秒`
}

async function resolveUid(uidArg: string | undefined, name: string | undefined, client: WeiboApiClient): Promise<string> {
  if (name) {
    const exact = await lookupAccount(name, client)
    if (exact) return exact.id
    const candidates = await searchAccounts(name, client)
    if (candidates.length) {
      console.error(`未找到与 "${name}" 完全同名的账号，候选：`)
      for (const user of candidates.slice(0, 10)) {
        console.error(`  ${user.screenName}  UID: ${user.id}  粉丝: ${user.followersCount}`)
      }
    }
    throw new Error(`未找到名为 "${name}" 的微博账号`)
  }
  if (uidArg && /^\d{5,}$/.test(uidArg)) return uidArg
  throw new Error('请提供数字 UID，或使用 --name <账号名称>')
}

async function cmdLookup(keyword: string, options: { json?: boolean; delay?: string }): Promise<void> {
  const client = makeClient(options.delay)
  const users = await searchAccounts(keyword, client)
  const exact = users.find(user => user.screenName === keyword.replace(/^@/, '').trim())
  if (options.json) {
    console.log(JSON.stringify({ exact, candidates: users }, null, 2))
    return
  }
  if (exact) console.log(exact.id)
  else if (!users.length) console.error(`未找到 "${keyword}" 对应的微博账号`)
  else for (const user of users.slice(0, 10)) {
    console.log(`  ${user.screenName}  UID: ${user.id}  粉丝: ${user.followersCount}`)
  }
}

async function cmdLogin(options: { timeout?: string; qrFile?: string; activationDelay?: string }): Promise<void> {
  const timeoutSeconds = positiveInteger(options.timeout, '--timeout') ?? 240
  const activationDelaySeconds = positiveInteger(options.activationDelay, '--activation-delay') ?? 60
  const qrFile = options.qrFile ? path.resolve(options.qrFile) : path.resolve('.cache', 'weibo', 'login-qr.png')
  let cookie: string
  try {
    cookie = await loginWithQr({
      timeoutMs: timeoutSeconds * 1000,
      activationDelayMs: activationDelaySeconds * 1000,
      qrFile,
      onQr: terminalQr => {
        console.log('\n请使用微博 APP 扫描二维码（微博 APP → 我的 → 扫一扫）：\n')
        console.log(terminalQr)
        console.log(`二维码图片: ${qrFile}`)
        console.log(`等待扫码，${timeoutSeconds} 秒后超时...\n`)
      },
      onStatus: message => console.log(`  ${message}`),
    })
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\n` +
      '二维码持续失败时，可让 AI Agent 按项目 Skill 询问并执行浏览器备用登录。',
    )
  }
  await saveCredential(cookie)
  const state = await verifyCredential(cookie)
  if (state.loggedIn) console.log(`登录成功${state.uid ? `，UID ${state.uid}` : ''}`)
  else console.warn('已取得并保存 SUB Cookie，但在线校验端点未返回账号信息；请运行 status 或直接执行抓取验证。')
  console.log(`凭证已保存: ${CREDENTIAL_PATH}`)
}

async function cmdImportCookie(): Promise<void> {
  if (process.stdin.isTTY) throw new Error('请通过标准输入传入完整 Cookie；为避免泄露，不支持命令行参数')
  let cookie = ''
  for await (const chunk of process.stdin) cookie += String(chunk)
  cookie = cookie.trim()
  if (!/(?:^|;\s*)SUB=/.test(cookie)) throw new Error('输入内容缺少 SUB Cookie')
  const state = await verifyCredential(cookie)
  if (!state.loggedIn) throw new Error('浏览器 Cookie 在线校验失败，未保存')
  await saveCredential(cookie)
  console.log(`浏览器登录凭证已验证并保存: ${CREDENTIAL_PATH}`)
}

async function cmdStatus(): Promise<void> {
  const session = new SessionManager()
  const cookie = await session.getCookie()
  const state = await verifyCredential(cookie)
  if (!state.loggedIn) {
    console.log(`登录无效（来源: ${session.source}），请重新运行 node bin/weibo.js login`)
    process.exitCode = 1
    return
  }
  console.log(`登录有效 ✓${state.uid ? `  UID: ${state.uid}` : ''}  来源: ${session.source}`)
}

async function cmdLogout(): Promise<void> {
  const existed = await clearCredential()
  const envCredential = process.env.WEIBO_COOKIE?.trim()
  console.log(existed ? `已删除本地凭证: ${CREDENTIAL_PATH}` : '没有已保存的本地凭证')
  if (envCredential) console.warn('WEIBO_COOKIE 环境变量仍然存在；如需完全退出，请同时清除它。')
}

async function cmdList(uidArg: string | undefined, options: CommonOptions & { json?: boolean }): Promise<void> {
  const scheduler = new WeiboRequestScheduler()
  const session = new SessionManager()
  const client = makeClient(options.delay, options.safe, scheduler, session)
  const profileFeedClient = makeClient(options.delay, options.safe, scheduler, session)
  const detailClient = makeClient(options.delay, options.safe, scheduler, session)
  const uid = await resolveUid(uidArg, options.name, client)
  const limit = positiveInteger(options.limit, '--limit') ?? 30
  const account = await getAccount(uid, client)
  if (account.statusesCount > SAFE_ACCOUNT_POST_THRESHOLD) {
    profileFeedClient.enableSafeMode()
    console.error(
      `  账号资料显示 ${account.statusesCount} 条，超过 ${SAFE_ACCOUNT_POST_THRESHOLD}，` +
      '旧时间线使用保守模式',
    )
  }
  const fetched = await fetchAllPosts(uid, {
    limit,
    maxPages: positiveInteger(options.maxPages, '--max-pages'),
    fetchLongText: options.fullText !== false,
    profileFeedClient,
    detailClient,
    detailConcurrency: positiveInteger(options.detailConcurrency, '--detail-concurrency') ?? 3,
    onPage: (page, _count, _total, source) => logSourceProgress('  ', page, source),
    onProfileFeedDeepDelay: (fetched, delayMs) => logProfileFeedDeepDelay('', fetched, delayMs),
    onDetail: (count, total) => logDetailProgress('  ', count, total),
    onSourceComplete: (stats, source) => logSourceComplete('  ', stats, source),
  }, client)
  process.stderr.write('\n')
  if (options.json) {
    console.log(JSON.stringify({ account, ...fetched }, null, 2))
    return
  }
  console.log(`${account.screenName} (UID ${uid})，显示 ${fetched.posts.length} 条：\n`)
  for (const post of fetched.posts) {
    const publishedAt = formatBeijingDateTime(post.createdAt ?? post.createdAtRaw) || post.createdAtRaw || '时间未知'
    console.log(`  ${post.id}  ${publishedAt}（北京时间）`)
    console.log(`    ${post.text.replace(/\s+/g, ' ').slice(0, 100)}`)
    console.log(`    赞 ${post.attitudesCount}  评论 ${post.commentsCount}  转发 ${post.repostsCount}`)
    console.log(`    ${post.url}\n`)
  }
}

async function cmdExport(uidArg: string | undefined, options: CommonOptions & { output?: string }): Promise<void> {
  const scheduler = new WeiboRequestScheduler()
  const session = new SessionManager()
  const client = makeClient(options.delay, options.safe, scheduler, session)
  const profileFeedClient = makeClient(options.delay, options.safe, scheduler, session)
  const detailClient = makeClient(options.delay, options.safe, scheduler, session)
  const uid = await resolveUid(uidArg, options.name, client)
  const exported = await exportAccount(uid, {
    client,
    profileFeedClient,
    limit: positiveInteger(options.limit, '--limit'),
    maxPages: positiveInteger(options.maxPages, '--max-pages'),
    fetchLongText: options.fullText !== false,
    detailClient,
    detailConcurrency: positiveInteger(options.detailConcurrency, '--detail-concurrency') ?? 3,
    outputDir: options.output,
    onLargeAccount: statusesCount => {
      console.error(
        `  账号资料显示 ${statusesCount} 条，超过 ${SAFE_ACCOUNT_POST_THRESHOLD}，` +
        '旧时间线使用保守模式',
      )
    },
    onPage: (page, _count, _total, source) => logSourceProgress('  ', page, source),
    onProfileFeedDeepDelay: (fetched, delayMs) => logProfileFeedDeepDelay('', fetched, delayMs),
    onDetail: (count, total) => logDetailProgress('  ', count, total),
    onSourceComplete: (stats, source) => logSourceComplete('  ', stats, source),
  })
  process.stderr.write('\n')
  console.log(`账号: ${exported.result.account.screenName} (UID ${uid})`)
  console.log(`数据源: ${exported.result.crawl.listingSource}`)
  console.log(`帖子: ${exported.result.crawl.exportedCount} 条`)
  for (const [source, stats] of Object.entries(exported.result.crawl.sourceStats)) {
    if (!stats) continue
    console.log(
      `  ${listingLabel(source as ProfileListingEndpoint)}: 收集 ${stats.returnedCount} 条，` +
      `${stats.pagesFetched} 页，${stoppedReasonLabel(stats.stoppedReason)}`,
    )
  }
  if (exported.result.crawl.filteredOutCount) {
    console.log(`自动排除非本人/无作者占位: ${exported.result.crawl.filteredOutCount} 条`)
  }
  console.log(`JSON: ${exported.jsonPath}`)
  console.log(`CSV:  ${exported.csvPath}`)
  if (!exported.result.crawl.exhausted && exported.result.crawl.requestedAll) {
    console.warn(
      `警告: 至少一个分页源未自然耗尽（${exported.result.crawl.stoppedReason}），` +
      `本次并集可能不完整。`,
    )
  }
}

async function cmdSync(
  file: string,
  options: CommonOptions & { output?: string; concurrency?: string; feedConcurrency?: string },
): Promise<void> {
  const syncStartedAt = Date.now()
  const entries = parseAccountList(await fsp.readFile(file, 'utf8'))
  if (!entries.length) throw new Error('TXT 中没有可用账号；每行填写 UID、主页 URL 或账号名称')
  console.log(`读取到 ${entries.length} 个账号（已去重）\n`)
  const scheduler = new WeiboRequestScheduler()
  const session = new SessionManager()
  const lookupClient = makeClient(options.delay, options.safe, scheduler, session, '账号解析')
  const accountConcurrency = positiveInteger(options.concurrency, '--concurrency') ?? 3
  const feedConcurrency = positiveInteger(options.feedConcurrency, '--feed-concurrency') ?? 2
  const detailConcurrency = positiveInteger(options.detailConcurrency, '--detail-concurrency') ?? 3
  let succeeded = 0
  let failed = 0

  const resolved: { uid: string; label: string; index: number }[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const label = entry.uid ?? entry.name ?? entry.raw
    try {
      const uid = entry.uid ?? await resolveUid(undefined, entry.name, lookupClient)
      resolved.push({ uid, label, index })
      console.log(`  ✓ ${label} → UID ${uid}`)
    } catch (error) {
      console.error(`  ✗ ${label}: ${(error as Error).message}`)
      failed++
    }
  }

  const profiled: ResolvedSyncAccount[] = []
  if (resolved.length) {
    console.log('\n预检账号资料（读取 API 报告的微博数，仅用于排序估计）')
    for (const item of resolved) {
      try {
        const account = await getAccount(item.uid, lookupClient)
        profiled.push({
          uid: item.uid,
          label: item.label,
          inputIndex: item.index,
          account,
          estimatedStatusesCount: account.statusesCount,
        })
        console.log(`  ${item.label}：约 ${account.statusesCount} 条`)
      } catch (error) {
        profiled.push({
          uid: item.uid,
          label: item.label,
          inputIndex: item.index,
          estimatedStatusesCount: null,
        })
        console.error(`  ⚠ ${item.label}：预检微博数失败，将保留原输入顺序（${(error as Error).message}）`)
      }
    }
  }

  const ordered = profiled
    .sort((left, right) => {
      const leftCount = left.estimatedStatusesCount ?? -1
      const rightCount = right.estimatedStatusesCount ?? -1
      return rightCount - leftCount || left.inputIndex - right.inputIndex
    })
  const largePhaseCount = ordered.filter(item =>
    item.estimatedStatusesCount === null ||
    item.estimatedStatusesCount > SAFE_ACCOUNT_POST_THRESHOLD
  ).length
  const profileFeedPhases = new AsyncTwoPhaseGate(largePhaseCount, feedConcurrency)
  if (ordered.length) {
    console.log('\n按预估微博数从多到少安排抓取：')
    for (const [queueIndex, item] of ordered.entries()) {
      const estimate = item.estimatedStatusesCount === null ? '未知' : `约 ${item.estimatedStatusesCount}`
      console.log(`  ${queueIndex + 1}. ${item.label}（${estimate} 条）`)
    }
  }
  console.log(
    `\n开始抓取：账号并发 ${accountConcurrency}，旧时间线超量阶段并发 1、` +
    `普通阶段并发 ${feedConcurrency}，` +
    `正文详情并发 ${detailConcurrency}，` +
    `模式 ${options.safe ? '强制保守' : `自动（超过 ${SAFE_ACCOUNT_POST_THRESHOLD} 条时仅旧时间线切换保守）`}\n`,
  )

  await mapConcurrent(ordered, accountConcurrency, async ({
    uid,
    label,
    account,
    estimatedStatusesCount,
  }, queueIndex) => {
    const progressLabel = `[${queueIndex + 1}/${ordered.length}] ${label}`
    const accountStartedAt = Date.now()
    const isLargePhaseAccount = estimatedStatusesCount === null ||
      estimatedStatusesCount > SAFE_ACCOUNT_POST_THRESHOLD
    const largePhaseLease = isLargePhaseAccount
      ? profileFeedPhases.createFirstPhaseLease()
      : undefined
    try {
      console.log(`${progressLabel} 开始`)
      const accountClient = makeClient(options.delay, options.safe, scheduler, session, progressLabel)
      const profileFeedClient = makeClient(options.delay, options.safe, scheduler, session, progressLabel)
      const detailClient = makeClient(options.delay, options.safe, scheduler, session, progressLabel)
      const exported = await exportAccount(uid, {
        client: accountClient,
        account,
        profileFeedClient,
        detailClient,
        profileFeedGate: largePhaseLease?.gate ?? profileFeedPhases.secondPhase,
        limit: positiveInteger(options.limit, '--limit'),
        maxPages: positiveInteger(options.maxPages, '--max-pages'),
        fetchLongText: options.fullText !== false,
        detailConcurrency,
        outputDir: options.output,
        onLargeAccount: statusesCount => {
          console.error(
            `  ${progressLabel} 账号资料显示 ${statusesCount} 条，` +
            `超过 ${SAFE_ACCOUNT_POST_THRESHOLD}，旧时间线使用保守模式`,
          )
        },
        onPage: (page, _count, _total, source) => logSourceProgress(`  ${progressLabel} `, page, source),
        onProfileFeedDeepDelay: (fetched, delayMs) =>
          logProfileFeedDeepDelay(`${progressLabel} `, fetched, delayMs),
        onDetail: (count, total) => logDetailProgress(`  ${progressLabel} `, count, total),
        onSourceComplete: (stats, source) => logSourceComplete(`  ${progressLabel} `, stats, source),
      })
      console.log(
        `  ${progressLabel} ✓ ${exported.result.account.screenName}: ` +
        `${exported.result.crawl.exportedCount} 条，用时 ${formatDuration(accountStartedAt)}\n`,
      )
      if (exported.result.crawl.filteredOutCount) {
        console.log(`  ${progressLabel} 已自动排除非本人/无作者占位 ${exported.result.crawl.filteredOutCount} 条\n`)
      }
      if (exported.result.crawl.requestedAll && !exported.result.crawl.exhausted) {
        console.warn(
          `  ⚠ 至少一个分页源未自然耗尽（${exported.result.crawl.stoppedReason}），` +
          `本次并集可能不完整。\n`,
        )
      }
      succeeded++
    } catch (error) {
      console.error(`  ${progressLabel} ✗ ${(error as Error).message}（用时 ${formatDuration(accountStartedAt)}）\n`)
      failed++
    } finally {
      // Advanced search can fail before this account ever enters the legacy
      // timeline gate. Completing the lease here prevents ordinary accounts
      // from waiting forever at the phase barrier.
      largePhaseLease?.complete()
    }
  })
  console.log(`同步完成：成功 ${succeeded}，失败 ${failed}，总用时 ${formatDuration(syncStartedAt)}`)
  if (failed) process.exitCode = 1
}

const program = new Command()
program.name('weibo').description('微博账号帖子列表抓取与导出工具（API 优先）').version('0.1.0')

program.command('login')
  .description('使用纯 HTTP 二维码登录微博（默认方式，不启动浏览器）')
  .option('--timeout <seconds>', '扫码等待超时秒数', '240')
  .option('--activation-delay <seconds>', '生成后等待再展示，规避二维码同步延迟', '60')
  .option('--qr-file <path>', '同时保存二维码 PNG', '.cache/weibo/login-qr.png')
  .action(cmdLogin)

program.command('import-cookie')
  .description('从标准输入验证并保存浏览器 Cookie（供 AI Agent 的浏览器备用流程使用）')
  .action(cmdImportCookie)

program.command('status')
  .description('检查微博登录凭证')
  .action(cmdStatus)

program.command('logout')
  .description('删除项目保存的微博登录凭证')
  .action(cmdLogout)

program.command('lookup')
  .description('按账号名称搜索 UID')
  .argument('<keyword>', '微博账号名称或关键词')
  .option('--json', '输出 JSON')
  .option('--delay <ms>', 'API 最小请求间隔（毫秒）')
  .action(cmdLookup)

program.command('list')
  .description('预览账号帖子列表')
  .argument('[uid]', '微博数字 UID')
  .option('--name <name>', '按账号名称精确匹配')
  .option('--limit <N>', '最多显示多少条', '30')
  .option('--max-pages <N>', '最多抓取页数')
  .option('--delay <ms>', 'API 最小请求间隔（毫秒）')
  .option('--safe', '整个命令从头使用 600ms 保守节流，并每 40 页暂停 20 秒')
  .option('--detail-concurrency <N>', '长微博正文详情并发数', '3')
  .option('--no-full-text', '不额外获取长微博全文')
  .option('--json', '输出 JSON')
  .action(cmdList)

program.command('export')
  .description('导出账号帖子到 JSON + CSV（默认持续翻页至 API 耗尽）')
  .argument('[uid]', '微博数字 UID')
  .option('--name <name>', '按账号名称精确匹配')
  .option('--limit <N>', '只导出前 N 条（默认不限制）')
  .option('--max-pages <N>', '最多抓取页数（默认不限制）')
  .option('--delay <ms>', 'API 最小请求间隔（毫秒）')
  .option('--safe', '整个命令从头使用 600ms 保守节流，并每 40 页暂停 20 秒')
  .option('--detail-concurrency <N>', '长微博正文详情并发数', '3')
  .option('--no-full-text', '不额外获取长微博全文')
  .option('--output <dir>', '输出根目录', 'data')
  .action(cmdExport)

program.command('sync')
  .description('从 TXT 批量导出账号；每行支持 UID、主页 URL 或账号名称')
  .argument('<file>', '账号列表 TXT 路径')
  .option('--limit <N>', '每个账号只导出前 N 条（默认不限制）')
  .option('--max-pages <N>', '每个账号最多抓取页数（默认不限制）')
  .option('--delay <ms>', 'API 最小请求间隔（毫秒）')
  .option('--safe', '整个命令从头使用 600ms 保守节流，并每 40 页暂停 20 秒')
  .option('--concurrency <N>', '同时抓取的账号数', '3')
  .option('--feed-concurrency <N>', '超量阶段结束后，普通账号同时进入旧时间线的数量', '2')
  .option('--detail-concurrency <N>', '每个账号的长微博正文详情并发数', '3')
  .option('--no-full-text', '不额外获取长微博全文')
  .option('--output <dir>', '输出根目录', 'data')
  .action(cmdSync)

program.parseAsync(process.argv).catch(error => {
  console.error(`错误: ${(error as Error).message}`)
  process.exitCode = 1
})
