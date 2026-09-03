import fsp from 'node:fs/promises'
import path from 'node:path'
import { fetchAllPosts, getAccount, getBeijingParts, nextBeijingMidnightUnix } from '../dist/index.js'
import { WeiboApiClient } from '../dist/api/client.js'

const uid = process.argv[2]
const outputArg = process.argv[3]
const delayMs = Number.parseInt(process.argv[4] ?? '300', 10)

if (!uid || !/^\d+$/.test(uid)) {
  throw new Error('用法: node scripts/compare-profile-listings.mjs <UID> [输出目录] [请求间隔毫秒]')
}
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('请求间隔必须是非负整数')

const outputDir = path.resolve(outputArg ?? `test-output/profile-interface-comparison-${uid}`)
const client = new WeiboApiClient({ delayMs })

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function stablePost(post) {
  const { textHtml: _, textComplete: __, retweetedStatus, ...stable } = post
  return {
    ...stable,
    retweetedStatus: retweetedStatus ? stablePost(retweetedStatus) : null,
  }
}

function newestFirst(a, b) {
  const aTime = Date.parse(a.post.createdAt ?? a.post.createdAtRaw) || 0
  const bTime = Date.parse(b.post.createdAt ?? b.post.createdAtRaw) || 0
  return bTime - aTime || b.id.localeCompare(a.id)
}

function rowsToCsv(rows) {
  const headers = [
    'comparison_status', 'present_in_advanced', 'present_in_legacy',
    'id', 'bid', 'created_at', 'screen_name', 'text', 'is_retweet',
    'media_type', 'media_count', 'picture_count', 'video_count', 'url',
  ]
  const lines = rows.map(row => {
    const post = row.post
    return [
      row.comparisonStatus,
      row.presentInAdvanced,
      row.presentInLegacy,
      post.id,
      post.bid,
      post.createdAt ?? post.createdAtRaw,
      post.screenName,
      post.text,
      post.isRetweet,
      post.mediaType,
      post.mediaCount,
      post.pictureCount,
      post.videoCount,
      post.url,
    ].map(csvEscape).join(',')
  })
  return [headers.join(','), ...lines].join('\n') + '\n'
}

function sourceDocument(account, fetched, endpoint, request, rows) {
  return {
    account,
    generatedAt: new Date().toISOString(),
    source: fetched.listingSource,
    endpoint,
    request,
    reportedTotal: fetched.reportedTotal,
    rawUniqueCount: fetched.posts.length + fetched.filteredOutCount,
    exportedAuthorPostCount: fetched.posts.length,
    filteredOutCount: fetched.filteredOutCount,
    pagesFetched: fetched.pagesFetched,
    stoppedReason: fetched.stoppedReason,
    note: '本文件用于对比分页成员集合，未另行请求长微博正文。comparisonStatus 标记该 ID 在两个接口的出现情况。',
    posts: Object.fromEntries(rows.map(row => [row.id, {
      comparisonStatus: row.comparisonStatus,
      uniqueToThisSource: row.comparisonStatus !== 'both',
      ...row.post,
    }])),
  }
}

function yearCounts(rows) {
  return Object.fromEntries(Object.entries(rows.reduce((counts, row) => {
    const year = getBeijingParts(row.post.createdAt ?? row.post.createdAtRaw)?.year ?? 'unknown'
    counts[year] = (counts[year] ?? 0) + 1
    return counts
  }, {})).sort())
}

console.error(`正在读取账号 ${uid} 资料…`)
const account = await getAccount(uid, client)
console.error('正在抓取高级搜索全类型接口…')
const advanced = await fetchAllPosts(uid, {
  listingSource: 'profile-search',
  fetchLongText: false,
}, client)
console.error('正在抓取旧个人页时间线接口…')
const legacy = await fetchAllPosts(uid, {
  listingSource: 'profile-feed',
  fetchLongText: false,
}, client)

const advancedById = new Map(advanced.posts.map(post => [post.id, stablePost(post)]))
const legacyById = new Map(legacy.posts.map(post => [post.id, stablePost(post)]))
const allIds = new Set([...advancedById.keys(), ...legacyById.keys()])
const allRows = [...allIds].map(id => {
  const advancedPost = advancedById.get(id)
  const legacyPost = legacyById.get(id)
  const comparisonStatus = advancedPost && legacyPost
    ? 'both'
    : advancedPost ? 'advanced_only' : 'legacy_only'
  return {
    id,
    comparisonStatus,
    presentInAdvanced: Boolean(advancedPost),
    presentInLegacy: Boolean(legacyPost),
    post: advancedPost ?? legacyPost,
  }
}).sort(newestFirst)

const advancedRows = allRows.filter(row => row.presentInAdvanced)
const legacyRows = allRows.filter(row => row.presentInLegacy)
const advancedOnlyRows = allRows.filter(row => row.comparisonStatus === 'advanced_only')
const legacyOnlyRows = allRows.filter(row => row.comparisonStatus === 'legacy_only')
const bothRows = allRows.filter(row => row.comparisonStatus === 'both')

const advancedRequest = {
  uid,
  page: '<1..N>',
  hasori: 1,
  hasret: 1,
  hastext: 1,
  haspic: 1,
  hasvideo: 1,
  hasmusic: 1,
  endtime: nextBeijingMidnightUnix(),
}
const legacyRequest = { uid, page: '<1..N>', feature: 0 }

const summary = {
  account,
  generatedAt: new Date().toISOString(),
  profileReportedStatusesCount: account.statusesCount,
  advanced: {
    endpoint: '/ajax/statuses/searchProfile',
    reportedTotal: advanced.reportedTotal,
    rawUniqueCount: advanced.posts.length + advanced.filteredOutCount,
    authorPostCount: advanced.posts.length,
    filteredOutCount: advanced.filteredOutCount,
    pagesFetched: advanced.pagesFetched,
  },
  legacy: {
    endpoint: '/ajax/statuses/mymblog',
    reportedTotal: legacy.reportedTotal,
    rawUniqueCount: legacy.posts.length + legacy.filteredOutCount,
    authorPostCount: legacy.posts.length,
    filteredOutCount: legacy.filteredOutCount,
    pagesFetched: legacy.pagesFetched,
  },
  comparison: {
    union: allRows.length,
    both: bothRows.length,
    advancedOnly: advancedOnlyRows.length,
    legacyOnly: legacyOnlyRows.length,
    advancedIsSupersetOfLegacy: legacyOnlyRows.length === 0,
    legacyIsSubsetOfAdvanced: legacyOnlyRows.length === 0,
    legacyIsSupersetOfAdvanced: advancedOnlyRows.length === 0,
    advancedIsSubsetOfLegacy: advancedOnlyRows.length === 0,
    advancedOnlyYears: yearCounts(advancedOnlyRows),
    legacyOnlyYears: yearCounts(legacyOnlyRows),
  },
}

const advancedDoc = sourceDocument(
  account, advanced, '/ajax/statuses/searchProfile', advancedRequest, advancedRows,
)
const legacyDoc = sourceDocument(
  account, legacy, '/ajax/statuses/mymblog', legacyRequest, legacyRows,
)
const comparisonDoc = {
  ...summary,
  statusDefinitions: {
    both: '两个接口都返回该微博 ID',
    advanced_only: '只有高级搜索全类型接口返回',
    legacy_only: '只有旧个人页时间线接口返回',
  },
  posts: Object.fromEntries(allRows.map(row => [row.id, row])),
}

const containmentConclusion = advancedOnlyRows.length === 0 && legacyOnlyRows.length === 0
  ? '两个接口本次返回的微博 ID 集合完全相同。'
  : advancedOnlyRows.length === 0
    ? `旧接口是高级搜索的严格超集：高级搜索的 ${advanced.posts.length} 条全部在旧接口中，旧接口另外返回 ${legacyOnlyRows.length} 条。`
    : legacyOnlyRows.length === 0
      ? `高级搜索是旧接口的严格超集：旧接口的 ${legacy.posts.length} 条全部在高级搜索中，高级搜索另外返回 ${advancedOnlyRows.length} 条。`
      : `两个接口互不包含：高级搜索独有 ${advancedOnlyRows.length} 条，旧接口独有 ${legacyOnlyRows.length} 条。`

const readme = `# ${account.screenName} 个人页接口对比

生成时间：${summary.generatedAt}

## 本次实测数量

| 指标 | 数量 |
| --- | ---: |
| 账号资料 statuses_count / 页面显示 | ${account.statusesCount} |
| 高级搜索 API reportedTotal | ${advanced.reportedTotal ?? '未知'} |
| 高级搜索实际枚举本人微博 | ${advanced.posts.length} |
| 旧接口 API reportedTotal | ${legacy.reportedTotal ?? '未知'} |
| 旧接口原始唯一对象 | ${legacy.posts.length + legacy.filteredOutCount} |
| 旧接口过滤他人/空占位后 | ${legacy.posts.length} |
| 两边交集 both | ${bothRows.length} |
| 高级搜索独有 advanced_only | ${advancedOnlyRows.length} |
| 旧接口独有 legacy_only | ${legacyOnlyRows.length} |
| 两边并集 | ${allRows.length} |

## 包含关系结论

${containmentConclusion}

页面显示的 ${account.statusesCount} 与接口分页最终能枚举的数量不是同一概念。旧接口虽然报告 ${legacy.reportedTotal ?? '未知'}，但分页耗尽时只返回 ${legacy.posts.length + legacy.filteredOutCount} 个唯一对象；高级搜索报告 ${advanced.reportedTotal ?? '未知'}，但只能枚举 ${advanced.posts.length}。\`reportedTotal\` 是服务端报告值，不能当作当前登录态可分页取回数量的保证。

## 文件说明

- \`advanced-search.json/csv\`：高级搜索的 ${advanced.posts.length} 条，每条含 \`comparisonStatus\`。
- \`legacy-feed.json/csv\`：旧接口过滤后的 ${legacy.posts.length} 条，每条含 \`comparisonStatus\`。
- \`comparison-all.json/csv\`：两边并集，用 \`both / advanced_only / legacy_only\` 标记。
- \`advanced-only.json/csv\`：只列出高级搜索独有项。
- \`legacy-only.json/csv\`：只列出旧接口独有项。
- \`summary.json\`：数量、端点、年份分布和包含关系布尔值。

两次抓取都设置了 \`fetchLongText: false\`，因为本测试只对比分页是否返回同一个微博 ID，避免长正文请求干扰接口成员集合。
`

await fsp.mkdir(outputDir, { recursive: true })
await Promise.all([
  fsp.writeFile(path.join(outputDir, 'advanced-search.json'), JSON.stringify(advancedDoc, null, 2), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'advanced-search.csv'), rowsToCsv(advancedRows), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'legacy-feed.json'), JSON.stringify(legacyDoc, null, 2), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'legacy-feed.csv'), rowsToCsv(legacyRows), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'comparison-all.json'), JSON.stringify(comparisonDoc, null, 2), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'comparison-all.csv'), rowsToCsv(allRows), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'advanced-only.json'), JSON.stringify(advancedOnlyRows, null, 2), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'advanced-only.csv'), rowsToCsv(advancedOnlyRows), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'legacy-only.json'), JSON.stringify(legacyOnlyRows, null, 2), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'legacy-only.csv'), rowsToCsv(legacyOnlyRows), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8'),
  fsp.writeFile(path.join(outputDir, 'README.md'), readme, 'utf8'),
])

console.log(JSON.stringify({ outputDir, ...summary.comparison }, null, 2))
