import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { ResourceStore } from '../../src/main/relay/resources/store'
import { createCompleteConfigurationService } from '../../src/main/relay/configuration/service'
import { composeRuntimeConfiguration } from '../../src/main/relay/configuration/merge'
import { collectRuntimeDependencies } from '../../src/main/relay/configuration/dependencies'
import { bindRuntimeResources } from '../../src/main/relay/configuration/bindings'
import {
  checkCompleteConfiguration,
  validateBoundConfiguration
} from '../../src/main/relay/configuration/checker'
import { runConfigurationScript } from '../../src/main/relay/configuration/script'
import { geositeFixture, geoipFixture } from './fixtures/rule-resources'
import { createLocalNetworkFixture, freeFixturePort } from './fixtures/local-network'

const exec = promisify(execFile),
  home = await realpath(await mkdtemp('/private/tmp/relay-full-config-')),
  context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
  profiles = new ProfileStore(context),
  providers = new ProfileStore(context, 'ProviderResources'),
  resources = new ResourceStore(context),
  coreRoot = resolve('extra/relay/core'),
  native = resolve('extra/relay/RelayNative'),
  network = await createLocalNetworkFixture(),
  rows: { name: string; passed: boolean; status?: string }[] = []
const check = (name: string, passed: boolean, status?: string): void => {
  rows.push({ name, passed, ...(status ? { status } : {}) })
}
const selection = (item: { id: string; sha256: string }) => ({ id: item.id, sha256: item.sha256 })
let scriptCalls = 0
const service = createCompleteConfigurationService({
  profiles,
  providers,
  resources,
  script: (script, configuration, signal) => {
    ++scriptCalls
    return runConfigurationScript(native, script, configuration, signal)
  },
  check: (source, assets, signal) => checkCompleteConfiguration(coreRoot, source, assets, signal)
})
try {
  await mkdir(join(home, '.claude'), { mode: 0o700 })
  const sentinel = join(home, '.claude/settings.json')
  await writeFile(sentinel, '{"PRIVATE":"unchanged"}', { mode: 0o600 })
  const input = JSON.parse(network.source)
  const spare = await freeFixturePort()
  Object.assign(input, {
    port: spare,
    'mixed-port': 0,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    ipv6: false,
    dns: {
      enable: true,
      'use-system-hosts': false,
      nameserver: ['127.0.0.1:1053'],
      'default-nameserver': ['127.0.0.1'],
      'proxy-server-nameserver': ['127.0.0.1']
    },
    hosts: { 'private.invalid': '127.0.0.1' },
    ntp: { enable: false, 'write-to-system': false },
    tun: { enable: false },
    'external-controller': '',
    'external-ui': '',
    'geodata-mode': true,
    listeners: [
      {
        name: 'LocalHTTP',
        type: 'http',
        listen: '127.0.0.1',
        port: String(await freeFixturePort())
      }
    ],
    'sub-rules': { Fixture: ['DOMAIN,fixture.invalid,REJECT', 'MATCH,REJECT'] },
    'rule-providers': {
      Rules: {
        type: 'http',
        behavior: 'classical',
        format: 'text',
        url: 'https://PRIVATE.invalid/rules',
        header: { Authorization: ['PRIVATE'] }
      }
    },
    rules: ['RULE-SET,Rules,REJECT', 'GEOSITE,RELAY,REJECT', 'MATCH,REJECT']
  })
  const stored = await profiles.save('Full fixture', JSON.stringify(input))
  const common = {
    profile: selection(stored),
    options: {
      globalOverrides: [
        { id: 'global', kind: 'yaml', content: 'tcp-concurrent: true' },
        {
          id: 'script',
          kind: 'js',
          content:
            'function main(c){console.log("PRIVATE script log");c["global-ua"]="Relay-Fixture-"+Math.random();return c}'
        }
      ],
      profileOverrides: [],
      controlled: { mode: 'rule' },
      controlDns: true
    },
    bindings: []
  }
  const missing = await service.prepare(common)
  check(
    'complete App service preserves protected DNS and blocks missing rule/geographic dependencies',
    missing.dns.autoDisabled &&
      !missing.readyForParserCheck &&
      missing.dependencies.some((item) => item.kind === 'rule-text') &&
      missing.dependencies.some((item) => item.kind === 'geosite-dat')
  )
  check(
    'public preparation has no original provider URL, private header, configuration or script log',
    !JSON.stringify(missing).includes('PRIVATE')
  )
  const rules = await resources.save(
      { name: 'Rules', kind: 'rule-text', behavior: 'classical', selector: '' },
      Buffer.from('DOMAIN,fixture.invalid\nGEOIP,RELAY,no-resolve\n')
    ),
    site = await resources.save(
      { name: 'Site', kind: 'geosite-dat', behavior: null, selector: 'RELAY' },
      geositeFixture()
    ),
    ip = await resources.save(
      { name: 'IP', kind: 'geoip-dat', behavior: null, selector: 'RELAY' },
      geoipFixture()
    )
  const initialBindings = missing.dependencies
    .filter((item) => item.kind === 'rule-text' || item.kind === 'geosite-dat')
    .map((item) => ({
      dependencyId: item.id,
      selection: selection(item.kind === 'rule-text' ? rules : site)
    }))
  const extra = await service.prepare({ ...common, bindings: initialBindings })
  const geographic = extra.dependencies.find((item) => item.kind === 'geoip-dat' && !item.resolved)
  check(
    'classical cache introduces additional database dependency before full parser execution',
    !!geographic && !extra.readyForParserCheck
  )
  if (!geographic) throw new Error('Geographic dependency missing')
  const ready = await service.prepare({
    ...common,
    bindings: [...initialBindings, { dependencyId: geographic.id, selection: selection(ip) }]
  })
  check(
    'all selected resource snapshots make a complete candidate, preserving original source bytes',
    ready.readyForParserCheck &&
      ready.resources === 3 &&
      (await profiles.read(selection(stored))).text === JSON.stringify(input)
  )
  const beforeCalls = scriptCalls,
    result = await service.check({ evidenceId: ready.evidenceId })
  check(
    'fixed ARM core parses complete settings, subrules, local listeners, rule file and geographic databases',
    result.status === 'passed',
    result.status
  )
  check(
    'checking uses exactly the prepared JS bytes without rerunning the script',
    scriptCalls === beforeCalls && result.configurationSHA256 === ready.configurationSHA256
  )
  check(
    'complete parser acceptance is explicitly separate from running, initialized resources and traffic',
    result.scope === 'complete-parser' &&
      result.active === false &&
      result.runtimeAccepted === false
  )
  check(
    'parser test makes no health or origin requests through either fixture node',
    Object.values(network.stats()).every((value) => value === 0)
  )
  let replay = false
  try {
    await service.check({ evidenceId: ready.evidenceId })
  } catch {
    replay = true
  }
  check('complete preparation evidence is single-use', replay)
  await exec(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(home, 'key.pem'),
      '-out',
      join(home, 'cert.pem'),
      '-subj',
      '/CN=fixture.invalid'
    ],
    { cwd: home, timeout: 10000, maxBuffer: 65536 }
  )
  const certificate = await resources.save(
      { name: 'Certificate', kind: 'runtime-file', behavior: null, selector: '' },
      await readFile(join(home, 'cert.pem'))
    ),
    key = await resources.save(
      { name: 'Key', kind: 'runtime-file', behavior: null, selector: '' },
      await readFile(join(home, 'key.pem'))
    )
  const tlsSource = JSON.stringify({
    tls: { certificate: '/PRIVATE/original-cert', 'private-key': '/PRIVATE/original-key' },
    listeners: [{ name: 'TLS', type: 'http', listen: '127.0.0.1', port: String(spare) }],
    rules: ['MATCH,REJECT']
  })
  const tls = collectRuntimeDependencies(tlsSource)
  const bound = await bindRuntimeResources(
    tlsSource,
    tls.dependencies.map((item) => ({
      dependencyId: item.id,
      selection: selection(item.target.at(-1) === 'certificate' ? certificate : key)
    })),
    { providers, resources }
  )
  check(
    'external certificate/key references become digest-addressed private runtime files',
    bound.unresolved.length === 0 &&
      bound.assets.length === 2 &&
      !JSON.stringify(bound.configuration).includes('/PRIVATE/')
  )
  const tlsCheck = await checkCompleteConfiguration(
    coreRoot,
    JSON.stringify(bound.configuration),
    bound.assets
  )
  check(
    'fixed core parses actual bound TLS PEM files without importing trust or starting a listener',
    tlsCheck.status === 'passed',
    tlsCheck.status
  )
  const invalid = await bindRuntimeResources('mode: not-a-core-mode', [], { providers, resources })
  check(
    'complete worker rejects a core enum that structural generation preserves',
    (await checkCompleteConfiguration(coreRoot, JSON.stringify(invalid.configuration), []))
      .status === 'rejected'
  )
  let refused = false
  try {
    validateBoundConfiguration(JSON.stringify(bound.configuration), [])
  } catch {
    refused = true
  }
  check('worker refuses an external file reference when its immutable asset is missing', refused)
  const composed = await composeRuntimeConfiguration({
    profileId: stored.id,
    source: JSON.stringify(input),
    globalOverrides: [
      { id: 'normal', kind: 'yaml', content: 'mode: global' },
      { id: 'smart-core-override', kind: 'yaml', content: 'mode: direct' }
    ],
    profileOverrides: [],
    rulePatch: { prepend: ['DOMAIN,first.invalid,REJECT'] },
    controlled: { mode: 'rule' }
  })
  check(
    'fixed-order generator retains all meaningful DNS, hosts, listeners and subrules while controlled settings win',
    composed.configuration.mode === 'rule' &&
      JSON.stringify(composed.configuration.dns) === JSON.stringify(input.dns) &&
      JSON.stringify(composed.configuration.hosts) === JSON.stringify(input.hosts) &&
      JSON.stringify(composed.configuration.listeners) === JSON.stringify(input.listeners) &&
      JSON.stringify(composed.configuration['sub-rules']) === JSON.stringify(input['sub-rules'])
  )
  check(
    'existing fake-HOME developer settings remain byte-for-byte unchanged',
    (await readFile(sentinel, 'utf8')) === '{"PRIVATE":"unchanged"}'
  )
  const cache = await providers.save('Provider cache', JSON.stringify({ proxies: input.proxies }))
  const providerSource = JSON.stringify({
    'proxy-providers': {
      P: {
        type: 'http',
        url: 'https://PRIVATE.invalid/provider',
        override: { 'additional-prefix': 'Renamed-', 'override-expr': ['.udp = true'] },
        filter: 'Node'
      }
    },
    'proxy-groups': [{ name: 'Group', type: 'select', use: ['P'] }],
    rules: ['MATCH,Group']
  })
  const providerDependency = collectRuntimeDependencies(providerSource).dependencies[0]
  const transformed = await bindRuntimeResources(
    providerSource,
    [{ dependencyId: providerDependency.id, selection: selection(cache) }],
    { providers, resources }
  )
  const providerCheck = await checkCompleteConfiguration(
    coreRoot,
    JSON.stringify(transformed.configuration),
    transformed.assets
  )
  check(
    'fixed core accepts retained provider filtering, renaming and expressions without JS regex emulation',
    providerCheck.status === 'passed',
    providerCheck.status
  )
} finally {
  await service.requestClose()
  await network.close()
  await rm(home, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((item) => item.passed).length,
  rows,
  architectureExecuted: process.arch,
  intelRuntimeVerified: false,
  completeParserOnly: true,
  actualRuntimeOrTrafficAcceptanceClaimed: false,
  actualUserNetworkOrSystemConfigurationChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  actualAppGuiVerified: false
}
await writeFile(
  '../evidence/complete-configuration-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Complete configuration contract failed.')
