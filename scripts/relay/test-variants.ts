// Batch 34 host verification: acquire / verify / switch / restore cycle for
// core variants and Smart model resources, using a fixture file as a smart
// model and the pinned core manifest default as the always-restorable
// baseline. No system mutation, no current Clash change.
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { VariantStore } from '../../src/main/relay/core/variant-store'
import { createVariantService } from '../../src/main/relay/core/variant-service'

const rows: { name: string; passed: boolean; detail?: string }[] = []
const check = (name: string, passed: boolean, detail?: string): void => {
  rows.push({ name, passed, ...(detail ? { detail } : {}) })
}
const home = await mkdtemp('/private/tmp/relay-variant-'),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
const store = new VariantStore(context)
const service = createVariantService({
  store,
  confirmAcquire: async () => true,
  confirmSelect: async () => true,
  confirmRemove: async () => true
})

async function sha256(buffer: Buffer): Promise<string> {
  return createHash('sha256').update(buffer).digest('hex')
}

try {
  // --- initial state: empty, pinned default restorable ---
  const initial = await service.state()
  check(
    'initial variant state is empty with pinned default restorable',
    initial.records.length === 0 && initial.pinnedDefault === true
  )

  // --- acquire a Smart model from a fixture file ---
  const modelBytes = Buffer.from('tree\n' + 'fixture-only\n'.repeat(64) + '[/target_enhance]\n')
  const modelPath = join(home, 'model.bin')
  await writeFile(modelPath, modelBytes)
  const modelSha = await sha256(modelBytes)
  await service.prepareAcquire({
    kind: 'smart',
    sourcePath: modelPath,
    version: 'smart-1.0',
    sha256: modelSha,
    size: modelBytes.length
  })
  const acquired = await service.executeAcquire()
  check(
    'smart model acquire copies and verifies the fixture',
    'id' in acquired && acquired.kind === 'smart' && acquired.sha256 === modelSha
  )

  // --- sha mismatch is refused ---
  await service.prepareAcquire({
    kind: 'smart',
    sourcePath: modelPath,
    version: 'smart-bad',
    sha256: 'f'.repeat(64),
    size: modelBytes.length
  })
  let refused = false
  try {
    await service.executeAcquire()
  } catch {
    refused = true
  }
  check('acquire refuses when the SHA-256 does not match', refused)

  // --- size mismatch is refused ---
  await service.prepareAcquire({
    kind: 'smart',
    sourcePath: modelPath,
    version: 'smart-bad-size',
    sha256: modelSha,
    size: modelBytes.length + 1
  })
  refused = false
  try {
    await service.executeAcquire()
  } catch {
    refused = true
  }
  check('acquire refuses when the size does not match', refused)

  // --- select + restore cycle ---
  const list = await service.state()
  const smartId = list.records.find((r) => r.kind === 'smart')?.id
  check('acquired smart model appears in the variant list', !!smartId)
  if (smartId) {
    const selected = await service.select({ id: smartId })
    check(
      'select records the smart resource preference without claiming model loading',
      'id' in selected && selected.id === smartId
    )
    const afterSelect = await service.state()
    check('smart resource preference is recorded', afterSelect.activeSmartId === smartId)
    await service.restore('smart')
    const afterRestore = await service.state()
    check(
      'restore reverts the active smart selection to the pinned default',
      afterRestore.activeSmartId === undefined && afterRestore.pinnedDefault === true
    )
  }

  // --- remove deletes the record and its private copy ---
  if (smartId) {
    await service.remove({ id: smartId })
    const afterRemove = await service.state()
    check(
      'remove deletes the record and clears any active selection',
      !afterRemove.records.some((r) => r.id === smartId) && afterRemove.activeSmartId === undefined
    )
  }

  // --- core variant restore (without acquiring a second real core) ---
  await service.restore('core')
  const coreRestored = await service.state()
  check(
    'core restore keeps the pinned default restorable',
    coreRestored.activeCoreId === undefined && coreRestored.pinnedDefault === true
  )
} catch (error) {
  check(
    'host verification completed without throwing',
    false,
    error instanceof Error ? error.message : String(error)
  )
} finally {
  await rm(home, { recursive: true, force: true })
}

const passed = rows.filter((row) => row.passed).length
const result = {
  checks: rows.length,
  passed,
  rows,
  scope: 'private-file-fixture',
  smartRuntimeAccepted: false,
  hostAccepted: passed === rows.length
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
process.exit(result.hostAccepted ? 0 : 1)
