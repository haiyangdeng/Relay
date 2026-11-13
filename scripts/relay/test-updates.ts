// Offline contract using the previously verified official core archive cache.
// No remote download, App installation, in-use core swap or core execution.
import { mkdtemp, realpath, rm, readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { trustedUpdateCatalog } from '../../src/main/relay/updates/catalog'
import { UpdateCandidateStore } from '../../src/main/relay/updates/store'
import { createUpdateService } from '../../src/main/relay/updates/service'
import { VariantStore } from '../../src/main/relay/core/variant-store'
import { readBinaryResource } from '../../src/main/relay/resources/source'

const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
const home = await realpath(await mkdtemp('/private/tmp/relay-update-contract-'))
const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
let permitted = false
let requests = 0
try {
  const catalog = trustedUpdateCatalog()
  const core = catalog.find((asset) => asset.target === 'core')
  if (!core?.architecture) throw new Error('No supported host architecture')
  const archive = await readBinaryResource(
    resolve('.relay-build/core-downloads', new URL(core.url).pathname.split('/').at(-1) ?? '')
  )
  const store = new UpdateCandidateStore(context, catalog)
  const variants = new VariantStore(context)
  const service = createUpdateService({
    store,
    assertIdle: () => {},
    confirmDownload: async () => permitted,
    confirmRemove: async () => permitted,
    confirmImport: async () => permitted,
    importCandidate: async (request) => {
      await variants.acquire(request)
    },
    download: async (_pin, _port, signal) => {
      if (signal.aborted) throw new Error('cancelled')
      requests++
      return archive
    }
  })
  const initial = await service.state()
  check(
    'catalog inspection performs no network request and does not claim latest-version discovery',
    requests === 0 && !initial.discoversLatestVersions && !initial.appReleaseChannelConfigured
  )
  const cancelled = service.prepare({ target: 'core', proxyPort: 7890 })
  check(
    'download cancellation preserves the empty candidate list',
    (await service.execute({ evidenceId: cancelled.evidenceId })).status === 'cancelled' &&
      requests === 0
  )
  permitted = true
  const prepared = service.prepare({ target: 'core', proxyPort: 7890 })
  const staged = await service.execute({ evidenceId: prepared.evidenceId })
  check(
    'official cached gzip passes compressed and expanded digest, size and Mach-O checks',
    staged.status === 'staged' && staged.candidate?.payloadSHA256 === core.payloadSHA256
  )
  check(
    'a staged resource is explicitly neither installed nor applied',
    staged.candidate?.installed === false && staged.candidate.applied === false
  )
  permitted = false
  check(
    'candidate import requires an independent positive consent',
    (await service.importVariant({ id: staged.candidate?.id })).status === 'cancelled' &&
      (await variants.list()).records.length === 0
  )
  permitted = true
  if ((await service.importVariant({ id: staged.candidate?.id })).status !== 'imported')
    throw new Error('Import cancelled.')
  const imported = (await variants.list()).records.at(-1)
  if (!imported) throw new Error('Missing imported record.')
  check(
    'an explicitly separate trusted variant import accepts the staged core bytes',
    imported.kind === 'core' && imported.sha256 === core.payloadSHA256
  )
  check(
    'variant import does not activate or replace an in-use core',
    (await variants.list()).activeCoreId === undefined
  )
  check(
    'candidate listing revalidates the cached private payload',
    (await service.state()).candidates.length === 1
  )
  const removed = await service.remove({ id: staged.candidate?.id })
  check(
    'candidate removal leaves the imported independent copy intact',
    removed.status === 'removed' &&
      (await variants.verify(imported.id)).sha256 === core.payloadSHA256
  )
  check(
    'no product installation capability was introduced',
    (await service.state()).installationSupported === false
  )
  check(
    'fixture read uses actual nonempty official compressed bytes',
    archive.length === core.downloadBytes &&
      (await readFile(resolve('extra/relay/core', `darwin-${core.architecture}/mihomo`))).length ===
        core.payloadBytes
  )
  for (const asset of catalog.filter((asset) =>
    ['core-alpha', 'core-smart', 'smart-model', 'smart-model-middle', 'smart-model-large'].includes(
      asset.target
    )
  )) {
    const family =
      asset.target === 'core-alpha' ? 'alpha' : asset.target === 'core-smart' ? 'smart' : 'model'
    const file = new URL(asset.url).pathname.split('/').at(-1)
    if (!file) throw new Error('Missing fixed asset filename.')
    const bytes = await readBinaryResource(
      resolve('.relay-build/variant-reference', `${family}-${file}`)
    )
    const staged = await store.stage(asset, bytes)
    if ((await service.importVariant({ id: staged.id })).status !== 'imported')
      throw new Error('Import cancelled.')
    const imported = (await variants.list()).records.at(-1)
    if (!imported) throw new Error('Missing imported variant.')
    check(
      `${asset.target}: official cached bytes pass download and payload verification`,
      staged.payloadSHA256 === asset.payloadSHA256
    )
    check(
      `${asset.target}: a separate private import retains exact bytes`,
      (await variants.verify(imported.id)).sha256 === asset.payloadSHA256
    )
    await store.remove(staged.id)
    check(
      `${asset.target}: removing a candidate preserves the independent import without activating it`,
      (await variants.verify(imported.id)).sha256 === asset.payloadSHA256 &&
        (await variants.list()).activeCoreId === undefined &&
        (await variants.list()).activeSmartId === undefined
    )
  }
} catch {
  check('offline fixed-resource contract completes', false)
} finally {
  await rm(home, { recursive: true, force: true })
}
const passed = rows.filter((row) => row.passed).length
process.stdout.write(
  JSON.stringify(
    {
      checks: rows.length,
      passed,
      rows,
      fixtureAccepted: passed === rows.length,
      networkDownloadExercised: false,
      coreExecuted: false,
      appInstalled: false
    },
    null,
    2
  ) + '\n'
)
process.exitCode = passed === rows.length ? 0 : 1
