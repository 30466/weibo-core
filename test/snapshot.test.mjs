import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { snapshotTimestamp, reserveSnapshotPaths } from '../dist/snapshot.js'

test('save timestamps use Beijing time across date boundaries', () => {
  assert.equal(snapshotTimestamp('2026-10-22T16:01:02.003Z'), '20261023_000102_003')
})

test('repeated saves and existing CSV names preserve all earlier files', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'snapshots-'))
  try {
    const savedAt = '2026-10-22T16:01:02.003Z'
    const originalCsv = path.join(directory, '123_20261023_000102_003.csv')
    await fsp.writeFile(originalCsv, 'existing CSV')
    const first = await reserveSnapshotPaths(directory, '123', savedAt)
    await fsp.writeFile(first.jsonPath, 'old JSON')
    await fsp.writeFile(first.csvPath, 'old CSV')
    const second = await reserveSnapshotPaths(directory, '123', savedAt)
    assert.equal(path.basename(first.jsonPath), '123_20261023_000102_003_1.json')
    assert.equal(path.basename(second.jsonPath), '123_20261023_000102_003_2.json')
    assert.equal(path.parse(second.jsonPath).name, path.parse(second.csvPath).name)
    assert.equal(await fsp.readFile(originalCsv, 'utf8'), 'existing CSV')
    assert.equal(await fsp.readFile(first.jsonPath, 'utf8'), 'old JSON')
    assert.equal(await fsp.readFile(first.csvPath, 'utf8'), 'old CSV')
  } finally {
    await fsp.rm(directory, { recursive: true, force: true })
  }
})
