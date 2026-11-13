import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const root = process.argv[2],
  app = process.argv[3]
assert(root.startsWith('/private/tmp/relay-geo-local-proto-') && app.endsWith('/app'))
const { stopOwnedChild } = await import(
  pathToFileURL(join(app, 'src/main/relay/core/shutdown.ts')).href
)
const { freeFixturePort, closeFixture } = await import(
  pathToFileURL(join(app, 'scripts/relay/fixtures/local-network.ts')).href
)
const home = join(root, 'run')
await mkdir(home, { mode: 0o700 })
const socketPath = join(home, 'api.sock'),
  allowedPort = await freeFixturePort(),
  token = randomBytes(16).toString('hex')
let acceptedBySentinel = 0
const sentinel = createServer((socket) => {
  acceptedBySentinel++
  socket.destroy()
})
let sentinelPort, policy, child, closed, timer
let stdout = '',
  stderr = '',
  ended = false,
  code = null,
  failure
const report = {
  scope: 'inert ordinary-UID Node calibrates exact future prototype Core sandbox',
  socketPath,
  allowedPort,
  actualCoreRun: false,
  systemNetworkChanged: false,
  currentClashOrMihomoTouched: false
}
try {
  await new Promise((resolve, reject) => {
    sentinel.once('error', reject)
    sentinel.listen(0, '127.0.0.1', resolve)
  })
  const address = sentinel.address()
  assert(address && typeof address !== 'string')
  sentinelPort = address.port
  policy = `(version 1)\n(allow default)\n(deny network*)\n(allow network-bind (local unix-socket (path ${JSON.stringify(socketPath)})))\n(allow network-inbound (local unix-socket (path ${JSON.stringify(socketPath)})))\n(allow network-bind (local tcp4 "localhost:${allowedPort}"))\n(allow network-inbound (local tcp4 "localhost:${allowedPort}"))\n`
  Object.assign(report, { policy, sentinelPort })
  await writeFile(join(root, 'prototype-sandbox.sb'), policy, { flag: 'wx', mode: 0o600 })
  const source = `
const net = require('node:net');
const token = ${JSON.stringify(token)}, result = {unixAccepted:0,tcpAccepted:0,outboundError:null};
let ready=0, finished=false;
const accept = key => s => s.once('data', data => {
  if(data.toString()!==token){process.exitCode=1;s.destroy();return;}
  result[key]++;s.end(token);check();
});
const unix=net.createServer(accept('unixAccepted')), tcp=net.createServer(accept('tcpAccepted'));
for(const s of [unix,tcp])s.once('error',e=>{console.error(e.code);process.exit(1)});
function bound(){if(++ready===2){console.log('READY'); const s=net.createConnection({host:'127.0.0.1',port:${sentinelPort}});s.setTimeout(2000,()=>{console.error('outbound timeout');process.exit(1)});s.once('connect',()=>{console.error('UNEXPECTED_OUTBOUND');process.exit(1)});s.once('error',e=>{result.outboundError=e.code;s.destroy();check()});}}
function check(){if(!finished&&result.unixAccepted===1&&result.tcpAccepted===1&&['EPERM','EACCES'].includes(result.outboundError)){finished=true;unix.close();tcp.close();console.log(JSON.stringify(result));}}
unix.listen(${JSON.stringify(socketPath)},bound);tcp.listen({host:'127.0.0.1',port:${allowedPort}},bound);
`
  const environment = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', TMPDIR: home }
  child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, '-e', source], {
    cwd: home,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })
  child.stdout.on('data', (b) => {
    stdout += b
    if (stdout.length > 65536) {
      failure ??= new Error('Calibration stdout limit')
      child.kill('SIGTERM')
    }
  })
  child.stderr.on('data', (b) => {
    stderr += b
    if (stderr.length > 65536) {
      failure ??= new Error('Calibration stderr limit')
      child.kill('SIGTERM')
    }
  })
  child.once('error', (error) => {
    failure = error
  })
  closed = new Promise((resolve) =>
    child.once('close', (exit) => {
      ended = true
      code = exit
      resolve()
    })
  )
  timer = setTimeout(() => {
    failure = new Error('Inert sandbox calibration deadline')
    child.kill('SIGTERM')
  }, 10000)
  const exchange = (options) =>
    new Promise((resolve, reject) => {
      const socket = createConnection(options)
      let text = ''
      socket.setTimeout(2000, () => socket.destroy(new Error('Owned positive control timeout')))
      socket.once('connect', () => socket.write(token))
      socket.on('data', (b) => {
        text += b
      })
      socket.once('error', reject)
      socket.once('close', () => {
        try {
          assert.equal(text, token)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
  const deadline = performance.now() + 5000
  while (!stdout.includes('READY\n')) {
    if (failure) throw failure
    if (ended || performance.now() > deadline)
      throw new Error('Private bind calibration failed: ' + stderr)
    await delay(10)
  }
  await exchange({ path: socketPath })
  await exchange({ host: '127.0.0.1', port: allowedPort })
  await closed
  if (failure) throw failure
  assert.equal(code, 0)
  const result = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(result.unixAccepted, 1)
  assert.equal(result.tcpAccepted, 1)
  assert(['EPERM', 'EACCES'].includes(result.outboundError))
  assert.equal(acceptedBySentinel, 0)
  Object.assign(report, { status: 'passed', result, acceptedBySentinel, exitCode: code })
} catch (error) {
  Object.assign(report, {
    status: 'failed',
    error: String(error),
    acceptedBySentinel,
    exitCode: code
  })
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  const cleanup = await Promise.allSettled([
    (async () => {
      if (child) {
        if (!ended) await stopOwnedChild(child, closed, 'inert')
        else await closed
        assert(ended)
        assert.equal(code, 0)
      }
    })(),
    closeFixture(sentinel)
  ])
  const cleanupErrors = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => String(result.reason))
  if (sentinel.listening) cleanupErrors.push('Sentinel remains listening')
  if (cleanupErrors.length) {
    report.status = 'failed'
    report.cleanupErrors = cleanupErrors
    process.exitCode = 1
  }
  Object.assign(report, {
    childStarted: !!child,
    childClosed: ended,
    sentinelClosed: !sentinel.listening,
    stdout,
    stderr
  })
  await writeFile(join(root, 'sandbox-calibration.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600
  })
  console.log(
    JSON.stringify({
      status: report.status,
      exitCode: code,
      acceptedBySentinel,
      childClosed: ended,
      sentinelClosed: !sentinel.listening,
      cleanupErrors,
      stderr
    })
  )
}
