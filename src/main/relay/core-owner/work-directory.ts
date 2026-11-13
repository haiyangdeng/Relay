import { lstat } from 'fs/promises'
import { join } from 'path'
import type { RelayStateContext } from '../context'
import { readBinaryResource, resourceHash } from '../resources/source'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { parseTunHostFrame } from '../tun/wire-json'
import { CORE_OWNER_CONTRACT, record, type OwnerSnapshot } from './protocol'

const journalLimit = 32768

export async function openCoreOwnerWorkDirectory(
  context: RelayStateContext,
  snapshot: OwnerSnapshot,
  open: (path: string) => Promise<void>,
  assertLive: () => void
): Promise<void> {
  const directory = join(context.stateRoot, 'CoreOwner/.session'),
    invalid = (): Error => new Error('持久核心工作目录归属未确认。')
  if (snapshot.runtime.directory !== directory) throw invalid()
  // The authenticated native revision is the exact private owner.json digest.
  // workspaceIdentity names the runtime directory, not the separate Core lease.
  const bytes = await readBinaryResource(join(directory, 'owner.json'), true, journalLimit)
  if (resourceHash(bytes) !== snapshot.revision) throw invalid()
  const journal = record(parseTunHostFrame(bytes, journalLimit))
  if (
    journal.version !== 1 ||
    journal.contract !== CORE_OWNER_CONTRACT ||
    journal.sessionId !== snapshot.sessionId ||
    journal.phase !== snapshot.phase ||
    record(journal.runtime).directory !== directory ||
    !(await new SubscriptionFiles(context).directory(directory))
  )
    throw invalid()
  const info = await lstat(directory, { bigint: true }),
    uid = process.getuid?.()
  if (
    !info.isDirectory() ||
    uid === undefined ||
    info.uid !== BigInt(uid) ||
    (info.mode & 0o7777n) !== 0o700n ||
    journal.workspaceIdentity !== `${BigInt.asIntN(32, info.dev)}:${info.ino}`
  )
    throw invalid()
  assertLive()
  await open(directory)
}
