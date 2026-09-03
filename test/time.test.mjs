import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatBeijingDateTime,
  getBeijingParts,
  nextBeijingMidnightUnix,
  toUtcIso,
} from '../dist/index.js'

test('微博带时区时间规范化为同一 UTC 绝对时刻', () => {
  assert.equal(toUtcIso('Fri Aug 28 23:00:07 +0800 2026'), '2026-08-28T15:00:07.000Z')
  assert.equal(toUtcIso('2026-08-28T15:00:07Z'), '2026-08-28T15:00:07.000Z')
  assert.equal(toUtcIso('2026-08-28 23:00:07'), null)
})

test('绝对时刻固定显示为北京时间', () => {
  assert.equal(formatBeijingDateTime('2026-08-28T05:56:00Z'), '2026-08-28 13:56:00')
  assert.deepEqual(getBeijingParts(1787896560000), {
    year: 2026,
    month: 8,
    day: 28,
    hour: 13,
    minute: 56,
    second: 0,
  })
})

test('高级搜索截止点固定为北京时间次日零点', () => {
  const beforeBeijingMidnight = nextBeijingMidnightUnix('2026-08-28T15:59:59Z')
  const afterBeijingMidnight = nextBeijingMidnightUnix('2026-08-28T16:00:00Z')
  assert.equal(new Date(beforeBeijingMidnight * 1000).toISOString(), '2026-08-28T16:00:00.000Z')
  assert.equal(new Date(afterBeijingMidnight * 1000).toISOString(), '2026-08-29T16:00:00.000Z')
  assert.equal(
    new Date(nextBeijingMidnightUnix('2026-12-31T15:59:59Z') * 1000).toISOString(),
    '2026-12-31T16:00:00.000Z',
  )
})
