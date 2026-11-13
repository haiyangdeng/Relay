import { createServer } from 'net'
import { createSocket } from 'dgram'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { resolve, join } from 'path'
import { checkProfileRuntime } from '../../src/main/relay/core/profile-check'
import { compileProfileRuntime } from '../../src/main/relay/profiles/runtime'
import { supportedNodeTypes } from '../../src/main/relay/profiles/nodes'
import { fixturePort, closeFixture } from './fixtures/local-network'
import { protocolFixtures, transportFixtures } from './fixtures/node-protocols'

const exec = promisify(execFile),
  directory = await mkdtemp('/private/tmp/relay-node-fixtures-')
const rows: { name: string; passed: boolean; status?: string }[] = []
const check = (name: string, passed: boolean, status?: string): void => {
  rows.push({ name, passed, status })
}
try {
  const sink = createServer((socket) => socket.destroy()),
    loopbackPort = await fixturePort(sink)
  const udp = createSocket('udp4')
  let udpBound = false
  try {
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(loopbackPort, '127.0.0.1', () => {
        udpBound = true
        resolve()
      })
    })
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
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
        '-subj',
        '/CN=fixture.invalid'
      ],
      { cwd: directory, timeout: 10000, maxBuffer: 65536 }
    )
    const certificate = await readFile(join(directory, 'cert.pem'), 'utf8')
    const fixtures = protocolFixtures(certificate, loopbackPort)
    check(
      'fixture protocols exactly match all fixed parser cases',
      JSON.stringify(fixtures.map((n) => n.type).sort()) ===
        JSON.stringify([...supportedNodeTypes].sort())
    )
    for (const node of [...fixtures, ...transportFixtures(certificate, loopbackPort)]) {
      const source = JSON.stringify({ proxies: [node], rules: ['MATCH,REJECT'] })
      const compiled = compileProfileRuntime(source)
      check('controlled fields accepted ' + node.name, !!compiled.configuration)
      if (!compiled.configuration) continue
      const result = await checkProfileRuntime(resolve('extra/relay/core'), source)
      check('fixed ARM core parses ' + node.name, result.status === 'passed', result.status)
      process.stdout.write(node.name + ': ' + result.status + '\n')
    }
  } finally {
    if (udpBound) await new Promise<void>((resolve) => udp.close(resolve))
    else {
      try {
        udp.close()
      } catch {
        // A failed bind can leave the owned UDP socket already closed.
      }
    }
    await closeFixture(sink)
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
const report = {
  checks: rows.length,
  passed: rows.filter((r) => r.passed).length,
  rows,
  fixedVersion: 'v1.19.33',
  protocols: supportedNodeTypes.length,
  parserAcceptanceOnly: true,
  actualProtocolHandshakeVerified: false,
  actualUserNetworkOrSystemConfigurationChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  productionNodesOrClaudeTrafficUsed: false,
  architectureExecuted: process.arch,
  intelRuntimeVerified: false
}
await writeFile(
  '../evidence/node-protocol-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify({ checks: report.checks, passed: report.passed }) + '\n')
if (report.checks !== report.passed) throw new Error('Fixed protocol parser contract failed.')
