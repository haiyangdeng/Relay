import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SubStoreResources } from './resources'
import { archiveSubStoreSession, inspectSubStoreSession } from './runtime'

const roots: string[] = []
async function fixture(pid: number) {
  const root = await realpath(await mkdtemp('/private/tmp/relay-substore-recovery-'))
  roots.push(root)
  const resources = new SubStoreResources(root)
  await resources.initialize()
  await mkdir(resources.sessionDirectory, { mode: 0o700 })
  const record = { version: 1, nonce: 'a'.repeat(32), pid, createdAt: Date.now() }
  const path = join(resources.sessionDirectory, 'owner.json')
  await writeFile(path, JSON.stringify(record), { mode: 0o600 })
  return { root, resources, record, path }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('Sub-Store stale ownership evidence', () => {
  it('never archives or signals a currently existing process', async () => {
    const f = await fixture(process.pid),
      view = await inspectSubStoreSession(f.resources)
    expect(view?.canArchive).toBe(false)
    if (!view) throw new Error('missing recovery view')
    await expect(
      archiveSubStoreSession(f.resources, { ...view, canArchive: true })
    ).rejects.toThrow('仍存在')
    expect(JSON.parse(await readFile(f.path, 'utf8')).pid).toBe(process.pid)
  })
  it('moves a stopped record into a retained archive only when the confirmation revision remains current', async () => {
    const f = await fixture(2147483646),
      view = await inspectSubStoreSession(f.resources)
    expect(view?.canArchive).toBe(true)
    if (!view) throw new Error('missing recovery view')
    await writeFile(f.path, JSON.stringify({ ...f.record, createdAt: f.record.createdAt + 1 }))
    await expect(archiveSubStoreSession(f.resources, view)).rejects.toThrow('已改变')
    const latest = await inspectSubStoreSession(f.resources)
    if (!latest) throw new Error('missing recovery view')
    await archiveSubStoreSession(f.resources, latest)
    expect(await inspectSubStoreSession(f.resources)).toBeUndefined()
    const archived = join(f.root, 'SubStore/Recovery', `session-${f.record.nonce}`, 'owner.json')
    expect(JSON.parse(await readFile(archived, 'utf8')).pid).toBe(f.record.pid)
  })
  it('keeps malformed records blocked instead of treating them as absent', async () => {
    const f = await fixture(2147483646)
    await writeFile(f.path, '{corrupt')
    expect(await inspectSubStoreSession(f.resources)).toEqual({ canArchive: false })
    await expect(archiveSubStoreSession(f.resources, { canArchive: true })).rejects.toThrow(
      '无法确认'
    )
  })
})
