// Private ordinary-UID integration only. Uses no installed/stock Core or TUN.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  rename,
  unlink
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  executable = process.argv[2]
assert(process.getuid() > 0 && executable.startsWith('/private/tmp/relay-geodata-integration-'))
const hash = (b) => createHash('sha256').update(b).digest('hex'),
  binarySHA256 = hash(await readFile(executable))
assert.equal(
  binarySHA256,
  JSON.parse(await readFile(join(dirname(executable), 'build-result.json'), 'utf8')).binarySHA256
)
const { geositeFixture, geoipFixture } = await import(
  pathToFileURL(join(app, 'scripts/relay/fixtures/rule-resources.ts')).href
)
const { resourceCheckDefinition } = await import(
  pathToFileURL(join(app, 'src/main/relay/resources/check-definition.ts')).href
)
const { stopOwnedChild } = await import(
  pathToFileURL(join(app, 'src/main/relay/core/shutdown.ts')).href
)
const { ownsHttpListener } = await import(
  pathToFileURL(join(app, 'src/main/relay/core/port.ts')).href
)
const root = await mkdtemp('/private/tmp/relay-geo-local-proto-integrated-'),
  results = []
const checkedFixture = async (name) => {
  const b = await readFile(join(app, 'scripts/relay/fixtures/assets', name)),
    m = JSON.parse(
      await readFile(join(app, 'scripts/relay/fixtures/assets/manifest.json'), 'utf8')
    ),
    pin = m.files.find((x) => x.path.endsWith('/' + name))
  assert(pin)
  assert.equal(hash(b), pin.sha256)
  return b
}
const replaceOne = (bytes, from, to) => {
  assert.equal(from.length, to.length)
  const i = bytes.indexOf(from)
  assert(i >= 0 && bytes.indexOf(from, i + 1) === -1)
  const b = Buffer.from(bytes)
  to.copy(b, i)
  return b
}
const country = await checkedFixture('GeoIP2-Country-Test.mmdb'),
  asn = await checkedFixture('GeoLite2-ASN-Test.mmdb')
const ip = geoipFixture(),
  nextIP = Buffer.from(ip)
let count = 0
for (let i = 0; i < nextIP.length - 3; i++)
  if (nextIP.subarray(i, i + 4).equals(Buffer.from([127, 0, 0, 0]))) {
    nextIP[i] = 192
    count++
  }
assert.equal(count, 2)
const oldSite = geositeFixture(),
  newSite = Buffer.from(
    oldSite.toString('latin1').split('fixture.invalid').join('changed.invalid'),
    'latin1'
  )
assert.equal(oldSite.length, newSite.length)
let cases = [
  {
    kind: 'geoip-dat',
    selector: 'RELAY',
    old: ip,
    next: nextIP,
    positive: '127.0.0.2',
    negative: '192.0.2.1',
    rule: 'GeoIP(relay)',
    after: 'Match',
    afterNegative: 'GeoIP(relay)'
  },
  {
    kind: 'geosite-dat',
    selector: 'RELAY',
    old: oldSite,
    next: newSite,
    positive: 'fixture.invalid',
    negative: 'changed.invalid',
    rule: 'GeoSite(RELAY)',
    after: 'Match',
    afterNegative: 'GeoSite(RELAY)'
  },
  {
    kind: 'country-mmdb',
    selector: 'GB',
    old: country,
    next: replaceOne(country, Buffer.from([0x42, 71, 66]), Buffer.from([0x42, 90, 90])),
    positive: '81.2.69.142',
    negative: '75.209.24.0',
    rule: 'GeoIP(gb)',
    after: 'Match',
    afterNegative: 'Match'
  },
  {
    kind: 'asn-mmdb',
    selector: '15169',
    old: asn,
    next: replaceOne(asn, Buffer.from([0xc2, 0x3b, 0x41]), Buffer.from([0xc2, 0x3b, 0x42])),
    positive: '1.0.0.1',
    negative: '1.128.0.1',
    rule: 'IPASN(15169)',
    after: 'Match',
    afterNegative: 'Match'
  }
]
const loader = process.argv.includes('--memconservative') ? 'memconservative' : 'standard'
if (loader === 'memconservative') cases = cases.filter((item) => item.kind.endsWith('-dat'))
if (process.argv.includes('--large')) {
  const padded = Buffer.alloc(128 * 1024 * 1024)
  replaceOne(country, Buffer.from([0x42, 71, 66]), Buffer.from([0x42, 90, 90])).copy(padded)
  cases.push({
    kind: 'country-mmdb',
    selector: 'GB',
    old: country,
    next: padded,
    positive: '81.2.69.142',
    negative: '75.209.24.0',
    rule: 'GeoIP(gb)',
    after: 'Match',
    afterNegative: 'Match',
    budgetBoundary: true
  })
}
const runChild = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (b) => (stdout += b))
    child.stderr.on('data', (b) => (stderr += b))
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
try {
  for (const item of cases) {
    const fixtureRoot = await mkdtemp('/private/tmp/relay-geo-local-proto-case-')
    const calibration = await runChild(process.execPath, [
      '--import',
      join(app, 'node_modules/tsx/dist/loader.mjs'),
      join(app, 'core-extensions/mihomo-geodata-v1/tests/calibrate-sandbox.mjs'),
      fixtureRoot,
      app
    ])
    assert.equal(calibration.code, 0, calibration.stderr)
    const proof = JSON.parse(await readFile(join(fixtureRoot, 'sandbox-calibration.json'), 'utf8'))
    assert.equal(proof.status, 'passed')
    assert.equal(proof.acceptedBySentinel, 0)
    const home = join(fixtureRoot, 'run'),
      socketPath = join(home, 'api.sock'),
      port = proof.allowedPort,
      policy = await readFile(join(fixtureRoot, 'prototype-sandbox.sb'), 'utf8')
    assert.equal(policy, proof.policy)
    const definition = resourceCheckDefinition({
        name: 'Private four-kind local refresh',
        kind: item.kind,
        behavior: null,
        selector: item.selector
      }),
      config = Buffer.from(
        JSON.stringify({
          ...definition.configuration,
          port,
          'geodata-loader': loader,
          'log-level': 'debug'
        })
      )
    await writeFile(join(home, definition.filename), item.old, { flag: 'wx', mode: 0o600 })
    await writeFile(join(home, 'config.json'), config, { flag: 'wx', mode: 0o600 })
    const blobId = randomUUID(),
      inbox = join(home, 'RelayGeoInbox'),
      stage = join(inbox, blobId)
    await mkdir(inbox, { mode: 0o700 })
    await mkdir(stage, { mode: 0o700 })
    await writeFile(join(stage, definition.filename), item.next, { flag: 'wx', mode: 0o600 })
    const report = {
      kind: item.kind,
      loader,
      root: fixtureRoot,
      policy,
      oldSHA256: hash(item.old),
      newSHA256: hash(item.next),
      observations: [],
      status: 'pending'
    }
    results.push(report)
    let child,
      closed,
      timer,
      ended = false,
      exitCode,
      output = '',
      failure,
      timedOut = false,
      primaryError
    const configIdentity = await lstat(join(home, 'config.json'))
    const getConfigs = () =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ socketPath, path: '/configs', method: 'GET' }, (response) => {
          let size = 0
          const chunks = []
          response.on('data', (b) => {
            size += b.length
            if (size > 65536) req.destroy(new Error('config observation budget'))
            else chunks.push(b)
          })
          response.once('error', reject)
          response.once('end', () => {
            try {
              assert.equal(response.statusCode, 200)
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (error) {
              reject(error)
            }
          })
        })
        req.setTimeout(4000, () => req.destroy(new Error('config observation timeout')))
        req.once('error', reject)
        req.end()
      })
    const control = (value, raw) =>
      new Promise((resolve, reject) => {
        const body = raw ?? Buffer.from(JSON.stringify(value)),
          req = httpRequest(
            {
              socketPath,
              path: '/relay/geodata/v1',
              method: 'POST',
              headers: { 'content-type': 'application/json', 'content-length': body.length }
            },
            (response) => {
              let n = 0
              const chunks = []
              response.on('data', (b) => {
                n += b.length
                if (n > 65536) req.destroy(new Error('control response budget'))
                else chunks.push(b)
              })
              response.once('error', reject)
              response.once('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                let body
                try {
                  body = JSON.parse(text)
                } catch {
                  body = text
                }
                resolve({ code: response.statusCode, body })
              })
            }
          )
        req.setTimeout(4000, () => req.destroy(new Error('owned Unix control timeout')))
        req.once('error', reject)
        req.end(body)
      })
    const live = () => {
      if (failure) throw failure
      assert(!ended && !timedOut)
    }
    const decision = async (domain, marker, rule) => {
      await new Promise((resolve, reject) => {
        const s = createConnection({ host: '127.0.0.1', port })
        s.setTimeout(2000, () => s.destroy(new Error('own reject inbound timeout')))
        s.once('connect', () =>
          s.write(`CONNECT ${domain}:${marker} HTTP/1.1\r\nHost: ${domain}:${marker}\r\n\r\n`)
        )
        s.resume()
        s.once('error', reject)
        s.once('close', resolve)
      })
      const until = performance.now() + 1500
      let line
      while (
        !(line = output
          .split('\n')
          .find((l) => l.includes(`${domain}:${marker}`) && l.includes(`match ${rule}`)))
      ) {
        live()
        assert(performance.now() < until, 'missing actual Rule.Match log ' + domain + '/' + rule)
        await delay(5)
      }
      report.observations.push({ domain, marker, expectedRule: rule, line })
    }
    try {
      child = spawn(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          policy,
          executable,
          '-d',
          home,
          '-f',
          join(home, 'config.json'),
          '-ext-ctl-unix',
          socketPath
        ],
        {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            TMPDIR: home,
            LANG: 'C',
            LC_ALL: 'C',
            RELAY_LOCAL_GEODATA_V1: '1'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      report.pid = child.pid
      closed = new Promise((resolve) =>
        child.once('close', (code) => {
          ended = true
          exitCode = code
          resolve()
        })
      )
      child.once('error', (e) => (failure = e))
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (b) => {
          output += b
          if (Buffer.byteLength(output) > 1048576) {
            failure = new Error('owned Core output budget')
            child.kill('SIGTERM')
          }
        })
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, 45000)
      const until = performance.now() + 5000
      while (true) {
        live()
        try {
          if (
            (await lstat(socketPath)).isSocket() &&
            output.includes(`HTTP proxy listening at: 127.0.0.1:${port}`)
          )
            break
        } catch {
          /* The owned listener is not bound yet. */
        }
        assert(performance.now() < until, 'owned Core readiness timeout')
        await delay(10)
      }
      assert.equal(await ownsHttpListener(child.pid, port), true)
      const beforeConfigs = await getConfigs()
      const initial = await control({ version: 1, action: 'state' })
      assert.equal(initial.code, 200)
      assert.equal(initial.body.capability, 'local-geodata-v1')
      assert.equal(initial.body.sequence, 0)
      assert.equal(initial.body.resources.length, 1)
      assert.equal(initial.body.resources[0].sha256, hash(item.old))
      report.initial = initial.body
      await decision(item.positive, 18101, item.rule)
      await decision(item.negative, 18102, 'Match')
      assert.equal(
        (await control(null, Buffer.from('{"version":1,"action":"state","act\\u0069on":"state"}')))
          .code,
        400
      )
      const selection = {
        version: 1,
        action: 'prepare',
        kind: item.kind,
        selector: item.selector,
        oldSHA256: hash(item.old),
        newSHA256: hash(item.next),
        expectedGenerationSHA256: initial.body.generationSHA256,
        blobId
      }
      assert.equal((await control({ ...selection, oldSHA256: 'f'.repeat(64) })).code, 409)
      const prepareStarted = performance.now()
      let prepared = await control(selection)
      report.prepareMS = performance.now() - prepareStarted
      report.remainingMS = prepared.body.remainingMS
      assert.equal(prepared.code, 200, JSON.stringify(prepared))
      assert.equal(prepared.body.status, 'prepared')
      assert.equal(hash(await readFile(join(home, definition.filename))), hash(item.old))
      assert.equal(
        (await readdir(home)).filter((x) => x.startsWith('RelayGeo.retained-')).length,
        0
      )
      assert.equal(
        (await control({ version: 1, action: 'cancel', nonce: prepared.body.nonce })).body.status,
        'cancelled'
      )
      assert.equal(
        (await control({ version: 1, action: 'commit', nonce: prepared.body.nonce })).code,
        409
      )
      prepared = await control(selection)
      assert.equal(prepared.code, 200)
      await rename(join(stage, definition.filename), join(stage, 'saved'))
      await writeFile(join(stage, definition.filename), item.old, { flag: 'wx', mode: 0o600 })
      assert.equal(
        (await control({ version: 1, action: 'commit', nonce: prepared.body.nonce })).code,
        409
      )
      assert.equal(hash(await readFile(join(stage, definition.filename))), hash(item.old))
      await unlink(join(stage, definition.filename))
      await rename(join(stage, 'saved'), join(stage, definition.filename))
      prepared = await control(selection)
      assert.equal(prepared.code, 200)
      const commitStarted = performance.now()
      const applied = await control({ version: 1, action: 'commit', nonce: prepared.body.nonce })
      report.commitMS = performance.now() - commitStarted
      assert.equal(applied.code, 200, JSON.stringify(applied))
      assert.equal(applied.body.status, 'applied')
      assert.equal(applied.body.sequence, 1)
      assert.equal(applied.body.previousGenerationSHA256, initial.body.generationSHA256)
      assert.equal(applied.body.newSHA256, hash(item.next))
      assert.equal(applied.body.retainedOriginal, true)
      assert.equal(hash(await readFile(join(home, definition.filename))), hash(item.next))
      const retained = (await readdir(home)).filter((x) => x.startsWith('RelayGeo.retained-'))
      assert.equal(retained.length, 1)
      assert.equal(hash(await readFile(join(home, retained[0]))), hash(item.old))
      assert.equal(
        (await control({ version: 1, action: 'commit', nonce: prepared.body.nonce })).code,
        409
      )
      await decision(item.positive, 18103, item.after)
      await decision(item.negative, 18104, item.afterNegative)
      const final = await control({ version: 1, action: 'state' })
      assert.equal(final.body.bootId, initial.body.bootId)
      assert.equal(final.body.generationSHA256, applied.body.generationSHA256)
      assert.equal(final.body.resources[0].sha256, hash(item.next))
      assert.equal(hash(await readFile(join(home, 'config.json'))), hash(config))
      const afterConfigIdentity = await lstat(join(home, 'config.json'))
      assert.equal(afterConfigIdentity.dev, configIdentity.dev)
      assert.equal(afterConfigIdentity.ino, configIdentity.ino)
      assert.deepEqual(await getConfigs(), beforeConfigs)
      live()
      report.final = final.body
      report.applied = applied.body
      report.sameHeldPID = true
      report.configurationUnchanged = true
      report.status = 'passed'
    } catch (error) {
      report.status = 'failed'
      report.error = String(error)
      report.errorStack = error instanceof Error ? error.stack : undefined
      primaryError = error
    } finally {
      clearTimeout(timer)
      const cleanupErrors = []
      try {
        if (child) {
          if (!ended) await stopOwnedChild(child, closed, 'inert')
          else await closed
          assert(ended)
          assert.equal(exitCode, 0)
        }
      } catch (e) {
        cleanupErrors.push(String(e))
      }
      const probe = createServer((s) => s.destroy())
      try {
        await new Promise((resolve, reject) => {
          probe.once('error', reject)
          probe.listen(port, '127.0.0.1', resolve)
        })
        report.portReleased = true
      } catch (e) {
        cleanupErrors.push(String(e))
      } finally {
        await new Promise((resolve) => probe.close(() => resolve()))
      }
      if (ended) {
        try {
          report.socketReleased = await new Promise((resolve, reject) => {
            const socket = createConnection({ path: socketPath })
            socket.setTimeout(1000, () => socket.destroy(new Error('owned Unix cleanup timeout')))
            socket.once('connect', () => {
              socket.destroy()
              resolve(false)
            })
            socket.once('error', (error) => {
              if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(true)
              else reject(error)
            })
          })
          assert.equal(report.socketReleased, true)
        } catch (error) {
          cleanupErrors.push(String(error))
        }
      }
      if (failure) cleanupErrors.push(String(failure))
      if (timedOut) cleanupErrors.push('owned Core deadline exceeded')
      report.childClosed = ended
      report.childExitCode = exitCode
      report.timedOut = timedOut
      if (cleanupErrors.length) {
        report.cleanupErrors = cleanupErrors
        report.status = 'failed'
      }
      await writeFile(join(fixtureRoot, 'runtime.log'), output, { flag: 'wx', mode: 0o600 })
      await writeFile(join(fixtureRoot, 'runtime.json'), JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600
      })
    }
    if (report.status !== 'passed')
      throw new AggregateError(
        [
          ...(primaryError ? [primaryError] : []),
          ...(report.cleanupErrors ?? []).map((value) => new Error(value))
        ],
        'Owned Core fixture failed; original and cleanup errors retained'
      )
  }
} catch (error) {
  process.exitCode = 1
  console.error(String(error))
} finally {
  const result = {
    status:
      results.length === cases.length && results.every((x) => x.status === 'passed')
        ? 'passed'
        : 'failed',
    root,
    executable,
    binarySHA256,
    actualOrdinaryUID: true,
    actualHelperTUNApp: false,
    shippingModified: false,
    results
  }
  await writeFile(join(root, 'results.json'), JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600
  })
  console.log(
    JSON.stringify({
      status: result.status,
      root,
      cases: results.map((x) => ({ kind: x.kind, status: x.status, error: x.error }))
    })
  )
  if (result.status !== 'passed') process.exitCode = 1
}
