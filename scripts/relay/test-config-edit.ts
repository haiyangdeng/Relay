// Batch 33 host verification: override / sniffer / DNS / rules editing with
// real persistence and a priority-consistent merge preview. Saves an edit
// document, previews the merged runtime config against a real profile, and
// confirms the persisted edits survive a reload. No system mutation.
import { mkdtemp, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { ConfigurationEditStore } from '../../src/main/relay/configuration/edit-store'
import { createConfigurationEditService } from '../../src/main/relay/configuration/edit-service'
import { CoreStore } from '../../src/main/relay/core/store'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { createLocalProxyService } from '../../src/main/relay/core/local-proxy-service'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import { probeLocalPort } from '../../src/main/relay/core/port'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const rows: { name: string; passed: boolean; detail?: string }[] = []
const check = (name: string, passed: boolean, detail?: string): void => {
  rows.push({ name, passed, ...(detail ? { detail } : {}) })
}
const home = await mkdtemp('/private/tmp/relay-edit-host-'),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
const network = await createLocalNetworkFixture()
const profiles = new ProfileStore(context)
const store = new ConfigurationEditStore(context)
const service = createConfigurationEditService({ store, profiles })
const coreStore = new CoreStore(context)
const coreRoot = resolve('extra/relay/core')
let cleanup: (() => Promise<void>) | undefined
const local = createLocalProxyService({
  read: (selection, mode) => service.readRuntimeProfile(selection, mode),
  inspect: () => coreStore.inspect(),
  resources: () => verifyCoreResource(coreRoot),
  portAvailable: probeLocalPort,
  acquire: (runtime, revision) => coreStore.acquire('rule', revision, runtime),
  start: (source, port, register, resolverMode, dedicated) =>
    startLocalProxyCore(
      coreRoot,
      source,
      port,
      (stop) => {
        cleanup = stop
        register(stop)
      },
      resolverMode,
      dedicated
    ),
  confirmStart: async () => true,
  confirmStop: async () => true,
  confirmReload: async () => true
})

try {
  const saved = await profiles.save('Edit', network.source)
  // --- default document is empty ---
  const initial = await service.read()
  check(
    'initial edit document is empty and not yet persisted',
    !initial.exists && initial.document.globalOverrides.length === 0
  )

  // --- save a document with a global override (sniffer) + rule patch + controlSniff ---
  const persisted = await service.save({
    globalOverrides: [
      {
        id: 'sniff-on',
        kind: 'yaml',
        content: 'sniffer:\n  enable: true\n  override-destination: false\n'
      }
    ],
    profileOverrides: [],
    rulePatch: { prepend: ['DOMAIN,example.com,' + network.group] },
    controlled: { sniffer: { enable: true, 'override-destination': false } },
    controlSniff: true
  })
  check(
    'save persists the document with a revision',
    persisted.exists && persisted.revision.length === 64
  )

  // --- reload returns the same document ---
  const reread = await service.read()
  check(
    'reload returns the persisted overrides, rule patch and sniffer edit',
    reread.exists &&
      reread.document.globalOverrides[0].id === 'sniff-on' &&
      reread.document.rulePatch?.prepend?.[0] === 'DOMAIN,example.com,' + network.group &&
      (reread.document.controlled.sniffer as Record<string, unknown>).enable === true &&
      reread.revision === persisted.revision
  )

  // --- preview merges the override at the fixed priority ---
  const preview = await service.preview({
    profile: { id: saved.id, sha256: saved.sha256 },
    globalOverrides: persisted.document.globalOverrides,
    profileOverrides: [],
    rulePatch: persisted.document.rulePatch,
    controlled: persisted.document.controlled,
    controlSniff: true
  })
  const merged = preview.configuration as Record<string, unknown>
  check(
    'preview applies the sniffer override into the merged runtime config',
    JSON.stringify(merged.sniffer) ===
      JSON.stringify({ enable: true, 'override-destination': false })
  )
  const rules = Array.isArray(merged.rules) ? (merged.rules as string[]) : []
  check(
    'preview prepends the rule patch at the front of the rules list (priority)',
    rules[0] === 'DOMAIN,example.com,' + network.group
  )
  check(
    'preview reports the merge order and DNS state',
    preview.order.length > 0 && typeof preview.dns.effective === 'boolean'
  )

  // --- optionsFor sources from the persisted document ---
  const opts = await service.optionsFor({ id: saved.id, sha256: saved.sha256 })
  check(
    'optionsFor produces RuntimeMergeOptions from the persisted document',
    opts.options.globalOverrides[0].id === 'sniff-on' &&
      opts.options.controlSniff === true &&
      opts.profileId === saved.id
  )

  const selection = { id: saved.id, sha256: saved.sha256 }
  const editedSource = await service.readRuntimeProfile(selection)
  check(
    'runtime reads keep the original source id and SHA while binding saved edits',
    editedSource.profile.id === saved.id &&
      editedSource.profile.sha256 === saved.sha256 &&
      editedSource.revision !== (await profiles.read(selection)).revision
  )
  const port = await freeFixturePort()
  const prepared = await local.prepare({ profile: selection, httpPort: port })
  const started = await local.action({ action: 'start', evidenceId: prepared.evidenceId })
  check('saved sniffer and rule edits start in a real owned core', started.status === 'started')
  const live = await local.inspectLive()
  check(
    'owned runtime includes the saved sniffer setting and prepended rule',
    (live?.runtime.sniffer as Record<string, unknown>)?.enable === true &&
      (live?.runtime.rules as string[])?.[0] === 'DOMAIN,example.com,' + network.group
  )
  check(
    'traffic through the edited owned configuration reaches only the loopback fixture',
    (await network.request(port, 'config-edits')).includes('origin:/config-edits')
  )
  const updated = { ...persisted.document, controlled: { sniffer: { enable: false } } }
  await service.save(updated)
  const reload = await local.prepareReload({ profile: selection, httpPort: port })
  check(
    'explicit hot reload applies a later saved edit without replacing the process',
    (await local.reload({ evidenceId: reload.evidenceId })).status === 'reloaded' &&
      local.state().pid === started.state.pid
  )
  check(
    'reloaded runtime reflects the new sniffer setting',
    ((await local.inspectLive())?.runtime.sniffer as Record<string, unknown>)?.enable === false
  )
  const stale = await local.prepareReload({ profile: selection, httpPort: port })
  await service.save(persisted.document)
  check(
    'a saved edit changed after preparation invalidates hot reload',
    (await local.reload({ evidenceId: stale.evidenceId })).status === 'failed'
  )
  const stopped = await local.action({ action: 'stop', instanceId: local.state().instanceId })
  check(
    'only the fixture core is stopped and its listener is released',
    stopped.status === 'stopped' && (await probeLocalPort(port))
  )

  // --- clear restores the default document ---
  await service.clear()
  const cleared = await service.read()
  check('clear restores the empty default document', cleared.document.globalOverrides.length === 0)
} catch (error) {
  check(
    'host verification completed without throwing',
    false,
    error instanceof Error ? error.message : String(error)
  )
} finally {
  await cleanup?.()
  await rm(home, { recursive: true, force: true })
  await network.close()
}

const passed = rows.filter((row) => row.passed).length
const result = { checks: rows.length, passed, rows, hostAccepted: passed === rows.length }
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
process.exit(result.hostAccepted ? 0 : 1)
