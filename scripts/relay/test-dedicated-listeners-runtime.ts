import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { lstat, writeFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { startLocalProxyCore } from '../../src/main/relay/core/local-proxy-runtime'
import { verifyCoreResource } from '../../src/main/relay/core/resources'

// Run only in a private HOME and a sandbox allowing the six allocated loopback ports.
const run = promisify(execFile)
const [resourceRoot, receipt, ...portArgs] = process.argv.slice(2)
const [target, selected, alternate, ordinary, http, socks] = portArgs.map(Number)
assert(resourceRoot && receipt && portArgs.length === 6 && new Set(portArgs).size === 6)
assert(portArgs.every((port) => /^[1-9]\d{3,4}$/u.test(port) && Number(port) <= 65535))

async function verify(): Promise<void> {
  const pin = await verifyCoreResource(resourceRoot)
  const evidence: Record<string, unknown> = { coreSHA256: pin.sha256, version: pin.version }
  const stats = { target: 0, selected: 0, alternate: 0 }
  const sockets = new Set<Duplex>()
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const origin = createServer((request, response) => {
    stats.target++
    response.end(request.url)
  })
  origin.on('connection', track)
  const node = (name: 'selected' | 'alternate'): ReturnType<typeof createServer> => {
    const server = createServer((_request, response) => response.writeHead(405).end())
    server.on('connection', track)
    server.on('connect', (request, socket, head) => {
      if (request.url !== `127.0.0.1:${target}`) return socket.destroy()
      stats[name]++
      const upstream = track(connect(target, '127.0.0.1'))
      socket.once('close', () => upstream.destroy())
      upstream.once('close', () => socket.destroy())
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })
      return undefined
    })
    return server
  }
  const a = node('selected'),
    b = node('alternate')
  const listen = (server: ReturnType<typeof createServer>, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  const close = (server: ReturnType<typeof createServer>): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!server.listening) resolve()
      else server.close((error) => (error ? reject(error) : resolve()))
    })
  const source = JSON.stringify({
    proxies: [
      { name: 'Selected fixture', type: 'http', server: '127.0.0.1', port: selected },
      { name: 'Alternate fixture', type: 'http', server: '127.0.0.1', port: alternate }
    ],
    rules: ['MATCH,DIRECT']
  })
  const get = (label: string, proxy: string): Promise<{ stdout: string }> =>
    run('/usr/bin/curl', [
      '-q',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time',
      '7',
      '--noproxy',
      '',
      '--proxy',
      proxy,
      `http://127.0.0.1:${target}/${label}`
    ])
  const endpoints = [`http://127.0.0.1:${http}`, `socks5h://127.0.0.1:${socks}`]
  let core: Awaited<ReturnType<typeof startLocalProxyCore>> | undefined
  let cleanup: (() => Promise<void>) | undefined
  try {
    await Promise.all([listen(origin, target), listen(a, selected), listen(b, alternate)])
    core = await startLocalProxyCore(
      resourceRoot,
      source,
      ordinary,
      (stop) => (cleanup = stop),
      'off',
      {
        route: 'Selected fixture',
        httpPort: http,
        socksPort: socks
      }
    )
    const instance = core
    const patchMode = instance.patchMode
    assert(patchMode)
    const testModes = async (
      stage: 'healthy' | 'node-offline' | 'node-restored'
    ): Promise<void> => {
      const available = stage !== 'node-offline'
      for (const mode of ['rule', 'global', 'direct'] as const) {
        await patchMode(mode)
        assert.equal((await instance.read('configs')).mode, mode)
        const before = { ...stats }
        for (const [index, proxy] of endpoints.entries()) {
          const label = `${mode}-${index}-${stage}`
          if (available) assert.equal((await get(label, proxy)).stdout, `/${label}`)
          else await assert.rejects(get(label, proxy))
        }
        assert.deepEqual(stats, {
          target: before.target + (available ? 2 : 0),
          selected: before.selected + (available ? 2 : 0),
          alternate: 0
        })
        const ordinaryPath = `${mode}-ordinary-${stage}`
        assert.equal(
          (await get(ordinaryPath, `http://127.0.0.1:${ordinary}`)).stdout,
          `/${ordinaryPath}`
        )
        assert.equal(stats.target, before.target + (available ? 3 : 1))
        assert.equal(stats.selected, before.selected + (available ? 2 : 0))
        assert.equal(stats.alternate, 0)
        evidence[`${mode}-${stage}`] = { ...stats }
      }
    }
    await testModes('healthy')
    await close(a)
    await testModes('node-offline')
    await listen(a, selected)
    await testModes('node-restored')
    const stoppedBefore = { ...stats }
    await core.stop()
    assert.equal(core.state(), 'stopped')
    await assert.rejects(lstat(core.directory), { code: 'ENOENT' })
    for (const proxy of endpoints) await assert.rejects(get('core-stopped', proxy))
    assert.deepEqual(stats, stoppedBefore)
    evidence.coreStopped = true
    evidence.zeroDirectOrAlternateFallback = true
    evidence.runtimeDirectoryRemoved = true
  } finally {
    try {
      if (core) await core.stop()
      else await cleanup?.()
    } finally {
      sockets.forEach((socket) => socket.destroy())
      await Promise.all([a, b, origin].map(close))
    }
  }
  await writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

void verify().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
