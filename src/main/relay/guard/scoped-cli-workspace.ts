import { randomUUID } from 'crypto'
import { lstat, mkdir } from 'fs/promises'
import { join } from 'path'
import type { BigIntStats } from 'fs'
import type { RelayStateContext } from '../context'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { readBinaryResource } from '../resources/source'
import type { ScopedStorageBridge } from './scoped-storage-native'

// Dedicated fixed Main-owned storage. Do not relax SubscriptionFiles contexts:
// the caller still supplies the existing Relay/Relay-Preview Main context.
// No renderer path, existing HOME, root migration, delete or process adoption.
export async function createScopedCLIWorkspace(
  context: RelayStateContext,
  storage: ScopedStorageBridge,
  current: () => void
): Promise<{
  id: string
  protectedPaths: string[]
  home: string
  work: string
  support: string
  assertCurrent(): Promise<void>
  writeSupport(name: 'proxy-ca.pem' | '.curlrc', text: string): Promise<void>
}> {
  current()
  const retained = await storage.list(current)
  if (retained.status !== 'ok' || retained.pending || retained.items.length >= 64)
    throw new Error('私有磁盘保留记录未确认或已达 64 条上限，请先管理保留原件。')
  const files = new SubscriptionFiles(context)
  const root = join(context.home, 'Library/Application Support/Relay-ScopedCLI'),
    sessions = join(root, 'Sessions')
  await files.directory(sessions, true)
  const identity = async (path: string): Promise<BigIntStats> => {
    await files.directory(path)
    const info = await lstat(path, { bigint: true })
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== BigInt(process.getuid?.() ?? -1) ||
      (info.mode & 0o7777n) !== 0o700n
    ) {
      throw new Error('受限 CLI 独立数据区身份或权限未确认。')
    }
    return info
  }
  const rootIdentity = await identity(root),
    sessionsIdentity = await identity(sessions)
  const id = randomUUID(),
    base = join(sessions, id)
  // UUID directory creation is exclusive; an existing directory is never reused.
  await mkdir(base, { mode: 0o700 })
  await files.sync(sessions)
  const support = join(base, 'support'),
    volume = join(base, 'volume'),
    home = join(volume, 'home'),
    work = join(volume, 'work')
  await files.directory(support, true)
  const tracked = new Map<string, BigIntStats>([
    [root, rootIdentity],
    [sessions, sessionsIdentity]
  ])
  for (const path of [base, support]) tracked.set(path, await identity(path))
  const record = JSON.stringify({
    version: 1,
    id,
    createdAt: Date.now(),
    storage: 'outsideRelayRoot',
    descendantsExited: false
  })
  const recordPath = join(base, 'session.json')
  // This is a non-secret retention marker, never a process-exit/cleanup permit.
  await files.write(recordPath, record)
  await files.sync(base)
  current()
  const created = await storage.create(id, current)
  if (
    created.status !== 'ok' ||
    created.pending ||
    created.items.length !== 1 ||
    created.items[0].id !== id ||
    created.items[0].phase !== 'mounted'
  )
    throw new Error('私有磁盘挂载未确认；保留现场，不启动 CLI。')
  for (const path of [volume, home, work, join(home, 'tmp')])
    tracked.set(path, await identity(path))
  const assertCurrent = async (): Promise<void> => {
    current()
    for (const [path, expected] of tracked) {
      const actual = await identity(path)
      if (
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        actual.uid !== expected.uid ||
        actual.mode !== expected.mode
      )
        throw new Error('受限 CLI 独立数据区已发生改变。')
    }
    if ((await readBinaryResource(recordPath, true, 4096)).toString('utf8') !== record)
      throw new Error('受限 CLI 保留记录未确认。')
  }
  await assertCurrent()
  const writeSupport = async (name: 'proxy-ca.pem' | '.curlrc', text: string): Promise<void> => {
    if (!['proxy-ca.pem', '.curlrc'].includes(name))
      throw new Error('只允许固定受限 CLI 代理支持文件。')
    await assertCurrent()
    await files.write(join(support, name), text)
    await files.sync(support)
    await assertCurrent()
  }
  return {
    id,
    protectedPaths: [root, sessions, base, support, volume],
    home,
    work,
    support,
    assertCurrent,
    writeSupport
  }
}
