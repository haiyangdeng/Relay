import assert from 'node:assert/strict'
import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  defaultEditDocument,
  profileOverridesFor,
  snifferSettings
} from '../../src/shared/relay/configuration-edit'
import { overrideLibraryRuntimeId } from '../../src/shared/relay/override-library'
import { ProfileStore } from '../../src/main/relay/profiles/store'
import { profileHash } from '../../src/main/relay/profiles/source'
import { compileProfileRuntime } from '../../src/main/relay/profiles/runtime'
import { ConfigurationEditStore } from '../../src/main/relay/configuration/edit-store'
import { createConfigurationEditService } from '../../src/main/relay/configuration/edit-service'
import { OverrideLibraryStore } from '../../src/main/relay/configuration/override-library-store'
import { createOverrideLibraryService } from '../../src/main/relay/configuration/override-library-service'
import { runConfigurationScript } from '../../src/main/relay/configuration/script'
import { coreEnvironment } from '../../src/main/relay/core/configuration'
import { verifyCoreResource } from '../../src/main/relay/core/resources'
import { resourceHash } from '../../src/main/relay/resources/source'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64', 'This fixture uses the frozen ARM candidate Native path')
const exec = promisify(execFile),
  abort = new AbortController(),
  held = new Set<ChildProcess>(),
  root = await realpath(await mkdtemp('/private/tmp/relay-override-runtime-')),
  identity = await lstat(root),
  context = { home: root, stateRoot: join(root, 'Library/Application Support/Relay') },
  native = resolve(
    '../artifacts/backup-runtime-gist-discovery-candidate-20261101/mac-arm64/Relay.app/Contents/Resources/relay/RelayNative'
  ),
  nativeSHA256 = resourceHash(await readFile(native)),
  coreRoot = resolve('extra/relay/core'),
  core = await verifyCoreResource(coreRoot),
  policy = '(version 1) (allow default) (deny network*)',
  library = new OverrideLibraryStore(context),
  edits = new ConfigurationEditStore(context),
  profiles = new ProfileStore(context),
  rows: { name: string; detail?: unknown }[] = [],
  workers: { sourceSHA256: string; logs: string[] }[] = [],
  parsers: {
    name: string
    runtimeSourceSHA256: string
    configurationSHA256: string
    output: string
  }[] = []
let workerAttempts = 0,
  workerFailures = 0
const interrupt = (): void => abort.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
async function ownExec(
  executable: string,
  args: string[],
  options: Omit<ExecFileOptions, 'encoding'> = {}
) {
  const task = exec(executable, args, { ...options, encoding: 'utf8', signal: abort.signal }),
    child = task.child
  held.add(child)
  const closed = new Promise<void>((done) => child.once('close', () => done()))
  try {
    return await task
  } finally {
    await closed
    held.delete(child)
  }
}
assert.equal(nativeSHA256, '6e4c5f1f07e0153c6a95e53764ddc60be827eb9a2219928c8d5b48e1d0911449')
await ownExec('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', native], {
  timeout: 10000
})
const editor = createConfigurationEditService({
    store: edits,
    profiles,
    assertLibraryBindings: (refs) => library.assertBindings(refs),
    script: async (script, configuration) => {
      ++workerAttempts
      try {
        const result = await runConfigurationScript(native, script, configuration, abort.signal)
        workers.push({ sourceSHA256: profileHash(script), logs: result.logs })
        return result
      } catch (error) {
        ++workerFailures
        throw error
      }
    }
  }),
  service = createOverrideLibraryService({
    store: library,
    editor,
    profiles,
    assertIdle: () => {},
    confirmFetch: async () => false,
    request: async () => {
      throw new Error('No fetch request is authorized in this fixture')
    }
  })
const base = JSON.stringify({
    proxies: [],
    'proxy-groups': [],
    rules: ['MATCH,REJECT'],
    sniffer: {
      enable: false,
      'force-dns-mapping': false,
      'parse-pure-ip': false,
      'override-destination': false
    }
  }),
  oldYAML = 'sniffer:\n  force-dns-mapping: true\n',
  newYAML = 'sniffer:\n  force-dns-mapping: false\n',
  js = (latest: boolean): string =>
    `function main(c){if([typeof process,typeof require,typeof fetch,typeof XMLHttpRequest,typeof WebSocket].some(x=>x!=="undefined"))throw Error("host bridge");c.sniffer["parse-pure-ip"]=${latest ? 'false' : 'true'};c.rules.unshift("DOMAIN,${latest ? 'new' : 'old'}-script.invalid,REJECT");console.log("fixture-jsc-${latest ? 'new' : 'old'}");return c;}`
const selection = (p: { id: string; sha256: string }) => ({ id: p.id, sha256: p.sha256 })
async function parser(name: string, source: string): Promise<void> {
  const compiled = compileProfileRuntime(source)
  assert.ok(compiled.configuration)
  const config: Record<string, unknown> = JSON.parse(compiled.configuration),
    input: Record<string, unknown> = JSON.parse(source)
  config.sniffer = snifferSettings(input.sniffer)
  for (const key of ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port'])
    assert.equal(config[key], 0)
  for (const key of ['dns', 'tun', 'ntp'])
    assert.equal((config[key] as Record<string, unknown>).enable, false)
  for (const key of ['proxies', 'proxy-groups', 'listeners']) assert.deepEqual(config[key], [])
  for (const key of ['proxy-providers', 'rule-providers']) assert.deepEqual(config[key], {})
  for (const key of ['external-controller', 'external-controller-tls'])
    assert.equal(config[key], '')
  assert.equal(config['geo-auto-update'], false)
  assert.ok((config.rules as string[]).every((rule) => rule.endsWith(',REJECT')))
  const directory = join(root, `parser-${parsers.length}`),
    path = join(directory, 'config.json'),
    text = JSON.stringify(config)
  await mkdir(directory, { mode: 0o700 })
  await writeFile(path, text, { flag: 'wx', mode: 0o600 })
  assert.equal((await verifyCoreResource(coreRoot)).sha256, core.sha256)
  // Reuses the existing checker's fixed -t contract and deny-network SBPL.
  // execFile owns this child, bounds its output/deadline and waits for close.
  const result = await ownExec(
    '/usr/bin/sandbox-exec',
    ['-p', policy, core.executable, '-t', '-d', directory, '-f', path],
    {
      cwd: directory,
      env: coreEnvironment({ ...process.env, HOME: directory, TMPDIR: directory }),
      timeout: 10000,
      killSignal: 'SIGKILL',
      maxBuffer: 65536
    }
  )
  assert.match(result.stdout + result.stderr, /test is successful/u)
  assert.equal(resourceHash(await readFile(path)), profileHash(text))
  parsers.push({
    name,
    runtimeSourceSHA256: profileHash(source),
    configurationSHA256: profileHash(text),
    output: result.stdout + result.stderr
  })
}
let failure: string | undefined
try {
  await ownExec('/usr/bin/sandbox-exec', ['-p', policy, '/usr/bin/true'], { timeout: 3000 })
  const saved = await profiles.save('Synthetic library runtime', base),
    target = selection(saved),
    targetRead = await profiles.read(target),
    fullTarget = { ...target, revision: targetRead.revision }
  await editor.saveChecked({
    expectedRevision: '',
    document: {
      ...defaultEditDocument(),
      controlSniff: true,
      globalOverrides: [
        { id: 'ordinary-global', kind: 'yaml', content: 'sniffer:\n  enable: false\n' }
      ],
      profileOverrideSets: [
        {
          profileId: target.id,
          overrides: [
            {
              id: 'ordinary-profile',
              kind: 'yaml',
              content: 'sniffer:\n  enable: true\n  override-destination: true\n'
            }
          ]
        }
      ],
      controlled: { sniffer: { 'override-destination': false } },
      rulePatch: { prepend: ['DOMAIN,global-rule.invalid,REJECT'] },
      profileRulePatchSets: [
        { profileId: target.id, rulePatch: { append: ['DOMAIN,profile-rule.invalid,REJECT'] } }
      ]
    }
  })
  const yaml = await service.create({
      expectedLibraryRevision: '',
      name: 'YAML fixture',
      kind: 'yaml',
      type: 'local',
      content: oldYAML
    }),
    script = await service.create({
      expectedLibraryRevision: yaml.revision,
      name: 'JS fixture',
      kind: 'js',
      type: 'local',
      content: js(false)
    })
  let bindings = await service.bind({
    expectedEditRevision: (await editor.read()).revision,
    target: fullTarget,
    refs: [{ id: yaml.item.id, bodyRevision: yaml.item.bodyRevision }]
  })
  bindings = await service.bind({
    expectedEditRevision: bindings.editRevision,
    refs: [
      { id: yaml.item.id, bodyRevision: yaml.item.bodyRevision },
      { id: script.item.id, bodyRevision: script.item.bodyRevision }
    ]
  })
  const originalScope = profileOverridesFor((await editor.read()).document, target.id),
    first = await editor.readRuntimeProfile(target)
  assert.equal(JSON.parse(first.text).sniffer['force-dns-mapping'], true)
  assert.equal(JSON.parse(first.text).sniffer['parse-pure-ip'], true)
  assert.ok(workers.some((worker) => worker.logs.includes('fixture-jsc-old')))
  await parser('old-library-snapshots', first.text)
  rows.push({ name: 'real signed JSC and fixed Core parser consume stored YAML/JS snapshots' })

  const editedBefore = await editor.read(),
    workerCount = workers.length,
    yamlHead = await service.saveBody({
      id: yaml.item.id,
      expectedLibraryRevision: script.revision,
      expectedBodyRevision: yaml.item.bodyRevision,
      content: newYAML
    }),
    jsHead = await service.saveBody({
      id: script.item.id,
      expectedLibraryRevision: yamlHead.revision,
      expectedBodyRevision: script.item.bodyRevision,
      content: js(true)
    })
  assert.deepEqual(await editor.read(), editedBefore)
  assert.deepEqual(await editor.readRuntimeProfile(target), first)
  assert.equal(workers.length, workerCount)
  rows.push({
    name: 'head updates preserve inline edit revision and already cached JS/runtime bytes',
    detail: { workerCallsUnchanged: workerCount }
  })

  bindings = await service.refresh({
    expectedEditRevision: bindings.editRevision,
    refs: [
      {
        id: yaml.item.id,
        expectedOldBodyRevision: yaml.item.bodyRevision,
        bodyRevision: yamlHead.item.bodyRevision
      },
      {
        id: script.item.id,
        expectedOldBodyRevision: script.item.bodyRevision,
        bodyRevision: jsHead.item.bodyRevision
      }
    ]
  })
  const global = await editor.readRuntimeProfile(target),
    data = JSON.parse(global.text)
  assert.equal(data.sniffer['force-dns-mapping'], false)
  assert.equal(data.sniffer['parse-pure-ip'], false)
  assert.equal(data.sniffer.enable, true)
  assert.equal(data.sniffer['override-destination'], false)
  assert.deepEqual(data.rules, [
    'DOMAIN,global-rule.invalid,REJECT',
    'DOMAIN,new-script.invalid,REJECT',
    'MATCH,REJECT',
    'DOMAIN,profile-rule.invalid,REJECT'
  ])
  assert.deepEqual(profileOverridesFor((await editor.read()).document, target.id), originalScope)
  await parser('explicit-global-refresh', global.text)
  rows.push({
    name: 'explicit refresh alone advances global bodies; new namespace global shadows old profile without modifying its snapshot; ordinary profile/rules/controlled order survives'
  })

  bindings = await service.bind({
    expectedEditRevision: bindings.editRevision,
    refs: [{ id: script.item.id, bodyRevision: jsHead.item.bodyRevision }]
  })
  const profileOld = await editor.readRuntimeProfile(target)
  assert.equal(JSON.parse(profileOld.text).sniffer['force-dns-mapping'], true)
  await parser('global-disabled-profile-old-snapshot', profileOld.text)
  rows.push({
    name: 'removing only the global library reference reveals the original profile snapshot, not library head'
  })

  bindings = await service.refresh({
    expectedEditRevision: bindings.editRevision,
    target: fullTarget,
    refs: [
      {
        id: yaml.item.id,
        expectedOldBodyRevision: yaml.item.bodyRevision,
        bodyRevision: yamlHead.item.bodyRevision
      }
    ]
  })
  const profileNew = await editor.readRuntimeProfile(target)
  assert.equal(JSON.parse(profileNew.text).sniffer['force-dns-mapping'], false)
  await parser('explicit-profile-refresh', profileNew.text)
  bindings = await service.order({
    expectedEditRevision: bindings.editRevision,
    ids: [script.item.id, yaml.item.id]
  })
  assert.equal(bindings.globalRefs[0].bodyRevision, jsHead.item.bodyRevision)
  assert.equal((await service.list()).items[0].id, script.item.id)
  rows.push({
    name: 'profile explicit refresh and separate card order use edit CAS without silent body upgrades'
  })

  const bad = await service.saveBody({
    id: script.item.id,
    expectedLibraryRevision: jsHead.revision,
    expectedBodyRevision: jsHead.item.bodyRevision,
    content: 'function main(){throw Error("synthetic failure")}'
  })
  bindings = await service.refresh({
    expectedEditRevision: bindings.editRevision,
    refs: [
      {
        id: script.item.id,
        expectedOldBodyRevision: jsHead.item.bodyRevision,
        bodyRevision: bad.item.bodyRevision
      }
    ]
  })
  const parserCount = parsers.length
  await assert.rejects(editor.readRuntimeProfile(target), /脚本未完成/u)
  assert.equal(workerFailures, 1)
  assert.equal(parsers.length, parserCount)
  rows.push({
    name: 'actual JSC failure publishes no usable runtime candidate and never reaches Core parser'
  })
  await library.remove({
    id: script.item.id,
    expectedLibraryRevision: bad.revision,
    expectedMetadataRevision: bad.item.metadataRevision,
    expectedBodyRevision: bad.item.bodyRevision
  })
  const beforeMissing = workers.length
  await assert.rejects(editor.readRuntimeProfile(target), /引用缺失/u)
  assert.equal(workers.length, beforeMissing)
  assert.equal(parsers.length, parserCount)
  rows.push({
    name: 'synthetic missing metadata fails closed before worker or parser, without running arbitrary source'
  })
  assert.equal((await profiles.read(target)).text, base)
  assert.ok(
    (await editor.read()).document.globalOverrides.some(
      (item) => item.id === overrideLibraryRuntimeId(script.item.id)
    )
  )
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
}
service.invalidate()
await service.whenIdle()
process.removeListener('SIGINT', interrupt)
process.removeListener('SIGTERM', interrupt)
assert.equal(held.size, 0)
const current = await lstat(root)
assert.ok(
  current.isDirectory() &&
    !current.isSymbolicLink() &&
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    current.uid === process.getuid?.() &&
    (current.mode & 0o7777) === 0o700 &&
    (await realpath(root)) === root
)
const proof = {
  verifiedAt: new Date().toISOString(),
  scope: 'synthetic-library-to-real-JSC-to-deny-network-Core-parser',
  passed: !failure && rows.length === 7 && parsers.length === 4,
  failure,
  native: {
    path: native,
    sha256: nativeSHA256,
    command: '--runtime-script',
    signatureVerified: true
  },
  core: { version: core.version, sha256: core.sha256, arguments: '-t only', sandbox: policy },
  parserScope:
    'isolated compiler projection plus validated sniffer; not full-source active runtime acceptance',
  architecture: process.arch,
  runnerSHA256: resourceHash(await readFile(new URL(import.meta.url))),
  sourceSHA256: Object.fromEntries(
    await Promise.all(
      [
        'src/main/relay/configuration/override-library-service.ts',
        'src/main/relay/configuration/edit-service.ts',
        'src/main/relay/configuration/edit-store.ts',
        'src/shared/relay/configuration-edit.ts',
        'src/shared/relay/override-library.ts',
        'src/main/relay/configuration/override-library-store.ts',
        'src/main/relay/configuration/script.ts',
        'src/main/relay/core/profile-check.ts'
      ].map(async (path) => [path, resourceHash(await readFile(path))])
    )
  ),
  rows,
  workers,
  workerAttempts,
  workerFailures,
  parsers,
  privateFixtureDirectory: root,
  privateFixtureRetained: true,
  actualNetworkRequests: 0,
  normalCoreStarted: false,
  listenerOrPortAllocated: false,
  tunOrSystemChanged: false,
  ownedCLIsSettled: true,
  limits: [
    'Offline parser and actual restricted JavaScriptCore execution only, no traffic/TUN/Intel/App acceptance',
    'Core children have OS deny-network sandbox; JSC worker exposes no file/Node/browser/network bridge, not a general native-memory sandbox claim',
    'All scripts and data are fixed synthetic fixtures, private home retained; no user roots or current App/Core touched',
    'Library/producer functionality still requires separate independent review and final Main/UI/backup integration'
  ]
}
await writeFile(
  '../evidence/override-library-runtime-r2-verification-20261101.json',
  JSON.stringify(proof, null, 2) + '\n',
  { mode: 0o600 }
)
process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
if (!proof.passed) throw new Error(failure ?? 'Incomplete runtime observations')
