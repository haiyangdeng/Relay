import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { createProfileService } from '../../src/main/relay/profiles/service'
import { pickProfileSource, profileHash } from '../../src/main/relay/profiles/source'

const home = await realpath(await mkdtemp('/private/tmp/relay-profile-contract-'))
const store = new ProfileStore({
  home,
  stateRoot: join(home, 'Library/Application Support/Relay-Preview')
})
const origin = join(home, 'local.yaml')
const text =
  '\uFEFF# exact source retained\n' +
  `
mixed-port: 7890
dns: {enable: true, nameserver: [https://test.invalid/dns-query]}
tun: {enable: true}
proxies:
  - {name: Node, type: ss, server: test.invalid, port: 443, cipher: aes-128-gcm, password: PRIVATE_TOKEN}
proxy-groups:
  - {name: Group, type: select, proxies: [Node, DIRECT]}
rules: ['MATCH,Group']
proxy-providers:
  External: {type: http, url: 'https://test.invalid/sub?PRIVATE_TOKEN', path: /must-not-read}
unknown-settings: {keep: true}
`
let confirmed = false,
  source = origin
const service = createProfileService({
  pick: () => pickProfileSource(source),
  confirm: async () => confirmed,
  save: (name, raw) => store.save(name, raw),
  list: () => store.list()
})
const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}
try {
  await writeFile(origin, text, { mode: 0o600 })
  check(
    'startup/list do not create the owned Profiles directory',
    (await service.list(undefined)).profiles.length === 0 && (await absent(store.directory))
  )
  const prepared = await service.prepare(undefined)
  if (!prepared) throw new Error('fixture selection missing')
  check(
    'structure checked without core acceptance or activation',
    prepared.inspection.structure === 'passed' &&
      prepared.inspection.coreCompatibility === 'notVerified' &&
      !prepared.inspection.active
  )
  check(
    'inspection summary counts nodes/groups/rules/providers',
    JSON.stringify(prepared.inspection.summary) ===
      JSON.stringify({ proxies: 1, groups: 1, rules: 1, proxyProviders: 1, ruleProviders: 0 })
  )
  check(
    'source hash and BOM byte length match exact original',
    prepared.sha256 === profileHash(text) && prepared.bytes === Buffer.byteLength(text)
  )
  check(
    'report never returns node credentials or subscription text',
    !JSON.stringify(prepared).includes('PRIVATE_TOKEN')
  )
  check('preparation does not persist', await absent(store.directory))
  check(
    'cancel does not copy files',
    (await service.save({ evidenceId: prepared.evidenceId })).status === 'cancelled' &&
      (await absent(store.directory))
  )
  confirmed = true
  const saved = await service.save({ evidenceId: prepared.evidenceId })
  check(
    'confirmed copy saves without activating',
    saved.status === 'saved' && (await service.list(undefined)).activeId === null
  )
  if (!saved.profile) throw new Error('fixture copy missing')
  const path = join(store.directory, saved.profile.id)
  check(
    'source and copy preserve exact bytes including BOM/comment/unknown settings',
    (await readFile(origin)).equals(Buffer.from(text)) &&
      (await readFile(join(path, 'profile.yaml'))).equals(Buffer.from(text))
  )
  check(
    'record directory and both files use private permissions',
    ((await lstat(path)).mode & 0o7777) === 0o700 &&
      ((await lstat(join(path, 'profile.yaml'))).mode & 0o7777) === 0o600 &&
      ((await lstat(join(path, 'metadata.json'))).mode & 0o7777) === 0o600
  )
  check(
    'list returns a validated independent record without credentials',
    (await service.list(undefined)).profiles.length === 1 &&
      !JSON.stringify(await service.list(undefined)).includes('PRIVATE_TOKEN')
  )
  let duplicateRejected = false
  try {
    await service.save({ evidenceId: prepared.evidenceId })
  } catch {
    duplicateRejected = true
  }
  check('confirmed save proof cannot be replayed', duplicateRejected)
  const changed = await service.prepare(undefined)
  await writeFile(origin, text + '# changed source\n')
  check(
    'source change after preparation prevents another copy',
    (await service.save({ evidenceId: changed?.evidenceId })).status === 'failed' &&
      (await service.list(undefined)).profiles.length === 1
  )
  const copy = join(path, 'profile.yaml')
  await writeFile(copy, text + '# changed copy\n')
  check(
    'external copy change is retained but not listed as usable',
    (await service.list(undefined)).incomplete === 1 &&
      (await readFile(copy, 'utf8')) === text + '# changed copy\n'
  )
  await writeFile(copy, text)
  const metadata = join(path, 'metadata.json'),
    before = await readFile(metadata, 'utf8')
  await writeFile(metadata, '{"version":2,"PRIVATE":"keep"}')
  check(
    'unknown metadata version remains untouched',
    (await service.list(undefined)).incomplete === 1 &&
      (await readFile(metadata, 'utf8')) === '{"version":2,"PRIVATE":"keep"}'
  )
  await writeFile(metadata, before)
  const other = join(home, 'invalid.yaml')
  await writeFile(other, 'proxy-groups: [{name: Cycle, type: select, proxies: [Cycle]}]')
  source = other
  const invalid = await service.prepare(undefined)
  check(
    'invalid group cycle cannot become a saved configuration',
    invalid?.inspection.structure === 'rejected' &&
      (await service.list(undefined)).profiles.length === 1
  )
  await Promise.all([store.save('Two', text), store.save('Three', text)])
  check(
    'concurrent immutable imports preserve every copy',
    (await service.list(undefined)).profiles.length === 3
  )
} finally {
  await service.whenIdle()
  await rm(home, { recursive: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  fakeHomeOnly: true,
  localFixtureSourcesOnly: true,
  coreExecuted: false,
  sourceTextExecuted: false,
  providersOrSubscriptionsFetched: false,
  actualUserConfigurationImportedOrChanged: false,
  actualSystemProxyDNSOrTUNChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  appOrBrowserLaunched: false,
  normalTrafficBackendEnabled: false,
  liveGuardEnabled: false
}
await writeFile('../evidence/profile-import-contract.json', JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Local profile import contract failed.')
