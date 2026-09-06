import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AsyncSemaphore,
  AsyncTwoPhaseGate,
  extractSearchUsers,
  extractSearchPageUsers,
  extractQrScanUrl,
  cookieHeaderFromSerialized,
  exportAccount,
  fetchAllPosts,
  htmlToText,
  normalizePost,
  needsLongText,
  mapConcurrent,
  parseAccountList,
  postsToCsv,
} from '../dist/index.js'
import {
  retryDelayMs,
  SAFE_PAUSE_EVERY,
  SAFE_PAUSE_MS,
  WeiboApiClient,
  WeiboRequestScheduler,
} from '../dist/api/client.js'

test('htmlToText preserves line breaks and decodes entities', () => {
  assert.equal(htmlToText('<a href="/n/x">@x</a> hello&amp;bye<br>第二行'), '@x hello&bye\n第二行')
})

test('account TXT accepts UID, URL and name and de-duplicates', () => {
  assert.deepEqual(parseAccountList(`
# comment
1000000001 # 示例账号甲
1000000001 duplicate
https://weibo.com/u/1000000002
@示例账号乙
`), [
    { raw: '1000000001 # 示例账号甲', uid: '1000000001' },
    { raw: 'https://weibo.com/u/1000000002', uid: '1000000002' },
    { raw: '@示例账号乙', name: '示例账号乙' },
  ])
})

test('search cards yield unique user candidates', () => {
  const users = extractSearchUsers([{ card_group: [
    { user: { id: 1, screen_name: '甲', followers_count: 3 } },
    { user: { id: 1, screen_name: '甲' } },
    { user: { id: 2, screen_name: '乙', verified: true } },
  ] }])
  assert.deepEqual(users.map(user => [user.id, user.screenName]), [['1', '甲'], ['2', '乙']])
})

test('desktop user search HTML yields low-follower account candidates', () => {
  const users = extractSearchPageUsers(`
    <a href="//weibo.com/u/1000000001" class="name">测试账号甲</a>
    <p><span class="s-nobr">粉丝：50</span></p>
  `)
  assert.deepEqual(users.map(user => [user.id, user.screenName]), [['1000000001', '测试账号甲']])
})

test('post normalization keeps text, media metadata and repost', () => {
  const post = normalizePost({
    id: '10', bid: 'Abc', created_at: 'Fri Aug 28 23:00:07 +0800 2026',
    text: '正文<br>&amp;', isLongText: true, attitudes_count: 2,
    user: { id: 9, screen_name: '账号' },
    pic_num: 12,
    page_info: {
      type: '11', object_type: 'video',
      media_info: {
        h5_url: 'https://video.weibo.com/show?fid=1', duration: 3,
        playback_list: [{
          meta: { quality_index: 720, quality_label: '720p' },
          play_info: { label: 'mp4_720p', mime: 'video/mp4', url: 'https://video.example/720.mp4' },
        }],
      },
    },
    retweeted_status: { id: '8', bid: 'Old', text: '转发源', user: { id: 7, screen_name: '源' } },
  })
  assert.equal(post.text, '正文\n&')
  assert.equal(post.textComplete, false)
  assert.equal(post.mediaType, 'video')
  assert.equal(post.mediaCount, 1)
  assert.equal(post.videoCount, 1)
  assert.equal(post.retweetedStatus.id, '8')
})

test('mixed-media posts keep counts but no expiring CDN links', () => {
  const post = normalizePost({
    id: '11', text: 'mixed', user: { id: 9 }, pic_num: 3,
    mix_media_info: { items: [{ type: 'pic' }, { type: 'video' }, { type: 'pic' }] },
  })
  assert.equal(post.mediaType, 'mixed')
  assert.equal(post.mediaCount, 3)
  assert.equal(post.pictureCount, 2)
  assert.equal(post.videoCount, 1)
  assert.equal('pageInfo' in post, false)
  assert.equal('pictures' in post, false)
  assert.equal('video' in post, false)
})

test('podcast audio keeps its semantic type and stable title without media URLs', () => {
  const post = normalizePost({
    id: '13', bid: 'Audio', text: '微博音频', user: { id: 9 },
    page_info: {
      object_type: 'podcast_audio',
      page_title: '账号的微博音频',
      page_url: 'https://video.example/show?temporary=1',
      media_info: { stream_url: 'https://audio.example/signed.mp4' },
      card_info: { title: 'Onelife' },
    },
  })
  assert.equal(post.mediaType, 'audio')
  assert.equal(post.mediaCount, 1)
  assert.equal(post.audioTitle, 'Onelife')
  assert.equal('pageInfo' in post, false)
  assert.equal(JSON.stringify(post).includes('audio.example'), false)
})

test('missing podcast title is fetched once from post detail after pagination', async () => {
  const calls = []
  const fakeClient = {
    async get(path) {
      calls.push(path)
      return {
        total: 1,
        list: [{
          id: '13', bid: 'Audio', text: '微博音频', user: { id: 9 },
          page_info: { object_type: 'podcast_audio', page_title: '账号的微博音频' },
        }],
      }
    },
    async getRaw(path, params) {
      calls.push(`${path}:${params.id}`)
      return {
        id: '13',
        page_info: {
          object_type: 'podcast_audio',
          media_info: { stream_url: 'https://audio.example/signed.mp4' },
          card_info: { title: 'Onelife' },
        },
      }
    },
  }
  const result = await fetchAllPosts('9', {
    listingSource: 'profile-search', limit: 1, fetchLongText: false,
  }, fakeClient)
  assert.equal(result.posts[0].audioTitle, 'Onelife')
  assert.equal(result.audioTitleFailures, 0)
  assert.deepEqual(calls, ['/ajax/statuses/searchProfile', '/ajax/statuses/show:13'])
  assert.equal(JSON.stringify(result.posts[0]).includes('audio.example'), false)
})

test('deleted retweet originals do not produce empty fake post links', () => {
  const post = normalizePost({
    id: '12', bid: 'Top', text: 'repost', user: { id: 9 },
    retweeted_status: { id: '10', bid: 'Gone', text: '此微博已被作者删除' },
  })
  assert.equal(post.isRetweet, true)
  assert.equal(post.retweetedStatus, null)
  assert.equal(post.url, 'https://weibo.com/9/Top')
})

test('CSV quotes multiline post text', () => {
  const post = normalizePost({ id: '1', bid: 'A', text: 'a<br>b,c', user: { id: 2, screen_name: 'u' } })
  const csv = postsToCsv({ 1: post })
  assert.match(csv, /"a\nb,c"/)
})

test('CSV flattens nested retweet fields without replacing the top-level post fields', () => {
  const post = normalizePost({
    id: '1', mid: '1', bid: 'Top', text: '', user: { id: 2, screen_name: '转发者' },
    retweeted_status: {
      id: '8', bid: 'Original', text: '原帖正文',
      created_at: 'Fri Aug 28 23:00:07 +0800 2026',
      user: { id: 7, screen_name: '原作者' }, pic_num: 3,
    },
  })
  const csv = postsToCsv({ 1: post })
  const [header, row] = csv.trimEnd().split('\n')
  assert.ok(header.includes('mid'))
  assert.ok(header.includes('user_id'))
  assert.ok(header.includes('retweeted_screen_name'))
  assert.ok(header.includes('retweeted_text'))
  assert.ok(header.includes('retweeted_media_count'))
  assert.ok(row.includes('true'))
  assert.ok(row.includes('原作者'))
  assert.ok(row.includes('原帖正文'))
  assert.ok(row.includes('https://weibo.com/7/Original'))
})

test('feed pagination follows returned next page and de-duplicates posts', async () => {
  const calls = []
  const fakeClient = {
    async get(_path, params) {
      calls.push(params)
      if (params.page === 1) return {
        total: 2,
        since_id: 'next-page-cursor',
        list: [{ id: '1', text: 'one', user: { id: 9 } }],
      }
      return {
        total: 2,
        list: [
          { id: '1', text: 'duplicate', user: { id: 9 } },
          { id: '2', text: 'two', user: { id: 9 } },
        ],
      }
    },
  }
  const result = await fetchAllPosts('9', {
    listingSource: 'profile-search', limit: 2, fetchLongText: false,
  }, fakeClient)
  assert.deepEqual(result.posts.map(post => post.id), ['1', '2'])
  assert.equal(result.pagesFetched, 2)
  assert.equal(result.listingSource, 'profile-search')
  assert.equal(result.stoppedReason, 'limit')
  assert.equal(calls[1].page, 2)
  assert.equal(calls[1].since_id, 'next-page-cursor')
})

test('empty next cursor marks the current page as the natural tail', async () => {
  const calls = []
  const fakeClient = {
    async get(_path, params) {
      calls.push(params)
      if (params.page === 1) return {
        total: 2,
        since_id: 'page-2-cursor',
        list: [{ id: '1', text: 'one', user: { id: 9 } }],
      }
      if (params.page === 2) return {
        total: 2,
        since_id: '',
        list: [{ id: '2', text: 'two', user: { id: 9 } }],
      }
      return { total: 2, list: [] }
    },
  }
  const result = await fetchAllPosts('9', {
    listingSource: 'profile-feed', fetchLongText: false,
  }, fakeClient)
  assert.equal(calls[1].since_id, 'page-2-cursor')
  assert.equal(calls.length, 2)
  assert.equal(result.stoppedReason, 'exhausted')
  assert.equal(result.exhausted, true)
  assert.deepEqual(result.posts.map(post => post.id), ['1', '2'])
})

test('profile-search listing uses every advanced-search content type', async () => {
  const calls = []
  const fakeClient = {
    async get(path, params) {
      calls.push({ path, params })
      if (params.page === 1) {
        return {
          total: '715',
          list: [{
            id: '5000000000000001', bid: 'TestPost01',
            text: '测试关键词超话', user: { id: 1000000002, screen_name: '测试账号乙' },
          }],
        }
      }
      return { total: '715', list: [] }
    },
  }

  const result = await fetchAllPosts('1000000002', {
    listingSource: 'profile-search', fetchLongText: false,
  }, fakeClient)
  assert.equal(result.listingSource, 'profile-search')
  assert.equal(result.reportedTotal, 715)
  assert.deepEqual(result.posts.map(post => post.id), ['5000000000000001'])
  assert.equal(calls[0].path, '/ajax/statuses/searchProfile')
  assert.deepEqual(
    Object.fromEntries(['hasori', 'hasret', 'hastext', 'haspic', 'hasvideo', 'hasmusic'].map(key => [key, calls[0].params[key]])),
    { hasori: 1, hasret: 1, hastext: 1, haspic: 1, hasvideo: 1, hasmusic: 1 },
  )
  assert.equal('feature' in calls[0].params, false)
  assert.ok(calls[0].params.endtime > Math.floor(Date.now() / 1000))
})

test('legacy profile feed remains available only when explicitly selected', async () => {
  const calls = []
  let gateRuns = 0
  const fakeClient = {
    async get(path, params) {
      calls.push({ path, params })
      return { total: 1, list: [{ id: '1', text: 'legacy', user: { id: 9 } }] }
    },
  }

  const result = await fetchAllPosts('9', {
    listingSource: 'profile-feed',
    limit: 1,
    fetchLongText: false,
    profileFeedGate: {
      run: async task => {
        gateRuns++
        return task()
      },
    },
  }, fakeClient)
  assert.equal(result.listingSource, 'profile-feed')
  assert.equal(calls[0].path, '/ajax/statuses/mymblog')
  assert.deepEqual(calls[0].params, { uid: '9', page: 1, feature: 0 })
  assert.equal(gateRuns, 1)
})

test('legacy timeline raises only future requests after collecting the deep-page threshold', async () => {
  const events = []
  const slowdowns = []
  let delayMs = 600
  const fakeClient = {
    ensureProfileFeedRequestDelay(minimumMs) {
      events.push(`delay:${minimumMs}`)
      delayMs = Math.max(delayMs, minimumMs)
      return true
    },
    async get(_path, params) {
      events.push(`get:${params.page}@${delayMs}`)
      if (params.page === 1) return {
        total: 3,
        since_id: 'next-page',
        list: [
          { id: '1', text: 'one', user: { id: 9 } },
          { id: '2', text: 'two', user: { id: 9 } },
        ],
      }
      return {
        total: 3,
        since_id: '',
        list: [{ id: '3', text: 'three', user: { id: 9 } }],
      }
    },
  }

  const result = await fetchAllPosts('9', {
    listingSource: 'profile-feed',
    fetchLongText: false,
    profileFeedDeepThreshold: 2,
    profileFeedDeepDelayMs: 1_200,
    onProfileFeedDeepDelay: (fetched, nextDelayMs) => slowdowns.push([fetched, nextDelayMs]),
  }, fakeClient)

  assert.deepEqual(events, ['get:1@600', 'delay:1200', 'get:2@1200'])
  assert.deepEqual(slowdowns, [[2, 1_200]])
  assert.deepEqual(result.posts.map(post => post.id), ['1', '2', '3'])
  assert.equal(result.exhausted, true)
})

test('default combined listing unions both endpoints and records per-post membership', async () => {
  const calls = []
  const fakeClient = {
    async get(path, params) {
      calls.push(`${path}:${params.page ?? params.id}`)
      if (path === '/ajax/statuses/searchProfile') {
        if (params.page === 1) return { total: 2, list: [
          { id: '3', bid: 'Shared', text: 'shared', created_at: 'Wed Jan 03 00:00:00 +0800 2024', user: { id: 9 } },
          { id: '2', bid: 'Advanced', text: 'advanced only', created_at: 'Tue Jan 02 00:00:00 +0800 2024', user: { id: 9 } },
        ] }
        return { total: 2, list: [] }
      }
      if (path === '/ajax/statuses/mymblog') {
        if (params.page === 1) return { total: 3, list: [
          { id: '3', bid: 'Shared', text: 'shared', created_at: 'Wed Jan 03 00:00:00 +0800 2024', user: { id: 9 } },
          { id: '1', bid: 'Legacy', text: 'legacy only', created_at: 'Mon Jan 01 00:00:00 +0800 2024', user: { id: 9 } },
          { id: '8', bid: 'Liked', text: 'liked card', user: { id: 8 } },
        ] }
        return { total: 3, list: [] }
      }
      throw new Error(`unexpected ${path}`)
    },
  }

  const result = await fetchAllPosts('9', { fetchLongText: false }, fakeClient)
  assert.equal(result.listingSource, 'combined')
  assert.deepEqual(result.posts.map(post => post.id), ['3', '2', '1'])
  assert.deepEqual(result.posts[0].listingSources, ['profile-search', 'profile-feed'])
  assert.deepEqual(result.posts[1].listingSources, ['profile-search'])
  assert.deepEqual(result.posts[2].listingSources, ['profile-feed'])
  assert.equal(result.sourceStats['profile-search'].returnedCount, 2)
  assert.equal(result.sourceStats['profile-feed'].returnedCount, 2)
  assert.equal(result.filteredOutCount, 1)
  assert.equal(calls.filter(call => call.startsWith('/ajax/statuses/longtext')).length, 0)
  assert.deepEqual(calls.slice(0, 4), [
    '/ajax/statuses/searchProfile:1',
    '/ajax/statuses/searchProfile:2',
    '/ajax/statuses/mymblog:1',
    '/ajax/statuses/mymblog:2',
  ])
})

test('combined listing can isolate advanced search from the legacy timeline client', async () => {
  const advancedCalls = []
  const legacyCalls = []
  const advancedClient = {
    async get(path, params) {
      advancedCalls.push(`${path}:${params.page}`)
      assert.equal(path, '/ajax/statuses/searchProfile')
      return { total: 0, list: [] }
    },
  }
  const profileFeedClient = {
    async get(path, params) {
      legacyCalls.push(`${path}:${params.page}`)
      assert.equal(path, '/ajax/statuses/mymblog')
      return { total: 0, list: [] }
    },
  }

  await fetchAllPosts('9', {
    fetchLongText: false,
    profileFeedClient,
  }, advancedClient)

  assert.deepEqual(advancedCalls, ['/ajax/statuses/searchProfile:1'])
  assert.deepEqual(legacyCalls, ['/ajax/statuses/mymblog:1'])
})

test('automatic large-account protection enables only the legacy timeline client', async t => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'weibo-core-test-'))
  t.after(() => rm(outputDir, { recursive: true, force: true }))
  const advancedCalls = []
  const legacyCalls = []
  const advancedClient = {
    session: { source: 'test' },
    safeModeEnabled: false,
    enableSafeMode() {
      this.safeModeEnabled = true
      return true
    },
    async get(path, params) {
      advancedCalls.push(`${path}:${params.page}`)
      assert.equal(path, '/ajax/statuses/searchProfile')
      return { total: 0, list: [] }
    },
  }
  const profileFeedClient = {
    safeModeEnabled: false,
    enableSafeMode() {
      this.safeModeEnabled = true
      return true
    },
    async get(path, params) {
      legacyCalls.push(`${path}:${params.page}`)
      assert.equal(path, '/ajax/statuses/mymblog')
      return { total: 0, list: [] }
    },
  }
  await exportAccount('9', {
    account: {
      id: '9',
      screenName: '示例大账号',
      description: '',
      followersCount: 0,
      verified: false,
      verifiedReason: '',
      statusesCount: 1_201,
      followCount: 0,
      mbrank: 0,
      profileUrl: 'https://weibo.com/u/9',
    },
    client: advancedClient,
    profileFeedClient,
    fetchLongText: false,
    outputDir,
  })

  assert.equal(advancedClient.safeModeEnabled, false)
  assert.equal(profileFeedClient.safeModeEnabled, true)
  assert.deepEqual(advancedCalls, ['/ajax/statuses/searchProfile:1'])
  assert.deepEqual(legacyCalls, ['/ajax/statuses/mymblog:1'])
})

test('combined listing enriches a shared long post only once after de-duplication', async () => {
  let detailCalls = 0
  const fakeClient = {
    async get(path, params) {
      if (path === '/ajax/statuses/longtext') {
        detailCalls++
        return { longTextContent: 'complete shared body' }
      }
      if (params.page === 1) return {
        total: 1,
        list: [{ id: '1', text: 'short', isLongText: true, textLength: 600, user: { id: 9 } }],
      }
      return { total: 1, list: [] }
    },
  }

  const result = await fetchAllPosts('9', {}, fakeClient)
  assert.equal(detailCalls, 1)
  assert.equal(result.posts[0].text, 'complete shared body')
  assert.deepEqual(result.posts[0].listingSources, ['profile-search', 'profile-feed'])
})

test('long-text enrichment can use a separately throttled detail client', async () => {
  const listingCalls = []
  const detailCalls = []
  const listingClient = {
    async get(path, params) {
      listingCalls.push(`${path}:${params.page}`)
      if (params.page === 1) {
        return { total: 1, list: [{ id: '1', text: 'short', isLongText: true, textLength: 600, user: { id: 9 } }] }
      }
      return { total: 1, list: [] }
    },
  }
  const detailClient = {
    async get(path, params) {
      detailCalls.push(`${path}:${params.id}`)
      return { longTextContent: 'complete from detail client' }
    },
  }

  const result = await fetchAllPosts('9', { detailClient }, listingClient)
  assert.equal(result.posts[0].text, 'complete from detail client')
  assert.deepEqual(detailCalls, ['/ajax/statuses/longtext:1'])
  assert.equal(listingCalls.some(call => call.startsWith('/ajax/statuses/longtext')), false)
})

test('profile listing excludes liked posts from other authors but keeps own reposts', async () => {
  const fakeClient = {
    async get() {
      return {
        total: 2,
        list: [
          { id: '1', bid: 'Liked', text: 'liked', title: { text: '她赞过的微博' }, user: { id: 8 } },
          { id: '2', bid: 'Own', text: 'own repost', user: { id: 9 }, retweeted_status: { id: '3', bid: 'Original', text: 'source', user: { id: 7 } } },
        ],
      }
    },
  }
  const result = await fetchAllPosts('9', {
    listingSource: 'profile-search', limit: 1, fetchLongText: false,
  }, fakeClient)
  assert.deepEqual(result.posts.map(post => post.id), ['2'])
  assert.equal(result.posts[0].isRetweet, true)
  assert.equal(result.posts[0].retweetedStatus.userId, '7')
  assert.equal(result.filteredOutCount, 1)
})

test('empty long-text payload means a short media post is already complete', async () => {
  const fakeClient = {
    async get(path) {
      if (path === '/ajax/statuses/longtext') return {}
      return { total: 1, list: [{ id: '1', text: 'short', isLongText: true, user: { id: 9 } }] }
    },
  }
  const result = await fetchAllPosts('9', { listingSource: 'profile-search', limit: 1 }, fakeClient)
  assert.equal(result.posts[0].textComplete, true)
  assert.equal(result.fullTextFailures, 0)
})

test('short media false-positive does not request long-text detail', async () => {
  const calls = []
  const fakeClient = {
    async get(path) {
      calls.push(path)
      return {
        total: 1,
        list: [{
          id: '1', text: 'short', text_raw: 'short', textLength: 8,
          isLongText: true, page_info: { object_type: 'video' }, user: { id: 9 },
        }],
      }
    },
  }
  const result = await fetchAllPosts('9', { listingSource: 'profile-search', limit: 1 }, fakeClient)
  assert.equal(result.posts[0].textComplete, true)
  assert.deepEqual(calls, ['/ajax/statuses/searchProfile'])
})

test('all pages are collected before long-text details run concurrently', async () => {
  const calls = []
  let active = 0
  let maxActive = 0
  const fakeClient = {
    async get(path, params) {
      calls.push(`${path}:${params.page ?? params.id}`)
      if (path === '/ajax/statuses/searchProfile') {
        if (params.page === 1) return { total: 2, list: [{ id: '1', text: 'a', isLongText: true, user: { id: 9 } }] }
        return { total: 2, list: [{ id: '2', text: 'b', isLongText: true, user: { id: 9 } }] }
      }
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active--
      return { longTextContent: `full-${params.id}` }
    },
  }
  const result = await fetchAllPosts('9', {
    listingSource: 'profile-search', limit: 2, detailConcurrency: 2,
  }, fakeClient)
  assert.deepEqual(calls.slice(0, 2), ['/ajax/statuses/searchProfile:1', '/ajax/statuses/searchProfile:2'])
  assert.equal(maxActive, 2)
  assert.deepEqual(result.posts.map(post => post.text), ['full-1', 'full-2'])
})

test('long-text heuristic keeps unknown and genuinely truncated posts', () => {
  assert.equal(needsLongText({ isLongText: true }), true)
  assert.equal(needsLongText({ isLongText: true, textLength: 22, text_raw: 'short media post' }), false)
  assert.equal(needsLongText({ isLongText: true, textLength: 600, text_raw: 'truncated' }), true)
})

test('mapConcurrent preserves order and bounds active work', async () => {
  let active = 0
  let maxActive = 0
  const values = await mapConcurrent([1, 2, 3, 4], 2, async value => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return value * 2
  })
  assert.deepEqual(values, [2, 4, 6, 8])
  assert.equal(maxActive, 2)
})

test('AsyncSemaphore limits an independent endpoint phase', async () => {
  const gate = new AsyncSemaphore(2)
  let active = 0
  let maxActive = 0
  await Promise.all([1, 2, 3, 4].map(value => gate.run(async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return value
  })))
  assert.equal(maxActive, 2)
})

test('AsyncTwoPhaseGate serializes phase one and releases phase two only after it finishes', async () => {
  const phases = new AsyncTwoPhaseGate(2, 2)
  const firstA = phases.createFirstPhaseLease()
  const firstB = phases.createFirstPhaseLease()
  const events = []
  let firstActive = 0
  let maxFirstActive = 0
  let secondActive = 0
  let maxSecondActive = 0

  const firstTasks = [firstA, firstB].map((lease, index) => lease.gate.run(async () => {
    events.push(`first:${index}:start`)
    firstActive++
    maxFirstActive = Math.max(maxFirstActive, firstActive)
    await new Promise(resolve => setTimeout(resolve, 10))
    firstActive--
    events.push(`first:${index}:end`)
  }))
  const secondTasks = [0, 1].map(index => phases.secondPhase.run(async () => {
    events.push(`second:${index}:start`)
    secondActive++
    maxSecondActive = Math.max(maxSecondActive, secondActive)
    await new Promise(resolve => setTimeout(resolve, 5))
    secondActive--
  }))

  await Promise.all([...firstTasks, ...secondTasks])
  assert.equal(maxFirstActive, 1)
  assert.equal(maxSecondActive, 2)
  assert.ok(events.indexOf('second:0:start') > events.indexOf('first:1:end'))
})

test('AsyncTwoPhaseGate can release phase two when a phase-one task fails before entering', async () => {
  const phases = new AsyncTwoPhaseGate(1, 2)
  const first = phases.createFirstPhaseLease()
  const secondStarted = phases.secondPhase.run(async () => true)
  first.complete()
  assert.equal(await secondStarted, true)
})

test('414 and 418 retries use a long cooldown window', () => {
  assert.deepEqual(
    [0, 1].map(attempt => retryDelayMs(414, attempt)),
    [180_000, 300_000],
  )
  assert.deepEqual(
    [0, 1].map(attempt => retryDelayMs(418, attempt)),
    [180_000, 300_000],
  )
  assert.deepEqual(
    [0, 1].map(attempt => retryDelayMs(429, attempt)),
    [1_000, 2_000],
  )
})

test('deep-page 414 retries the exact failed page twice before continuing', async () => {
  const requests = []
  const retryEvents = []
  let client
  client = new WeiboApiClient({
    delayMs: 0,
    retries: 3,
    session: { getCookie: async () => '', source: 'none' },
    onRetry: info => {
      retryEvents.push(info)
      // Keep the production cooldown values testable without waiting 60s.
      client.cooldownUntil = 0
      client.lastRequestAt = 0
    },
  })
  client.desktopHttp.defaults.adapter = async config => {
    requests.push({ path: config.url, params: { ...config.params } })
    const failed = requests.length < 3
    return {
      data: failed ? { ok: 0, msg: 'temporary gateway rejection' } : { ok: 1, data: { done: true } },
      status: failed ? 414 : 200,
      statusText: failed ? 'URI Too Long' : 'OK',
      headers: {},
      config,
    }
  }

  const params = { uid: '90001', page: 80, since_id: 'deep-page-cursor' }
  assert.deepEqual(await client.get('/ajax/statuses/mymblog', params), { done: true })
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map(request => request.params), [params, params, params])
  assert.deepEqual(
    retryEvents.map(event => [
      event.status,
      event.nextAttempt,
      event.maxAttempts,
      event.requestDelayMs,
      event.switchedToSafeMode,
    ]),
    [[414, 2, 3, 1_500, true], [414, 3, 3, 3_000, false]],
  )
})

test('legacy timeline proactive pause defaults to every 40 requests', () => {
  assert.equal(SAFE_PAUSE_EVERY, 40)
})

test('legacy timeline can pause proactively when explicitly configured', async () => {
  const pauses = []
  let client
  client = new WeiboApiClient({
    delayMs: 600,
    safeMode: true,
    session: { getCookie: async () => '', source: 'none' },
    onPause: info => {
      pauses.push(info)
      client.cooldownUntil = 0
      client.lastRequestAt = 0
    },
  })
  client.desktopHttp.defaults.adapter = async config => ({
    data: { ok: 1, data: { done: true } },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })
  for (let page = 1; page <= 40; page++) {
    client.lastRequestAt = 0
    await client.get('/ajax/statuses/mymblog', { uid: '90001', page })
  }
  assert.deepEqual(
    pauses.map(info => [info.path, info.requestCount, info.delayMs]),
    [['/ajax/statuses/mymblog', 40, SAFE_PAUSE_MS]],
  )
})

test('safe mode can be enabled dynamically for a large account', () => {
  const client = new WeiboApiClient({
    delayMs: 300,
    session: { getCookie: async () => '', source: 'none' },
  })
  assert.equal(client.enableSafeMode(), true)
  assert.equal(client.requestDelayMs, 600)
  assert.equal(client.enableSafeMode(), false)
})

test('safe mode remains scoped to one client when account clients share a scheduler', () => {
  const scheduler = new WeiboRequestScheduler()
  const session = { getCookie: async () => '', source: 'none' }
  const fastClient = new WeiboApiClient({ delayMs: 300, scheduler, session })
  const largeClient = new WeiboApiClient({ delayMs: 300, scheduler, session })

  largeClient.enableSafeMode()
  assert.equal(largeClient.requestDelayMs, 600)
  assert.equal(fastClient.requestDelayMs, 300)
})

test('deep-page delay applies only to the legacy timeline endpoint', async () => {
  const scheduledDelays = []
  const scheduler = {
    lastRequestAt: 0,
    async schedule(delayMs) {
      scheduledDelays.push(delayMs)
    },
  }
  const client = new WeiboApiClient({
    delayMs: 300,
    safeMode: true,
    scheduler,
    session: { getCookie: async () => '', source: 'none' },
  })
  client.desktopHttp.defaults.adapter = async config => ({
    data: { ok: 1, data: { done: true } },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })

  assert.equal(client.ensureProfileFeedRequestDelay(1_200), true)
  assert.equal(client.ensureProfileFeedRequestDelay(1_200), false)
  await client.get('/ajax/statuses/searchProfile', { uid: '90001', page: 1 })
  await client.get('/ajax/statuses/mymblog', { uid: '90001', page: 1 })
  assert.deepEqual(scheduledDelays, [600, 1_200])
})

test('one account retry cooldown does not block another account on the shared scheduler', async () => {
  const scheduler = new WeiboRequestScheduler()
  const session = { getCookie: async () => '', source: 'none' }
  const coolingClient = new WeiboApiClient({ delayMs: 1, scheduler, session })
  const fastClient = new WeiboApiClient({ delayMs: 1, scheduler, session })
  const completed = []
  coolingClient.cooldownUntil = Date.now() + 30
  coolingClient.desktopHttp.defaults.adapter = async config => {
    completed.push('cooling')
    return { data: { ok: 1, data: { done: true } }, status: 200, statusText: 'OK', headers: {}, config }
  }
  fastClient.desktopHttp.defaults.adapter = async config => {
    completed.push('fast')
    return { data: { ok: 1, data: { done: true } }, status: 200, statusText: 'OK', headers: {}, config }
  }

  await Promise.all([
    coolingClient.get('/ajax/profile/info', { uid: '1' }),
    fastClient.get('/ajax/profile/info', { uid: '2' }),
  ])
  assert.deepEqual(completed, ['fast', 'cooling'])
})

test('a retryable fast-mode failure switches later requests to safe mode', async () => {
  const retryEvents = []
  let requests = 0
  let client
  client = new WeiboApiClient({
    delayMs: 300,
    retries: 2,
    session: { getCookie: async () => '', source: 'none' },
    onRetry: info => {
      retryEvents.push(info)
      client.cooldownUntil = 0
      client.lastRequestAt = 0
    },
  })
  client.desktopHttp.defaults.adapter = async config => {
    requests++
    return {
      data: requests === 1 ? { ok: 0, msg: 'rate limited' } : { ok: 1, data: { done: true } },
      status: requests === 1 ? 429 : 200,
      statusText: requests === 1 ? 'Too Many Requests' : 'OK',
      headers: {},
      config,
    }
  }

  assert.deepEqual(await client.get('/ajax/statuses/mymblog', { uid: '90001', page: 1 }), { done: true })
  assert.deepEqual(
    retryEvents.map(event => [event.status, event.requestDelayMs, event.switchedToSafeMode]),
    [[429, 600, true]],
  )
})

test('QR scan URL is extracted from Passport image URL', () => {
  const scan = 'https://passport.weibo.cn/signin/qrcode/scan?qr=abc'
  assert.equal(extractQrScanUrl(`https://example.com/qr?data=${encodeURIComponent(scan)}`, 'fallback'), scan)
})

test('mobile-domain cookie wins when serializing duplicate names', () => {
  const header = cookieHeaderFromSerialized([
    { key: 'SUB', value: 'desktop', domain: '.weibo.com' },
    { key: 'SUB', value: 'mobile', domain: '.weibo.cn' },
    { key: 'SUBP', value: 'p', domain: '.weibo.com' },
  ])
  assert.match(header, /SUB=mobile/)
  assert.doesNotMatch(header, /desktop/)
})
