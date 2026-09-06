import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  downloadPostMedia,
  downloadCrawlResult,
  downloadUrlToFile,
  parseStatusMedia,
  parseVideoFormats,
  postIdFromInput,
  publicMediaItem,
} from '../dist/index.js'

function playback(label, qualityIndex, width, height, bitrate, url) {
  return {
    meta: { quality_index: qualityIndex, quality_label: label },
    play_info: {
      label,
      quality_desc: label,
      mime: 'video/mp4',
      width,
      height,
      bitrate,
      video_codecs: 'avc1',
      audio_codecs: 'mp4a',
      url,
    },
  }
}

test('media parser selects largest image and keeps transient URLs out of public metadata', () => {
  const parsed = parseStatusMedia({
    id: '100',
    pic_ids: ['pic-1'],
    pic_infos: {
      'pic-1': {
        largest: { url: 'https://img.example/large/a.jpg', width: 2028, height: 1521 },
        original: { url: 'https://img.example/original/a.jpg', width: 1440, height: 1080 },
      },
    },
  })
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].url, 'https://img.example/large/a.jpg')
  assert.deepEqual([parsed.items[0].width, parsed.items[0].height], [2028, 1521])
  const safe = publicMediaItem(parsed.items[0])
  assert.equal('url' in safe, false)
  assert.equal('formats' in safe, false)
})

test('video parser ignores scrubber images and chooses the highest available format', () => {
  const formats = parseVideoFormats({ playback_list: [
    playback('720p', 720, 1280, 720, 2_000_000, 'https://video.example/720.mp4?Expires=2000000000'),
    {
      meta: { quality_index: 9999 },
      play_info: { label: 'scrubber', mime: 'image/jpeg', url: 'https://video.example/storyboard.jpg' },
    },
    playback('1080p', 1080, 1920, 1080, 4_000_000, 'https://video.example/1080.mp4?Expires=2000000100'),
  ] })
  assert.deepEqual(formats.map(format => format.quality), ['1080p', '720p'])
  assert.equal(formats[0].audioCodec, 'mp4a')
  assert.match(formats[0].expiresAt, /^2033-/)
})

test('mixed media, Live Photo, GIF, and retweeted media remain separate', () => {
  const parsed = parseStatusMedia({
    id: 'top',
    mix_media_info: { items: [
      { type: 'pic', id: 'gif-1', data: { type: 'gif', pic_info: { pic_big: 'https://img.example/large/a.gif' } } },
      { type: 'video', data: { object_id: 'video-1', media_info: { playback_list: [
        playback('1080p', 1080, 1920, 1080, 1, 'https://video.example/a.mp4'),
      ] } } },
    ] },
    retweeted_status: {
      id: 'original',
      pic_ids: ['live-1'],
      pic_infos: {
        'live-1': {
          type: 'livephoto',
          largest: { url: 'https://img.example/large/live.jpg' },
          video: 'https://video.example/live.mov',
        },
      },
    },
  })
  assert.deepEqual(parsed.items.map(item => item.kind), [
    'gif', 'video', 'live-photo-image', 'live-photo-video',
  ])
  assert.deepEqual(parsed.items.map(item => item.source), ['post', 'post', 'retweeted', 'retweeted'])
})

test('post input accepts numeric IDs, BIDs, and desktop/mobile links', () => {
  assert.equal(postIdFromInput('123456'), '123456')
  assert.equal(postIdFromInput('AbC12x'), 'AbC12x')
  assert.equal(postIdFromInput('https://weibo.com/100001/AbC12x?refer_flag=1'), 'AbC12x')
  assert.equal(postIdFromInput('https://m.weibo.cn/detail/123456'), '123456')
  assert.throws(() => postIdFromInput('not a post id'))
})

test('atomic downloader resumes a part file and does not forward account cookies', async t => {
  const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.headers)
    const match = request.headers.range?.match(/^bytes=(\d+)-$/)
    const start = match ? Number(match[1]) : 0
    response.statusCode = start ? 206 : 200
    response.setHeader('Content-Type', 'application/octet-stream')
    if (start) response.setHeader('Content-Range', `bytes ${start}-${payload.length - 1}/${payload.length}`)
    response.end(payload.subarray(start))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  const root = await mkdtemp(path.join(tmpdir(), 'weibo-media-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const destination = path.join(root, 'file.bin')
  await writeFile(`${destination}.part`, payload.subarray(0, 10))

  const result = await downloadUrlToFile(`http://127.0.0.1:${address.port}/media`, destination)
  assert.equal(result.skipped, false)
  assert.deepEqual(await readFile(destination), payload)
  assert.equal(requests[0].range, 'bytes=10-')
  assert.equal(requests[0].cookie, undefined)
  assert.equal(requests[0].referer, 'https://weibo.com/')
})

test('post downloader writes stable files and a manifest without CDN URLs', async t => {
  const payload = Buffer.from('image-body')
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'image/jpeg')
    response.end(payload)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  const root = await mkdtemp(path.join(tmpdir(), 'weibo-post-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mediaUrl = `http://127.0.0.1:${address.port}/largest.jpg?token=secret`
  const fakeClient = {
    async getRaw() {
      return {
        id: '900',
        mblogid: 'Bid900',
        created_at: 'Fri Aug 28 23:00:07 +0800 2026',
        user: { id: '8', screen_name: '测试/账号' },
        pic_ids: ['p1'],
        pic_infos: { p1: { largest: { url: mediaUrl, width: 2000, height: 1500 } } },
      }
    },
  }
  const result = await downloadPostMedia('900', { client: fakeClient, outputDir: root })
  assert.equal(result.files.length, 1)
  assert.deepEqual(await readFile(result.files[0].path), payload)
  assert.match(result.files[0].path, /测试_账号\/2026-08-28_23-00-07_900\/post_p1\.jpg$/)
  const manifestText = await readFile(result.manifestPath, 'utf8')
  assert.doesNotMatch(manifestText, /token=secret|127\.0\.0\.1/)
  const manifest = JSON.parse(manifestText)
  assert.equal(Object.values(manifest.entries)[0].quality, 'largest')
})

test('post downloader refreshes a rejected signed URL and retries the same media', async t => {
  const payload = Buffer.from('refreshed-image')
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/expired')) {
      response.statusCode = 403
      response.end('expired')
      return
    }
    response.setHeader('Content-Type', 'image/jpeg')
    response.end(payload)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  const root = await mkdtemp(path.join(tmpdir(), 'weibo-refresh-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let resolveCalls = 0
  const fakeClient = {
    async getRaw() {
      resolveCalls++
      const endpoint = resolveCalls === 1 ? 'expired' : 'fresh'
      return {
        id: '901',
        user: { id: '8', screen_name: 'refresh' },
        pic_ids: ['same-pic'],
        pic_infos: {
          'same-pic': { largest: { url: `http://127.0.0.1:${address.port}/${endpoint}.jpg` } },
        },
      }
    },
  }

  const result = await downloadPostMedia('901', { client: fakeClient, outputDir: root })
  assert.equal(resolveCalls, 2)
  assert.equal(result.files.length, 1)
  assert.deepEqual(await readFile(result.files[0].path), payload)
})

test('batch downloader filters by Beijing year and month before resolving media', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'weibo-month-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let resolveCalls = 0
  const fakeClient = {
    async getRaw(_path, params) {
      resolveCalls++
      return {
        id: String(params.id),
        created_at: 'Fri Aug 28 23:00:07 +0800 2026',
        user: { id: '8', screen_name: 'month-test' },
        pic_ids: ['p1'],
        pic_infos: { p1: { largest: { url: 'data:image/jpeg;base64,aW1hZ2U=' } } },
      }
    },
  }
  const crawl = {
    account: { screenName: 'month-test' },
    posts: {
      august: {
        id: 'august', createdAt: '2026-08-28T15:00:07.000Z', createdAtRaw: '',
        pictureCount: 1, videoCount: 0,
        retweetedStatus: null,
      },
      september: {
        id: 'september', createdAt: '2026-09-01T15:00:07.000Z', createdAtRaw: '',
        pictureCount: 1, videoCount: 0,
        retweetedStatus: null,
      },
    },
  }
  const result = await downloadCrawlResult(crawl, {
    client: fakeClient,
    outputDir: root,
    year: 2026,
    month: 8,
  })
  assert.equal(result.selectedPosts, 1)
  assert.equal(result.completedPosts, 1)
  assert.equal(resolveCalls, 1)
})
