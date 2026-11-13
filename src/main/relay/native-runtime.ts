import { constants } from 'fs'
import { link, lstat, open, realpath, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import type { RelayStateContext } from './context'
import { readBinaryResource, resourceHash } from './resources/source'
import { SubscriptionFiles } from './subscriptions/private-files'

type Identity = Awaited<ReturnType<typeof lstat>>
const pending = new Map<string, Promise<string>>()

function sameFile(a: Identity, b: Identity): boolean {
  return ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].every(
    (key) => a[key as keyof Identity] === b[key as keyof Identity]
  )
}

async function executableBytes(path: string, privateCopy: boolean): Promise<Buffer> {
  const before = await lstat(path)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    ![process.getuid?.(), ...(privateCopy ? [] : [0])].includes(before.uid) ||
    (privateCopy ? (before.mode & 0o7777) !== 0o700 : before.mode & 0o7022) ||
    !(before.mode & 0o111) ||
    (await realpath(path)) !== path
  )
    throw new Error('原生运行资源类型、归属或权限不安全。')
  const bytes = await readBinaryResource(path)
  if (!sameFile(before, await lstat(path))) throw new Error('原生运行资源读取期间发生改变。')
  return bytes
}

// This is deployment of the main-process-owned resource, not a retry after an
// authorization failure. Only proxy apply/restore use this runtime; browser and
// guard operations retain their original bundle-relative resource contracts.
export function nativeRuntimeExecutable(
  source: string,
  context: RelayStateContext
): Promise<string> {
  const key = JSON.stringify([source, context.home, context.stateRoot]),
    existing = pending.get(key)
  if (existing) return existing
  const task = deploy(source, { ...context }).finally(() => {
    if (pending.get(key) === task) pending.delete(key)
  })
  pending.set(key, task)
  return task
}

async function deploy(source: string, context: RelayStateContext): Promise<string> {
  if (basename(source) !== 'RelayNative') throw new Error('只接受固定原生资源名称。')
  const files = new SubscriptionFiles(context),
    bytes = await executableBytes(source, false),
    digest = resourceHash(bytes),
    runtimeRoot = join(context.stateRoot, 'NativeRuntime'),
    directory = join(runtimeRoot, digest),
    target = join(directory, 'RelayNative')

  async function directories(create = false): Promise<void> {
    for (const path of [context.stateRoot, runtimeRoot, directory]) {
      if (!(await files.directory(path, create))) throw new Error('原生运行目录缺失。')
      const info = await lstat(path)
      if ((info.mode & 0o7777) !== 0o700)
        throw new Error('原生运行目录必须保持私有权限；未修复或覆盖。')
    }
  }

  async function verified(): Promise<string> {
    await directories()
    if (resourceHash(await executableBytes(target, true)) !== digest)
      throw new Error('已有原生运行副本与资源摘要不符；未覆盖。')
    if (resourceHash(await executableBytes(source, false)) !== digest)
      throw new Error('原生资源在部署期间变化；未执行。')
    await directories()
    return target
  }

  await directories(true)
  try {
    await lstat(target)
    return await verified()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporary = join(directory, `.RelayNative-${randomUUID()}.pending`),
    file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o700
    ),
    identity = await file.stat()
  async function cleanup(): Promise<void> {
    const current = await lstat(temporary)
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.uid !== identity.uid
    )
      throw new Error('待发布原生资源身份变化，保留现场；未执行。')
    await unlink(temporary)
    await files.sync(directory)
  }
  try {
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await directories()
    if (resourceHash(await executableBytes(temporary, true)) !== digest)
      throw new Error('待发布原生资源变化；未执行。')
    try {
      // link publishes complete bytes exclusively; no existing destination is
      // replaced. In-process callers share pending above. Another publisher's
      // result must independently pass the same identity and byte checks.
      await link(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    await cleanup()
  }
  return verified()
}
