import fsp from 'node:fs/promises'
import path from 'node:path'

/** Beijing save time, independent of the host timezone. */
export function snapshotTimestamp(savedAt: string): string {
  const beijing = new Date(new Date(savedAt).getTime() + 8 * 60 * 60 * 1000).toISOString()
  return beijing.slice(0, 10).replaceAll('-', '') + '_' +
    beijing.slice(11, 19).replaceAll(':', '') + '_' + beijing.slice(20, 23)
}

/** Reserve both names exclusively; a repeated timestamp gets a numeric suffix. */
export async function reserveSnapshotPaths(directory: string, id: string, savedAt: string) {
  await fsp.mkdir(directory, { recursive: true })
  const base = `${id}_${snapshotTimestamp(savedAt)}`
  for (let index = 0; ; index++) {
    const stem = base + (index ? `_${index}` : '')
    const jsonPath = path.join(directory, `${stem}.json`)
    const csvPath = path.join(directory, `${stem}.csv`)
    try {
      const json = await fsp.open(jsonPath, 'wx')
      await json.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      const csv = await fsp.open(csvPath, 'wx')
      await csv.close()
      return { jsonPath, csvPath }
    } catch (error) {
      await fsp.unlink(jsonPath)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
