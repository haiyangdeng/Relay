import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MIHOMO_TUN_CONFIG, getDefaultMihomoTunDevice } from '../../../shared/appConfig'
import { ProfileStore } from '../profiles/store'
import { profileHash } from '../profiles/source'
import { ResourceStore } from '../resources/store'
import type { DefaultGeoResourceBinding, RuntimeAsset } from './bindings'
import { ConfigurationEditStore } from './edit-store'
import { createConfigurationEditService } from './edit-service'
import { createCompleteConfigurationService } from './service'

const homes: string[] = []
const source = { rules: ['MATCH,REJECT'] }
async function fixture(configuration: Record<string, unknown> = source) {
  const home = await mkdtemp('/private/tmp/relay-tun-prepare-')
  homes.push(home)
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    profiles = new ProfileStore(context),
    store = new ConfigurationEditStore(context),
    resources = new ResourceStore(context),
    profile = await profiles.save('TUN source', JSON.stringify(configuration)),
    selection = { id: profile.id, sha256: profile.sha256 },
    script = vi.fn(async (_script: string, value: Record<string, unknown>) => ({
      configuration: value,
      logs: [] as string[]
    })),
    defaultGeoResource = vi.fn(
      async (): Promise<DefaultGeoResourceBinding | undefined> => undefined
    ),
    check = vi.fn(async (text: string, _assets: readonly RuntimeAsset[]) => ({
      status: 'passed' as const,
      scope: 'complete-parser' as const,
      configurationSHA256: profileHash(text),
      coreVersion: 'v1.19.33',
      active: false as const,
      runtimeAccepted: false as const,
      warnings: []
    })),
    complete = createCompleteConfigurationService({
      profiles,
      providers: profiles,
      resources,
      defaultGeoResource,
      script,
      check
    }),
    editor = createConfigurationEditService({
      profiles,
      store,
      prepare: (request, recheck, enableTun) => complete.prepare(request, recheck, enableTun)
    })
  return {
    profiles,
    store,
    resources,
    selection,
    script,
    defaultGeoResource,
    check,
    complete,
    editor
  }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('TUN preparation from the selected saved profile', () => {
  it('prepares complete TUN defaults without saving edits or changing source bytes', async () => {
    const { profiles, store, selection, editor, complete } = await fixture(),
      original = await profiles.read(selection),
      initial = await store.read(),
      plan = await editor.prepareForTun(selection)
    expect(plan.readyForParserCheck).toBe(true)
    expect(plan.active).toBe(false)
    expect((await complete.check({ evidenceId: plan.evidenceId })).status).toBe('passed')
    const checked = await complete.takeChecked({ evidenceId: plan.evidenceId })
    expect(JSON.parse(checked.configuration).tun).toEqual({
      ...DEFAULT_MIHOMO_TUN_CONFIG,
      device: getDefaultMihomoTunDevice(process.platform),
      enable: true,
      'dns-hijack': []
    })
    expect(await store.read()).toEqual(initial)
    expect(initial.exists).toBe(false)
    expect(await profiles.read(selection)).toEqual(original)
    await checked.recheck()
    await expect(
      editor.prepare({ profile: selection, bindings: [], revision: '' })
    ).rejects.toThrow('版本已变化')
  })

  it('retains source and selected TUN overrides while executing scripts once', async () => {
    const { profiles, store, selection, editor, script, complete } = await fixture({
      ...source,
      dns: { enable: true, nameserver: ['1.1.1.1'] },
      tun: { enable: false, device: 'utun1507', 'auto-detect-interface': false }
    })
    const original = await profiles.read(selection),
      saved = await editor.save({
        globalOverrides: [{ id: 'script', kind: 'js', content: 'main' }],
        profileOverrides: [],
        profileOverrideSets: [
          {
            profileId: selection.id,
            overrides: [
              {
                id: 'tun',
                kind: 'yaml',
                content:
                  'tun: {enable: false, stack: system, mtu: 1400, auto-route: false, strict-route: true}'
              }
            ]
          }
        ],
        controlled: {},
        controlDns: false
      }),
      plan = await editor.prepareForTun(selection)
    expect((await complete.check({ evidenceId: plan.evidenceId })).status).toBe('passed')
    const checked = await complete.takeChecked({ evidenceId: plan.evidenceId })
    expect(JSON.parse(checked.configuration).tun).toMatchObject({
      enable: true,
      device: 'utun1507',
      stack: 'system',
      mtu: 1400,
      'auto-route': false,
      'auto-detect-interface': false,
      'strict-route': true
    })
    expect(script).toHaveBeenCalledOnce()
    expect(await store.read()).toEqual(saved)
    expect(await profiles.read(selection)).toEqual(original)
  })

  it('revokes a missing-edit proof when an edit file appears before check', async () => {
    const { store, selection, editor, complete, check } = await fixture(),
      plan = await editor.prepareForTun(selection)
    await store.save({ globalOverrides: [], profileOverrides: [], controlled: {} })
    expect((await complete.check({ evidenceId: plan.evidenceId })).status).toBe('unavailable')
    expect(check).not.toHaveBeenCalled()
  })

  it('runs the existing Smart TUN route exclusions before applying missing defaults', async () => {
    const { selection, editor, complete } = await fixture({
      ...source,
      proxies: [{ name: 'Node', type: 'http', server: '192.0.2.7', port: 443 }],
      tun: { enable: false }
    })
    await editor.save({
      globalOverrides: [
        { id: 'smart', role: 'smart', kind: 'yaml', content: 'tun: {auto-route: true}' }
      ],
      profileOverrides: [],
      controlled: {}
    })
    const plan = await editor.prepareForTun(selection)
    await complete.check({ evidenceId: plan.evidenceId })
    const checked = await complete.takeChecked({ evidenceId: plan.evidenceId })
    expect(JSON.parse(checked.configuration).tun['route-exclude-address']).toEqual(['192.0.2.7/32'])
  })

  it('rechecks edits after asynchronous composition and again before activation', async () => {
    const { store, selection, editor, complete, script, check } = await fixture(),
      document = {
        globalOverrides: [{ id: 'script', kind: 'js' as const, content: 'main' }],
        profileOverrides: [],
        controlled: {}
      }
    await editor.save(document)
    script.mockImplementationOnce(async (_script, configuration) => {
      await store.save({ ...document, controlled: { ipv6: true } })
      return { configuration, logs: [] }
    })
    await expect(editor.prepareForTun(selection)).rejects.toThrow('已变化')
    expect(check).not.toHaveBeenCalled()
    const plan = await editor.prepareForTun(selection)
    await complete.check({ evidenceId: plan.evidenceId })
    const checked = await complete.takeChecked({ evidenceId: plan.evidenceId })
    await store.clear()
    await expect(checked.recheck()).rejects.toThrow('版本已变化')
  })

  it('uses saved Geo bindings and prevents incomplete or changed local assets from becoming checked', async () => {
    const { resources, selection, editor, complete, defaultGeoResource, check } = await fixture({
      ...source,
      'geodata-mode': true,
      rules: ['GEOSITE,CN,REJECT', 'MATCH,REJECT']
    })
    const unresolved = await editor.prepareForTun(selection)
    expect(unresolved.readyForParserCheck).toBe(false)
    expect(check).not.toHaveBeenCalled()
    const stored = await resources.save(
        { name: 'GeoSite', kind: 'geosite-dat', behavior: null, selector: 'CN' },
        Buffer.from('synthetic GeoSite test bytes')
      ),
      selected = { id: stored.id, sha256: stored.sha256 },
      read = await resources.read(selected),
      recheck = vi.fn(async () => {})
    defaultGeoResource.mockResolvedValue({ selection: selected, revision: read.revision, recheck })
    const plan = await editor.prepareForTun(selection)
    expect(plan.resources).toBe(1)
    expect((await complete.check({ evidenceId: plan.evidenceId })).status).toBe('passed')
    expect(check.mock.calls[0][1][0].bytes.toString()).toBe('synthetic GeoSite test bytes')
    const checked = await complete.takeChecked({ evidenceId: plan.evidenceId })
    recheck.mockRejectedValueOnce(new Error('Geo head changed'))
    await expect(checked.recheck()).rejects.toThrow('Geo head changed')
  })

  it('rejects renderer options and stale source identity instead of accepting arbitrary TUN configuration', async () => {
    const { selection, editor } = await fixture()
    await expect(editor.prepareForTun({ ...selection, options: { tun: {} } })).rejects.toThrow(
      '只接受'
    )
    await expect(editor.prepareForTun({ ...selection, sha256: '0'.repeat(64) })).rejects.toThrow()
  })
})
