import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'fs/promises'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runConfigurationScript, RuntimeScriptError } from './script'

describe.runIf(process.platform === 'darwin')('Bounded native script worker lifecycle', () => {
  let root: string
  let identity: Awaited<ReturnType<typeof lstat>>
  const facts: Record<string, unknown>[] = []
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
  beforeAll(async () => {
    root = await realpath(await mkdtemp('/private/tmp/relay-script-ready-test-'))
    identity = await lstat(root)
  })
  afterAll(async () => {
    if (process.env.RELAY_SCRIPT_PROOF_OUTPUT)
      await writeFile(process.env.RELAY_SCRIPT_PROOF_OUTPUT, JSON.stringify(facts, null, 2) + '\n')
    const current = await lstat(root)
    expect([current.dev, current.ino, current.uid, current.mode & 0o7777]).toEqual([
      identity.dev,
      identity.ino,
      process.getuid?.(),
      0o700
    ])
    expect(await realpath(root)).toBe(root)
    await rm(root, { recursive: true })
  })

  async function worker(
    name: string,
    kind: string
  ): Promise<{ executable: string; received: string }> {
    const directory = join(root, name)
    await mkdir(directory, { mode: 0o700 })
    const program = join(directory, 'worker.cjs'),
      executable = join(directory, 'worker'),
      received = join(directory, 'received.json')
    await writeFile(
      program,
      `
const fs = require('fs');
const kind = ${JSON.stringify(kind)}, received = ${JSON.stringify(received)};
fs.writeFileSync(received + '.meta', JSON.stringify({cwd:process.cwd(),pid:process.pid,uid:process.getuid()}));
process.on('SIGTERM', ()=>{});
const version2 = process.argv[2] === '--runtime-script-v2';
const frame = 'relay-runtime-script-ready-v2\\n';
const active = setInterval(()=>{},1000);
let input = '';
process.stdin.on('data', data => {input += data;fs.writeFileSync(received, input)});
const end = new Promise(resolve => process.stdin.on('end', resolve));
async function start() {
  if (kind === 'silent') return;
  if (kind === 'exit') {process.exit(0)}
  if (kind === 'malformed') {process.stdout.write('wrong-ready\\n');return}
  if (kind === 'premature') {process.stdout.write(frame + '{}');return}
  if (kind === 'delayed') await new Promise(resolve => setTimeout(resolve, 3200));
  if (version2) {
    if (kind === 'fragmented') {
      for (const byte of frame) {process.stdout.write(byte);await new Promise(resolve => setTimeout(resolve, 2))}
    } else process.stdout.write(frame);
  }
  await end;
  if (kind === 'hang') {while(true) {}}
  if (kind === 'large') {process.stdout.write('X'.repeat(7*1024*1024));return}
  const value = JSON.parse(input);
  process.stdout.write(JSON.stringify({configuration:value.configuration,logs:[]}));
  clearInterval(active);
}
start().catch(()=>process.exitCode=1);
`
    )
    await writeFile(
      executable,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`
    )
    await chmod(executable, 0o755)
    return { executable, received }
  }
  async function closedWorkspace(received: string): Promise<void> {
    const metadata = JSON.parse(await readFile(received + '.meta', 'utf8')) as {
      cwd: string
      pid: number
      uid: number
    }
    expect(metadata.uid).toBe(process.getuid?.())
    await expect(lstat(metadata.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    // Signal 0 only inspects this known creator child; it sends no signal.
    expect(() => process.kill(metadata.pid, 0)).toThrow()
  }
  async function rejected(name: string, kind: string, signal?: AbortSignal): Promise<number> {
    const target = await worker(name, kind),
      started = performance.now()
    let caught: unknown
    try {
      await runConfigurationScript(target.executable, 'function main(c){return c}', {}, signal)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RuntimeScriptError)
    expect((caught as RuntimeScriptError).status).toBe(signal?.aborted ? 'cancelled' : 'failed')
    await closedWorkspace(target.received)
    const elapsedMs = performance.now() - started
    facts.push({
      name,
      kind,
      elapsedMs,
      status: (caught as RuntimeScriptError).status,
      inputReceived: await readFile(target.received, 'utf8').then(Boolean, () => false),
      remaining: await readdir(join(root, name))
    })
    return elapsedMs
  }

  it('separates a reproducible pre-execution startup delay from the unchanged evaluation budget', async () => {
    const next = await worker('v2-delay', 'delayed'),
      started = performance.now()
    const result = await runConfigurationScript(next.executable, 'function main(c){return c}', {
      marker: false
    })
    expect(result).toEqual({ configuration: { marker: false }, logs: [] })
    await closedWorkspace(next.received)
    facts.push({
      name: 'controlled-startup',
      newMs: performance.now() - started,
      note: 'A controlled worker demonstrates the startup and evaluation boundaries.'
    })
  }, 15000)

  it('accepts a ready frame fragmented across real stdout chunks', async () => {
    const target = await worker('fragmented', 'fragmented')
    expect(
      await runConfigurationScript(target.executable, 'function main(c){return c}', {
        marker: false
      })
    ).toEqual({ configuration: { marker: false }, logs: [] })
    await closedWorkspace(target.received)
  })
  it.each(['malformed', 'premature', 'exit'])(
    'rejects %s before sending configuration input',
    async (kind) => {
      await rejected(kind, kind)
      await expect(readFile(join(root, kind, 'received.json'))).rejects.toThrow()
    }
  )
  it('bounds a silent pre-ready process without sending configuration', async () => {
    const elapsed = await rejected('silent', 'silent')
    expect(elapsed).toBeGreaterThanOrEqual(9900)
    expect(elapsed).toBeLessThan(14000)
    await expect(readFile(join(root, 'silent', 'received.json'))).rejects.toThrow()
  }, 16000)
  it('kills and reaps an infinite worker within the original three-second post-ready budget', async () => {
    const elapsed = await rejected('hang', 'hang')
    expect(elapsed).toBeGreaterThanOrEqual(2900)
    expect(elapsed).toBeLessThan(6500)
  }, 8000)
  it.each([
    ['cancel-startup', 'silent'],
    ['cancel-execution', 'hang']
  ])(
    'cancels and reaps %s after observing its actual phase',
    async (name, kind) => {
      const target = await worker(name, kind),
        controller = new AbortController(),
        started = performance.now()
      const pending = runConfigurationScript(
        target.executable,
        'function main(c){return c}',
        {},
        controller.signal
      )
      void pending.catch(() => {})
      try {
        await vi.waitFor(
          async () => {
            if (kind === 'silent')
              expect(await readFile(target.received + '.meta', 'utf8')).toContain('cwd')
            else expect(await readFile(target.received, 'utf8')).toContain('configuration')
          },
          { timeout: 3000 }
        )
        controller.abort()
        await expect(pending).rejects.toMatchObject({ status: 'cancelled' })
        await closedWorkspace(target.received)
        if (kind === 'silent') await expect(readFile(target.received)).rejects.toThrow()
        facts.push({
          name,
          kind,
          elapsedMs: performance.now() - started,
          closeBeforeWorkspaceCleanup: true,
          SIGTERMIgnoredByWorker: true
        })
      } finally {
        controller.abort()
        await pending.catch(() => {})
      }
    },
    7000
  )
  it('retains the bounded stdout rejection', async () => {
    expect(await rejected('large', 'large')).toBeLessThan(6500)
  }, 8000)
})
