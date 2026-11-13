import { randomBytes, randomUUID } from 'crypto'
import { createSocket } from 'dgram'
import { lstat, readFile } from 'fs/promises'
import { createConnection } from 'net'
import { describe, expect, it } from 'vitest'
import {
  acceptanceCommand,
  fixtureDNS,
  serveTunAcceptanceFixture,
  validateFixtureAuthorization
} from './tun-acceptance-fixture'

function question(domain: string, edns = false): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(123, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)
  if (edns) header.writeUInt16BE(1, 10)
  return Buffer.concat([
    header,
    ...domain
      .split('.')
      .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0, 0, 1, 0, 1]),
    ...(edns ? [Buffer.from([0, 0, 41, 0x10, 0, 0, 0, 0, 0, 0, 0])] : [])
  ])
}

describe('TUN acceptance fixtures without core/helper/system changes', () => {
  it('admits only explicit serve or authorized-request command shapes', () => {
    expect(acceptanceCommand(['--serve-fixture'])).toEqual({ action: 'serve' })
    for (const args of [
      [],
      ['--serve-fixture', '--port', '80'],
      ['--request-test'],
      ['--request-test', '--profile', '/private/test', '--phase', 'dns'],
      ['--stop-core']
    ])
      expect(() => acceptanceCommand(args)).toThrow()
    const nonce = randomBytes(16).toString('hex'),
      authorization = {
        version: 1,
        authorizationId: randomUUID(),
        approvedAt: new Date().toISOString(),
        approved: true,
        fixtureNonce: nonce,
        stages: ['route'],
        candidate: { appSHA256: 'a'.repeat(64), pkgSHA256: 'b'.repeat(64) }
      }
    expect(() => validateFixtureAuthorization(authorization, nonce, 'route')).not.toThrow()
    expect(() => validateFixtureAuthorization(authorization, nonce, 'dns')).toThrow()
    expect(() =>
      validateFixtureAuthorization({ ...authorization, approved: false }, nonce, 'route')
    ).toThrow()
    expect(() => validateFixtureAuthorization(authorization, '0'.repeat(32), 'route')).toThrow()
  })
  it('accepts its unique DNS name including EDNS0 and refuses other names without forwarding', () => {
    const domain = randomBytes(16).toString('hex') + '.relay-acceptance.example'
    for (const edns of [false, true]) {
      const answer = fixtureDNS(question(domain, edns), domain)
      expect(answer.matched).toBe(true)
      expect(answer.response.readUInt16BE(6)).toBe(1)
      expect(answer.response.subarray(-4)).toEqual(Buffer.from([198, 51, 100, 1]))
      expect(answer.response.readUInt32BE(answer.response.length - 10)).toBe(0)
    }
    expect(
      fixtureDNS(question('private-other.invalid'), domain).response.readUInt16BE(2) & 15
    ).toBe(5)
    const compressed = question(domain)
    compressed[12] = 0xc0
    expect(() => fixtureDNS(compressed, domain)).toThrow()
  })
  it('serves loopback CONNECT proof, loopback DNS, and private two-stage configs only', async () => {
    const fixture = await serveTunAcceptanceFixture()
    try {
      const { profiles, ports, nonce } = fixture.public,
        route = JSON.parse(await readFile(profiles.route, 'utf8')),
        dns = JSON.parse(await readFile(profiles.dns, 'utf8'))
      expect((await lstat(profiles.route)).mode & 0o7777).toBe(0o600)
      expect((await lstat(profiles.dns)).mode & 0o7777).toBe(0o600)
      expect(route.tun['route-address']).toEqual(['198.51.100.0/24'])
      expect(route.tun['auto-detect-interface']).toBe(false)
      expect(route.tun['dns-mode']).toBe('disabled')
      expect(route.ipv6).toBe(false)
      expect(dns.tun['dns-mode']).toBe('native')
      expect(dns.tun['route-address']).toEqual(['198.51.100.0/24', '198.18.0.2/32'])
      expect(dns.dns.nameserver).toEqual([`udp://127.0.0.1:${ports.dns}`])
      expect(route.proxies[0].server).toBe('127.0.0.1')
      const challenge = randomBytes(16).toString('hex'),
        response = await new Promise<string>((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port: ports.connect }),
            chunks: Buffer[] = []
          socket.setTimeout(2000, () => socket.destroy(new Error('loopback test timeout')))
          socket.on('data', (bytes: Buffer) => chunks.push(bytes))
          socket.once('error', reject)
          socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          socket.once('connect', () =>
            socket.write(
              `CONNECT 198.51.100.1:18080 HTTP/1.1\r\nHost: 198.51.100.1:18080\r\n\r\nGET /${challenge} HTTP/1.1\r\nHost: 198.51.100.1:18080\r\nConnection: close\r\n\r\n`
            )
          )
        })
      expect(response).toContain('HTTP/1.1 200 Connection Established')
      expect(response).toContain(`"fixtureNonce":"${nonce}"`)
      expect(response).toContain(`"challenge":"${challenge}"`)
      expect(
        fixture
          .state()
          .events.some((event) => event.kind === 'response' && event.challenge === challenge)
      ).toBe(true)
      const packet = await new Promise<Buffer>((resolve, reject) => {
        const socket = createSocket('udp4'),
          timer = setTimeout(() => {
            socket.close()
            reject(new Error('loopback DNS timeout'))
          }, 2000)
        socket.once('error', reject)
        socket.once('message', (bytes) => {
          clearTimeout(timer)
          socket.close()
          resolve(bytes)
        })
        socket.send(question(`${nonce}.relay-acceptance.example`, true), ports.dns, '127.0.0.1')
      })
      expect(packet.subarray(-4)).toEqual(Buffer.from([198, 51, 100, 1]))
      expect(fixture.state().events.some((event) => event.kind === 'dns')).toBe(true)
    } finally {
      await fixture.close()
      await fixture.cleanup()
    }
  })
})
