import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { RelayRuntimeCheckResult } from '../../../shared/relay/runtime'
import { compileProfileRuntime } from '../profiles/runtime'
import { profileHash, readProfileFile } from '../profiles/source'
import { coreEnvironment } from './isolated-runtime'
import { verifyCoreResource } from './resources'
import { stageSmartRuntimeModel } from './smart-runtime'

const exec = promisify(execFile)
export async function checkProfileRuntime(
  resourceRoot: string,
  source: string
): Promise<RelayRuntimeCheckResult> {
  const compiled = compileProfileRuntime(source)
  if (!compiled.configuration) throw new Error('配置不属于当前隔离检查范围，未启动检查进程。')
  const resource = await verifyCoreResource(resourceRoot)
  const directory = await realpath(await mkdtemp('/private/tmp/relay-profile-check-'))
  const identity = await lstat(directory),
    config = join(directory, 'config.json')
  const same = async (): Promise<void> => {
    const current = await lstat(directory)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.uid !== process.getuid?.() ||
      (current.mode & 0o7777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error()
  }
  let status: RelayRuntimeCheckResult['status'] = 'rejected'
  const result = (): RelayRuntimeCheckResult => ({
    status,
    scope: 'isolated-projection',
    fullSourceVerified: false,
    active: false,
    runtimeSHA256: profileHash(compiled.configuration ?? ''),
    version: resource.version,
    warnings: [
      status === 'passed'
        ? '固定核心已接受这份隔离投影；未验证原DNS、外部资源、节点连接或实际流量。'
        : status === 'uncertain'
          ? '检查临时目录清理未确认；没有启用配置或操作在用核心。'
          : status === 'unavailable'
            ? '固定资源或检查进程未确认；未进行完整兼容性判断。'
            : '固定核心未接受隔离投影；原始输出未回传，避免泄露节点凭据。'
    ]
  })
  try {
    await same()
    await writeFile(config, compiled.configuration, { flag: 'wx', mode: 0o600 })
    await verifyCoreResource(resourceRoot)
    await same()
    if ((await readProfileFile(config, true)) !== compiled.configuration) throw new Error()
    await stageSmartRuntimeModel(resourceRoot, directory, resource, compiled.configuration)
    try {
      await exec(resource.executable, ['-t', '-d', directory, '-f', config], {
        cwd: directory,
        timeout: 8000,
        killSignal: 'SIGKILL',
        maxBuffer: 65536,
        env: coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory })
      })
      status = 'passed'
    } catch (error) {
      const failure = error as { code?: unknown; signal?: unknown }
      status = typeof failure.code === 'number' && !failure.signal ? 'rejected' : 'unavailable'
    }
  } catch {
    status = 'unavailable'
  } finally {
    try {
      await same()
      await rm(directory, { recursive: true })
    } catch {
      status = 'uncertain'
    }
  }
  return result()
}
