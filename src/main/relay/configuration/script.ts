import { execFile } from 'child_process'
import { lstat, mkdtemp, realpath, rm } from 'fs/promises'
import { isAbsolute } from 'path'
import { coreEnvironment } from '../core/configuration'
import {
  readConfigurationMap,
  CONFIGURATION_BYTE_LIMIT,
  plainConfigurationMap
} from '../profiles/document'

export class RuntimeScriptError extends Error {
  constructor(readonly status: 'cancelled' | 'failed' | 'uncertain') {
    super(
      status === 'uncertain'
        ? '脚本工作目录清理未确认，保留现场。'
        : status === 'cancelled'
          ? '已取消配置脚本。'
          : '脚本未完成、超时或结果无效；没有生成或应用运行配置。'
    )
  }
}
export async function runConfigurationScript(
  executable: string,
  script: string,
  configuration: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ configuration: Record<string, unknown>; logs: string[] }> {
  if (signal?.aborted) throw new RuntimeScriptError('cancelled')
  if (
    typeof script !== 'string' ||
    Buffer.byteLength(script) > 65536 ||
    script.includes('\0') ||
    !isAbsolute(executable)
  )
    throw new RuntimeScriptError('failed')
  let source: string
  try {
    source = JSON.stringify(configuration)
  } catch {
    throw new RuntimeScriptError('failed')
  }
  if (!readConfigurationMap(source).data) throw new RuntimeScriptError('failed')
  const directory = await realpath(await mkdtemp('/private/tmp/relay-config-script-'))
  const identity = await lstat(directory)
  const removeOwnDirectory = async (): Promise<void> => {
    const after = await lstat(directory)
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== identity.dev ||
      after.ino !== identity.ino ||
      after.uid !== process.getuid?.() ||
      (after.mode & 0o7777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error()
    await rm(directory, { recursive: true })
  }
  let result: { configuration: Record<string, unknown>; logs: string[] } | undefined
  let failure: RuntimeScriptError | undefined
  try {
    const info = await lstat(executable)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) throw new Error()
    if (signal?.aborted) throw new Error()
    const stdout = await new Promise<string>((resolve, reject) => {
      const ready = Buffer.from('relay-runtime-script-ready-v2\n')
      let prefix = Buffer.alloc(0),
        inputFailed = false,
        inputStarted = false,
        callbackDone = false,
        closed = false,
        callbackFailed = false,
        output = '',
        phaseWall = Date.now(),
        phaseMonotonic = performance.now(),
        phaseBudget = 10000,
        deadline: ReturnType<typeof setTimeout> | undefined
      const withinBudget = (now = Date.now(), monotonicNow = performance.now()): boolean => {
        const wall = now - phaseWall,
          monotonic = monotonicNow - phaseMonotonic
        return wall >= 0 && wall < phaseBudget && monotonic >= 0 && monotonic < phaseBudget
      }
      const abort = (): void => fail()
      const finish = (): void => {
        // execFile's error callback can precede close. Never remove the
        // workspace while the held child may still be using it.
        if (!callbackDone || !closed) return
        clearTimeout(deadline)
        signal?.removeEventListener('abort', abort)
        if (callbackFailed || inputFailed || !inputStarted || !withinBudget())
          reject(new Error('worker failed'))
        else resolve(output.slice(ready.length))
      }
      const child = execFile(
        executable,
        ['--runtime-script-v2'],
        {
          cwd: directory,
          env: coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory }),
          // Absolute fallback bounds both startup and execution, including IO.
          timeout: 13000,
          killSignal: 'SIGKILL',
          maxBuffer: 6 * 1024 * 1024
        },
        (error, stdout) => {
          callbackDone = true
          callbackFailed = !!error
          output = stdout
          finish()
        }
      )
      const fail = (): void => {
        if (inputFailed) return
        inputFailed = true
        child.kill('SIGKILL')
      }
      child.once('close', () => {
        closed = true
        finish()
      })
      // Loading the signed process and creating its bare JSContext precede
      // untrusted code. Only an exact ready frame permits us to send input.
      deadline = setTimeout(fail, 10000)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        if (inputFailed || inputStarted) return
        prefix = Buffer.concat([prefix, bytes])
        if (prefix.length > ready.length || !prefix.equals(ready.subarray(0, prefix.length))) {
          fail()
          return
        }
        if (prefix.length !== ready.length) return
        const now = Date.now(),
          monotonicNow = performance.now()
        if (!withinBudget(now, monotonicNow)) {
          fail()
          return
        }
        inputStarted = true
        clearTimeout(deadline)
        // Keep the original three-second budget for transfer, evaluation and
        // output. Startup cannot consume it, and user code cannot extend it.
        phaseWall = now
        phaseMonotonic = monotonicNow
        phaseBudget = 3000
        deadline = setTimeout(fail, phaseBudget)
        child.stdin?.end(JSON.stringify({ script, configuration: source }))
      })
      child.stdin?.on('error', fail)
    })
    const value: unknown = JSON.parse(stdout)
    if (
      !plainConfigurationMap(value) ||
      Object.keys(value).sort().join(',') !== 'configuration,logs' ||
      typeof value.configuration !== 'string' ||
      Buffer.byteLength(value.configuration) > CONFIGURATION_BYTE_LIMIT ||
      !Array.isArray(value.logs) ||
      value.logs.length > 64 ||
      value.logs.some((log) => typeof log !== 'string' || log.length > 1024) ||
      Buffer.byteLength(JSON.stringify(value.logs)) > 524288
    )
      throw new Error()
    const output = readConfigurationMap(value.configuration).data
    if (!output || signal?.aborted) throw new Error()
    result = { configuration: output, logs: value.logs }
  } catch {
    failure = new RuntimeScriptError(signal?.aborted ? 'cancelled' : 'failed')
  } finally {
    try {
      await removeOwnDirectory()
    } catch {
      failure = new RuntimeScriptError('uncertain')
    }
  }
  if (failure) throw failure
  if (!result) throw new RuntimeScriptError('failed')
  return result
}
