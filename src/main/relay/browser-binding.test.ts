import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { connect } from 'net'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  validateBrowserBinding,
  type RelayBrowserBinding
} from '../../shared/relay/browser-binding'
import { createBrowserBindingChannel } from './browser-binding'

const binding: RelayBrowserBinding = {
  instanceId: '00000000-0000-0000-0000-000000000001',
  configurationRevision: 'a'.repeat(64),
  pid: 1234,
  httpPort: 18193,
  route: 'fixture-node'
}
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})
async function fixture(read: () => Promise<RelayBrowserBinding> = async () => binding) {
  const home = await realpath(await mkdtemp('/tmp/rb-'))
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const channel = createBrowserBindingChannel(context, read)
  cleanups.push(() => channel.dispose())
  return { context, channel }
}
async function query(
  root: string,
  request: unknown = { version: 1, action: 'binding', nonce: 'a'.repeat(64) }
): Promise<string> {
  const { endpoint } = JSON.parse(await readFile(join(root, 'Browser/active.json'), 'utf8'))
  return new Promise((resolve, reject) => {
    const client = connect(join(root, 'Browser', endpoint))
    let result = ''
    client.setTimeout(4000, () => client.destroy(new Error('fixture deadline')))
    client.once('connect', () => client.write(JSON.stringify(request) + '\n'))
    client.on('data', (data) => {
      result += data.toString()
    })
    client.once('error', reject)
    client.once('close', () => resolve(result))
  })
}
describe('Relay browser current-owner channel', () => {
  it('answers with fresh owned binding on every nonce-bound read, including custom ports', async () => {
    let reads = 0
    const f = await fixture(async () => ({ ...binding, httpPort: ++reads === 1 ? 18193 : 18293 }))
    expect(await f.channel.start()).toBe(true)
    expect(JSON.parse(await query(f.context.stateRoot))).toEqual({
      version: 1,
      nonce: 'a'.repeat(64),
      binding
    })
    expect(JSON.parse(await query(f.context.stateRoot)).binding.httpPort).toBe(18293)
    expect(reads).toBe(2)
    expect(await f.channel.start()).toBe(false)
  })
  it('rejects absent owner instead of returning a previous successful reply', async () => {
    let live = true
    const f = await fixture(async () => {
      if (!live) throw new Error('PRIVATE')
      return binding
    })
    expect(await f.channel.start()).toBe(true)
    expect(await query(f.context.stateRoot)).toContain('fixture-node')
    live = false
    expect(await query(f.context.stateRoot)).toBe('')
  })
  it('accepts only the bounded readonly command and never returns internal errors', async () => {
    let reads = 0
    const f = await fixture(async () => {
      reads++
      return binding
    })
    expect(await f.channel.start()).toBe(true)
    expect(
      await query(f.context.stateRoot, {
        version: 1,
        action: 'launch',
        nonce: 'a'.repeat(64),
        url: 'https://private.invalid'
      })
    ).toBe('')
    expect(reads).toBe(0)
  })
  it('discards late replies after the endpoint locator belongs to another instance', async () => {
    let release!: (binding: RelayBrowserBinding) => void, entered!: () => void
    const called = new Promise<void>((resolve) => {
      entered = resolve
    })
    const f = await fixture(async () => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    expect(await f.channel.start()).toBe(true)
    const pending = query(f.context.stateRoot)
    await called
    const locator = join(f.context.stateRoot, 'Browser/active.json')
    const replacement = JSON.stringify({ version: 1, endpoint: 'b-1111111111111111.sock' })
    await writeFile(locator, replacement, { mode: 0o600 })
    release(binding)
    expect(await pending).toBe('')
    await f.channel.dispose()
    expect(await readFile(locator, 'utf8')).toBe(replacement)
  })
  it('closes only its socket and leaves discovery for safe atomic replacement', async () => {
    const f = await fixture()
    expect(await f.channel.start()).toBe(true)
    const locator = join(f.context.stateRoot, 'Browser/active.json')
    const before = await readFile(locator, 'utf8')
    await f.channel.dispose()
    expect(await readFile(locator, 'utf8')).toBe(before)
    await expect(query(f.context.stateRoot)).rejects.toThrow()
  })
  it('rejects unavailable, direct, extra-key, malformed and conflicting-port bindings', () => {
    for (const invalid of [
      null,
      { ...binding, route: 'DIRECT' },
      { ...binding, pid: 0 },
      { ...binding, extra: true },
      { ...binding, httpPort: 80 },
      { ...binding, socksPort: binding.httpPort }
    ])
      expect(() => validateBrowserBinding(invalid)).toThrow()
    expect(validateBrowserBinding({ ...binding, socksPort: 18190 })).toEqual({
      ...binding,
      socksPort: 18190
    })
  })
})
