import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultSystemProxyDraft,
  systemProxyDraft,
  systemProxyDraftRecord,
  systemProxyDraftSaveRequest
} from '../../../shared/relay/system-proxy-draft'
import { RelayBackupStore } from '../backup/store'
import { SystemProxyDraftStore } from './draft-store'

const homes: string[] = []
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-sysproxy-defaults-')))
  homes.push(home)
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  return { context, store: new SystemProxyDraftStore(context) }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('Portable system proxy draft schema', () => {
  it('has only editable defaults, preserving false and an empty bypass list', () => {
    const document = {
      ...defaultSystemProxyDraft(),
      socks: false,
      excludeSimple: false,
      bypass: []
    }
    expect(systemProxyDraft(document)).toEqual(document)
    expect(Object.keys(document).sort()).toEqual([
      'bypass',
      'excludeSimple',
      'host',
      'mode',
      'pacScript',
      'socks'
    ])
    expect(systemProxyDraftRecord({ document, revision: '', exists: false })).toEqual({
      document,
      revision: '',
      exists: false
    })
  })
  it.each([
    { port: 7890 },
    { serviceIDs: ['Wi-Fi'] },
    { active: true },
    { enabled: true },
    { path: '/private/other' }
  ])('rejects runtime/authority fields: %o', (extra) => {
    expect(() => systemProxyDraft({ ...defaultSystemProxyDraft(), ...extra })).toThrow('字段无效')
  })
  it.each([
    { mode: 'global' },
    { host: 'https://proxy.example' },
    { host: 'a\nb' },
    { bypass: ['10.0.0.0/99'] },
    { mode: 'pac', pacScript: '' },
    { pacScript: '\0' },
    { socks: 'false' }
  ])('reuses apply-time field validation: %o', (patch) => {
    expect(() => systemProxyDraft({ ...defaultSystemProxyDraft(), ...patch })).toThrow()
  })
  it('rejects unknown request fields, invalid revisions and inconsistent readback records', () => {
    const document = defaultSystemProxyDraft()
    expect(() =>
      systemProxyDraftSaveRequest({ document, expectedRevision: '', grant: true })
    ).toThrow()
    expect(() => systemProxyDraftSaveRequest({ document, expectedRevision: 'stale' })).toThrow()
    expect(() => systemProxyDraftRecord({ document, exists: true, revision: '' })).toThrow()
    expect(() =>
      systemProxyDraftRecord({ document, exists: false, revision: 'a'.repeat(64) })
    ).toThrow()
  })
})

describe.runIf(process.getuid !== undefined)('System proxy draft private storage', () => {
  it('shares concurrent launch and panel reads, with independent results and caller checks', async () => {
    const { store } = await fixture()
    let checks = 0
    const first = store.read()
    const second = store.read(() => {
      ++checks
    })
    expect(store.isReading()).toBe(true)
    const [one, two] = await Promise.all([first, second])
    expect(checks).toBe(2)
    expect(one).toEqual(two)
    expect(one.document).not.toBe(two.document)
    expect(store.isReading()).toBe(false)
  })
  it('reads defaults without creating a file or carrying service selection/Clash port', async () => {
    const { context, store } = await fixture()
    expect(store.path).toBe(join(context.stateRoot, 'Configuration/system-proxy-defaults.json'))
    expect(await store.read()).toEqual({
      document: defaultSystemProxyDraft(),
      revision: '',
      exists: false
    })
    await expect(lstat(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('saves exact portable values with private permissions and includes them in the existing backup root', async () => {
    const { context, store } = await fixture()
    const document = {
      ...defaultSystemProxyDraft(),
      host: 'localhost',
      mode: 'pac' as const,
      socks: true,
      excludeSimple: false,
      bypass: ['<local>', '127.0.0.1', '10.0.0.0/8'],
      pacScript:
        'function FindProxyForURL(url, host) { return "PROXY %proxy-host%:%mixed-port%; DIRECT"; }'
    }
    const record = await store.save({ document, expectedRevision: '' })
    expect(record.document).toEqual(document)
    expect(record.exists).toBe(true)
    const bytes = await readFile(store.path)
    expect(record.revision).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect((await lstat(store.path)).mode & 0o7777).toBe(0o600)
    expect(await new SystemProxyDraftStore(context).read()).toEqual(record)
    const snapshot = await new RelayBackupStore(context).snapshot()
    const entry = snapshot.entries.find(
      (entry) => entry.path === 'Configuration/system-proxy-defaults.json'
    )
    expect(entry?.bytes).toEqual(bytes)
  })
  it('does not overwrite a newer value from another store instance', async () => {
    const { context, store } = await fixture()
    const saved = await store.save({ document: defaultSystemProxyDraft(), expectedRevision: '' })
    const other = new SystemProxyDraftStore(context)
    await other.save({
      document: { ...saved.document, host: 'proxy.example' },
      expectedRevision: saved.revision
    })
    await expect(
      store.save({ document: saved.document, expectedRevision: saved.revision })
    ).rejects.toThrow()
    expect((await store.read()).document.host).toBe('proxy.example')
  })
  it('supports a valid PAC larger than the unrelated 16 KiB UI preference cap', async () => {
    const { store } = await fixture()
    const document = {
      ...defaultSystemProxyDraft(),
      pacScript: '// ' + '例'.repeat(30000) + '\n' + defaultSystemProxyDraft().pacScript
    }
    const record = await store.save({ document, expectedRevision: '' })
    expect((await store.read()).document.pacScript).toBe(document.pacScript)
    expect(record.revision).toMatch(/^[a-f0-9]{64}$/u)
  })
  it('freezes the validated input and exposes a busy/idle barrier until the write settles', async () => {
    const { store } = await fixture()
    const gate = Promise.withResolvers<void>()
    const document = defaultSystemProxyDraft()
    const saving = store.save(
      { document, expectedRevision: '' },
      () => {},
      () => gate.promise
    )
    expect(store.isBusy()).toBe(true)
    let idle = false
    const settled = store.whenIdle().then(() => {
      idle = true
    })
    document.bypass.push('changed-after-request.example')
    await expect(store.read()).rejects.toThrow('尚未结束')
    expect(idle).toBe(false)
    gate.resolve()
    const result = await saving
    await settled
    expect(store.isBusy()).toBe(false)
    expect(result.document.bypass).not.toContain('changed-after-request.example')
  })
  it('rechecks ownership/recovery immediately before commit and leaves the old document untouched', async () => {
    const { store } = await fixture()
    const saved = await store.save({ document: defaultSystemProxyDraft(), expectedRevision: '' })
    let checks = 0
    await expect(
      store.save(
        {
          document: { ...saved.document, host: 'changed.example' },
          expectedRevision: saved.revision
        },
        () => {},
        async () => {
          if (++checks === 2) throw new Error('recovery changed')
        }
      )
    ).rejects.toThrow('recovery changed')
    expect(await store.read()).toEqual(saved)
  })
  it('refuses insecure files and symbolic links without deleting or rewriting them', async () => {
    const { context, store } = await fixture()
    await store.save({ document: defaultSystemProxyDraft(), expectedRevision: '' })
    const bytes = await readFile(store.path)
    await chmod(store.path, 0o644)
    await expect(store.read()).rejects.toThrow()
    expect(await readFile(store.path)).toEqual(bytes)
    await rm(store.path)
    const target = join(context.home, 'other.json')
    await writeFile(target, bytes, { mode: 0o600 })
    await symlink(target, store.path)
    await expect(store.read()).rejects.toThrow()
    expect((await lstat(store.path)).isSymbolicLink()).toBe(true)
    expect(await readFile(target)).toEqual(bytes)
  })
})
