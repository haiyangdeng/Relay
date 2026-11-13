import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { resourceDescriptor } from '../../../shared/relay/resources'
import { coreEnvironment } from '../core/configuration'
import { verifyCoreResource } from '../core/resources'
import { supportedInlineRuleProvider } from '../profiles/rule-providers'
import {
  checkResourceJob,
  resourceRuleEntries,
  type ResourceValidationJob
} from './check-definition'
import { readBinaryResource, resourceHash } from './source'

const exec = promisify(execFile)
const inputLimit = 2 * 1024 * 1024,
  outputLimit = 512 * 1024
interface MRSExecutionOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  encoding: 'buffer'
  maxBuffer: number
  timeout: number
  killSignal: 'SIGTERM'
  windowsHide: true
}
export type MRSExecutor = (
  file: string,
  args: string[],
  options: MRSExecutionOptions
) => Promise<{ stdout: Buffer; stderr: Buffer }>

// v1.19.33 mrs_converter.go dumps MRS input as text. Stdout keeps output bounded
// before allocation or publication; conversion never loads a runtime config.
export async function convertRuleMRS(
  resourceRoot: string,
  job: ResourceValidationJob,
  adapters: {
    verify?: typeof verifyCoreResource
    execute?: MRSExecutor
    platform?: NodeJS.Platform
    assertCurrent?(): void
  } = {}
): Promise<{ entries: string[]; sourceRules: number }> {
  let cleanup: (() => Promise<void>) | undefined
  let bytes: Buffer | undefined, output: { stdout: Buffer; stderr: Buffer } | undefined
  let result: { entries: string[]; sourceRules: number } | undefined, failure: Error | undefined
  try {
    adapters.assertCurrent?.()
    if (
      (adapters.platform ?? process.platform) !== 'darwin' ||
      !Buffer.isBuffer(job.bytes) ||
      job.bytes.length > inputLimit
    )
      throw new Error()
    bytes = Buffer.from(job.bytes)
    const descriptor = resourceDescriptor(job.descriptor),
      checked = { descriptor, bytes, sha256: job.sha256 }
    if (
      descriptor.kind !== 'rule-mrs' ||
      !['domain', 'ipcidr'].includes(String(descriptor.behavior))
    )
      throw new Error()
    checkResourceJob(checked)
    const sourceRules = resourceRuleEntries(checked).expected
    if (typeof sourceRules !== 'number') throw new Error()
    const verify = adapters.verify ?? verifyCoreResource,
      core = await verify(resourceRoot)
    adapters.assertCurrent?.()
    if (core.version !== 'v1.19.33') throw new Error()
    const directory = await realpath(await mkdtemp('/private/tmp/relay-mrs-worker-'))
    const identity = await lstat(directory)
    const same = async (): Promise<void> => {
      const now = await lstat(directory)
      if (
        !now.isDirectory() ||
        now.isSymbolicLink() ||
        now.uid !== process.getuid?.() ||
        (now.mode & 0o7777) !== 0o700 ||
        now.dev !== identity.dev ||
        now.ino !== identity.ino ||
        (await realpath(directory)) !== directory
      )
        throw new Error()
    }
    cleanup = async () => {
      await same()
      await rm(directory, { recursive: true })
    }
    adapters.assertCurrent?.()
    await same()
    const input = join(directory, 'source.mrs')
    await writeFile(input, bytes, { mode: 0o600, flag: 'wx' })
    const verifyInput = async (): Promise<void> => {
      await same()
      if (resourceHash(await readBinaryResource(input, true, inputLimit)) !== checked.sha256)
        throw new Error()
    }
    await verifyInput()
    // Reuse the Go-compatible network-only sandbox used for offline model
    // checks. The fixed command receives only private input and bounded stdout;
    // no runtime configuration, caller path or network endpoint is supplied.
    const policy = '(version 1) (allow default) (deny network*)'
    const execute: MRSExecutor =
      adapters.execute ?? ((file, args, options) => exec(file, args, options))
    adapters.assertCurrent?.()
    output = await execute(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        policy,
        core.executable,
        'convert-ruleset',
        String(descriptor.behavior),
        'mrs',
        input,
        '/dev/stdout'
      ],
      {
        cwd: directory,
        env: coreEnvironment(),
        encoding: 'buffer',
        maxBuffer: outputLimit,
        timeout: 10000,
        killSignal: 'SIGTERM',
        windowsHide: true
      }
    )
    adapters.assertCurrent?.()
    await verifyInput()
    const after = await verify(resourceRoot)
    if (
      after.executable !== core.executable ||
      after.version !== core.version ||
      after.architecture !== core.architecture ||
      after.sha256 !== core.sha256 ||
      !Buffer.isBuffer(output.stdout) ||
      output.stdout.length > outputLimit
    )
      throw new Error()
    new TextDecoder('utf-8', { fatal: true }).decode(output.stdout)
    const converted = resourceRuleEntries(
      {
        descriptor: { ...descriptor, kind: 'rule-text' },
        bytes: output.stdout,
        sha256: resourceHash(output.stdout)
      },
      true
    )
    if (
      !converted.entries ||
      !supportedInlineRuleProvider({
        type: 'inline',
        behavior: descriptor.behavior,
        payload: converted.entries
      })
    )
      throw new Error()
    result = { entries: converted.entries, sourceRules }
  } catch {
    failure = new Error(
      'MRS转换未确认：只接受固定核心及有界、摘要有效的domain/ipcidr资源；不会回退到未隔离执行。'
    )
  } finally {
    bytes?.fill(0)
    output?.stdout.fill(0)
    output?.stderr.fill(0)
    if (cleanup)
      try {
        await cleanup()
      } catch {
        failure = new Error('MRS私有工作目录清理未确认，未继续发布。')
      }
  }
  if (failure) throw failure
  if (!result) throw new Error('MRS转换未确认。')
  return result
}
