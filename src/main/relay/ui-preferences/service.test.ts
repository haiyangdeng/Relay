import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultUIPreferences,
  relayDefaultSidebarLayout,
  uiPreferences
} from '../../../shared/relay/ui-preferences'
import { RelayMaintenanceStore } from '../maintenance/store'
import { createPreviewBackend } from '../preview'
import { createUIPreferencesService } from './service'

const homes: string[] = []
const live = () => {}
const legacy = {
  version: 1,
  language: 'en-US',
  disableAnimations: true,
  rememberSelectedSiderCard: true,
  lockSiderCards: true,
  hideConnectionCardWave: true,
  siderOrder: defaultUIPreferences().siderOrder.toReversed(),
  siderWidth: 300,
  lastSelectedSiderCard: 'rule'
}
const legacyBytes = JSON.stringify(legacy, null, 4) + '\n'
const legacyRevision = createHash('sha256').update(legacyBytes).digest('hex')

async function fixture(bytes = legacyBytes) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-ui-prefs-')))
  homes.push(home)
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  const path = join(context.stateRoot, 'Configuration/ui-preferences.json')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, bytes, { mode: 0o600 })
  const service = createUIPreferencesService(context, live)
  await service.initialize()
  const preview = createPreviewBackend({
    preferences: () => service.state().value,
    patchView: (patch) => service.patchView(patch, live)
  })
  return { context, path, service, preview }
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe.runIf(process.getuid !== undefined)('Owned proxy-list display preferences', () => {
  it('applies a separately stored diagnostic limit only after a confirmed, current save', async () => {
    const { context, path } = await fixture()
    const capPath = join(dirname(path), 'app-log-preferences.json')
    const apply = vi.fn()
    const service = createUIPreferencesService(context, live, apply)
    expect(await service.readAppLogSize()).toEqual({ revision: '', sizeMiB: 10 })
    await expect(readFile(capPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(apply).toHaveBeenLastCalledWith(10)

    const recoveryCheck = vi.fn(async () => {
      throw new Error('pending recovery')
    })
    await expect(
      service.saveAppLogSize({ revision: '', sizeMiB: 3 }, live, recoveryCheck)
    ).rejects.toThrow('pending recovery')
    await expect(readFile(capPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(apply).toHaveBeenCalledTimes(1)

    const permit = async () => {}
    const saved = await service.saveAppLogSize({ revision: '', sizeMiB: 3 }, live, permit)
    expect(saved).toMatchObject({ revision: expect.stringMatching(/^[a-f0-9]{64}$/u), sizeMiB: 3 })
    expect(apply).toHaveBeenLastCalledWith(3)
    expect(await readFile(path, 'utf8')).toBe(legacyBytes)
    await expect(
      service.saveAppLogSize({ revision: '', sizeMiB: 4 }, live, permit)
    ).rejects.toThrow()
    for (const sizeMiB of [0, 101, 3.5, '3']) {
      expect(() =>
        service.saveAppLogSize({ revision: saved.revision, sizeMiB }, live, permit)
      ).toThrow()
    }
    expect(apply).toHaveBeenCalledTimes(2)
    expect(await createUIPreferencesService(context, live).readAppLogSize()).toEqual(saved)
    await writeFile(capPath, '{"version":1,"sizeMiB":-1}', { mode: 0o600 })
    await expect(service.readAppLogSize()).rejects.toThrow()
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('keeps old file bytes on read and saves the three existing one-key renderer updates', async () => {
    const { context, path, service, preview } = await fixture()
    expect(service.state().revision).toBe(legacyRevision)
    expect(preview('getAppConfig')).toMatchObject({
      language: legacy.language,
      siderOrder: legacy.siderOrder,
      siderWidth: legacy.siderWidth,
      hideUnavailableProxies: false,
      proxyDisplayOrder: 'default',
      proxyDisplayMode: 'simple'
    })
    expect(await readFile(path, 'utf8')).toBe(legacyBytes)

    await preview('patchAppConfig', { hideUnavailableProxies: true })
    await preview('patchAppConfig', { proxyDisplayOrder: 'delay' })
    await preview('patchAppConfig', { proxyDisplayMode: 'full' })

    const reopened = createUIPreferencesService(context, live)
    expect((await reopened.initialize()).value).toEqual({
      ...legacy,
      hideUnavailableProxies: true,
      proxyDisplayOrder: 'delay',
      proxyDisplayMode: 'full',
      proxyCols: 'auto',
      siderCardLayout: relayDefaultSidebarLayout,
      connectionDirection: 'asc',
      connectionOrderBy: 'time',
      profileDisplayDate: 'expire'
    })
    await preview('patchAppConfig', { hideUnavailableProxies: false })
    expect(preview('getAppConfig')).toMatchObject({ hideUnavailableProxies: false })
  })

  it('refuses malformed or mixed updates and a stale renderer save payload', async () => {
    const { path, service, preview } = await fixture()
    for (const patch of [
      { hideUnavailableProxies: 'false' },
      { proxyDisplayOrder: 'invalid' },
      { proxyDisplayMode: null },
      { proxyDisplayOrder: 'name', proxyDisplayMode: 'full' },
      { proxyDisplayMode: 'full', sysProxy: { enable: true } },
      { sysProxy: { enable: true } }
    ]) {
      await expect(preview('patchAppConfig', patch)).rejects.toThrow()
    }
    await expect(service.save(legacy, legacyRevision, live)).rejects.toThrow('字段无效')
    expect(await readFile(path, 'utf8')).toBe(legacyBytes)
    expect(service.state()).toMatchObject({ revision: legacyRevision, uncertain: false })
  })

  it('reads pre-column settings without rewriting and saves every fixed upstream column choice', async () => {
    const r5 = {
      ...legacy,
      hideUnavailableProxies: true,
      proxyDisplayOrder: 'name',
      proxyDisplayMode: 'full'
    }
    const bytes = JSON.stringify(r5, null, 4) + '\n'
    const { context, path, service, preview } = await fixture(bytes)
    const oldRevision = createHash('sha256').update(bytes).digest('hex')
    expect(service.state()).toMatchObject({
      revision: oldRevision,
      value: { ...r5, proxyCols: 'auto' }
    })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(() => uiPreferences(r5)).toThrow('字段无效')
    expect(() => uiPreferences({ ...legacy, proxyDisplayMode: 'full' }, 'stored')).toThrow(
      '字段无效'
    )

    for (const proxyCols of ['1', '2', '3', '4', 'auto', '2'] as const) {
      const current = service.state()
      await service.save({ ...current.value, proxyCols }, current.revision, live)
      expect(preview('getAppConfig')).toMatchObject({ proxyCols })
    }
    const reopened = createUIPreferencesService(context, live)
    expect((await reopened.initialize()).value).toEqual({
      ...r5,
      proxyCols: '2',
      siderCardLayout: relayDefaultSidebarLayout,
      connectionDirection: 'asc',
      connectionOrderBy: 'time',
      profileDisplayDate: 'expire'
    })
    const saved = await readFile(path, 'utf8')
    for (const proxyCols of [2, '0', '5', null, undefined]) {
      const current = service.state()
      await expect(
        service.save({ ...current.value, proxyCols }, current.revision, live)
      ).rejects.toThrow('列数无效')
    }
    expect(await readFile(path, 'utf8')).toBe(saved)
  })

  it('reads R6 preferences without rewriting and saves only a complete fixed sidebar layout', async () => {
    const {
      siderCardLayout: defaults,
      connectionDirection: _direction,
      connectionOrderBy: _order,
      profileDisplayDate: _date,
      ...r6
    } = defaultUIPreferences()
    const bytes = JSON.stringify({ ...r6, proxyCols: '4' }, null, 4) + '\n'
    const { path, service, preview } = await fixture(bytes)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(preview('getAppConfig')).toMatchObject({ siderCardLayout: defaults, proxyCols: '4' })
    const current = service.state()
    const layout = { ...defaults, dns: 'hidden', rule: 'col-span-2' } as const
    await service.save({ ...current.value, siderCardLayout: layout }, current.revision, live)
    expect(preview('getAppConfig')).toMatchObject({ siderCardLayout: layout, proxyCols: '4' })
    const saved = await readFile(path, 'utf8')
    const next = service.state()
    const { log: _omitted, ...incomplete } = layout
    for (const invalid of [
      undefined,
      incomplete,
      { ...layout, unknown: 'hidden' },
      { ...layout, dns: 2 }
    ])
      await expect(
        service.save({ ...next.value, siderCardLayout: invalid }, next.revision, live)
      ).rejects.toThrow('布局无效')
    await expect(preview('patchAppConfig', { siderCardLayout: defaults })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(saved)
  })

  it('keeps concurrent changes when the second service has an old byte revision', async () => {
    const { context, path, service } = await fixture()
    const other = createUIPreferencesService(context, live)
    await other.initialize()
    await other.patchView({ proxyDisplayOrder: 'name' }, live)
    const saved = await readFile(path, 'utf8')

    await expect(service.patchView({ proxyDisplayMode: 'full' }, live)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(saved)
    expect(service.state().uncertain).toBe(true)
    await service.initialize()
    await service.patchView({ proxyDisplayMode: 'full' }, live)
    expect(service.state().value).toMatchObject({
      proxyDisplayOrder: 'name',
      proxyDisplayMode: 'full'
    })
  })

  it('reads R14 settings without rewriting and persists both existing connection-sort controls', async () => {
    const {
      connectionDirection: _direction,
      connectionOrderBy: _order,
      profileDisplayDate: _date,
      ...previous
    } = defaultUIPreferences()
    const bytes = JSON.stringify({ ...previous, proxyCols: '3' }, null, 4) + '\n'
    const { context, path, service, preview } = await fixture(bytes)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(preview('getAppConfig')).toMatchObject({
      connectionDirection: 'asc',
      connectionOrderBy: 'time',
      proxyCols: '3'
    })
    expect(service.state().revision).toBe(createHash('sha256').update(bytes).digest('hex'))
    for (const connectionOrderBy of [
      'upload',
      'download',
      'uploadSpeed',
      'downloadSpeed',
      'time'
    ]) {
      await preview('patchAppConfig', { connectionOrderBy })
      expect(preview('getAppConfig')).toMatchObject({ connectionOrderBy })
    }
    await preview('patchAppConfig', { connectionDirection: 'desc' })
    await preview('patchAppConfig', { profileDisplayDate: 'update' })
    const reopened = createUIPreferencesService(context, live)
    expect((await reopened.initialize()).value).toMatchObject({
      connectionDirection: 'desc',
      connectionOrderBy: 'time',
      profileDisplayDate: 'update',
      proxyCols: '3'
    })
  })

  it('rejects invalid or mixed connection-sort patches without altering the stored document', async () => {
    const { path, preview } = await fixture()
    for (const patch of [
      { connectionDirection: 'down' },
      { connectionDirection: ['asc'] },
      { connectionOrderBy: ['time'] },
      { connectionOrderBy: 'host' },
      { profileDisplayDate: ['expire'] },
      { profileDisplayDate: 'created' },
      { profileDisplayDate: '' },
      { profileDisplayDate: false },
      { connectionDirection: 'desc', connectionOrderBy: 'time' },
      { connectionDirection: 'asc', sysProxy: { enable: true } }
    ])
      await expect(preview('patchAppConfig', patch)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(legacyBytes)
  })

  it('checks the lifecycle guard again immediately before committing the preference', async () => {
    const { path, service } = await fixture()
    await expect(
      service.patchView({ proxyDisplayMode: 'full' }, () => {
        if (readdirSync(dirname(path)).some((name) => name.startsWith('.simple-')))
          throw new Error('fixture invalidated')
      })
    ).rejects.toThrow('fixture invalidated')
    expect(await readFile(path, 'utf8')).toBe(legacyBytes)
    expect(readdirSync(dirname(path))).toEqual(['ui-preferences.json'])
  })

  it('normalizes an old verified maintenance snapshot without rewriting its original bytes', async () => {
    const { context } = await fixture()
    const store = new RelayMaintenanceStore(context)
    const id = '46a235b1-7a12-4747-a64b-0c79d7bc9371'
    const path = join(store.root, id, 'before.json')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, legacyBytes, { mode: 0o600 })
    expect(
      await store.restoreValue({
        id,
        phase: 'reset',
        beforeRevision: legacyRevision,
        beforeSHA256: legacyRevision,
        afterRevision: null
      })
    ).toEqual({
      ...legacy,
      hideUnavailableProxies: false,
      proxyDisplayOrder: 'default',
      proxyDisplayMode: 'simple',
      proxyCols: 'auto',
      siderCardLayout: relayDefaultSidebarLayout,
      connectionDirection: 'asc',
      connectionOrderBy: 'time',
      profileDisplayDate: 'expire'
    })
    expect(await readFile(path, 'utf8')).toBe(legacyBytes)
  })
})
