import { randomBytes, randomUUID, createHash } from 'crypto'
import { createSocket } from 'dgram'
import { lookup } from 'dns/promises'
import { constants } from 'fs'
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from 'fs/promises'
import { createServer } from 'http'
import { createConnection } from 'net'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { Duplex } from 'stream'
import { parseTunHostFrame } from '../../src/main/relay/tun/wire-json'
import { closeFixture, fixturePort } from './fixtures/local-network'

const address = '198.51.100.1',
  // RFC 6761 section 6.5: resolution APIs treat example names normally.
  // .invalid may be rejected before any query reaches the system resolver.
  domainSuffix = 'relay-acceptance.example',
  destinationPort = 18080,
  hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex'),
  hex = (value: unknown, length = 64): value is string =>
    typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)
type Phase = 'route' | 'dns'
type RequestStage = 'validation' | 'system-lookup' | 'direct-connect' | 'response' | 'proof'
interface Event {
  id: number
  kind: 'connect' | 'response' | 'dns'
  connectId?: string
  target?: string
  challenge?: string
}
interface State {
  version: 1
  nonce: string
  ports: { connect: number; dns: number }
  profiles: Record<Phase, { path: string; sha256: string }>
  refusedDNS: number
  events: Event[]
}
const error = (): Error => new Error('TUN验收夹具条件未确认；未启动核心或修改系统网络。')

async function privateBytes(path: string, limit: number): Promise<Buffer> {
  if ((await realpath(path)) !== path) throw error()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size > limit
    )
      throw error()
    const bytes = await file.readFile(),
      after = await lstat(path)
    if (
      bytes.length > limit ||
      ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].some(
        (key) => before[key as keyof typeof before] !== after[key as keyof typeof after]
      )
    )
      throw error()
    return bytes
  } finally {
    await file.close()
  }
}

export function fixtureDNS(packet: Buffer, domain: string): { response: Buffer; matched: boolean } {
  if (
    packet.length < 17 ||
    packet.length > 4096 ||
    packet.readUInt16BE(4) !== 1 ||
    packet.readUInt16BE(6) !== 0 ||
    packet.readUInt16BE(8) !== 0 ||
    packet.readUInt16BE(10) > 1 ||
    packet.readUInt16BE(2) & 0xfa00
  )
    throw error()
  const labels: string[] = []
  let at = 12
  while (packet[at]) {
    const size = packet[at++]
    if (!size || size > 63 || at + size >= packet.length) throw error()
    const label = packet.subarray(at, at + size).toString('ascii')
    if (!/^[a-zA-Z0-9-]+$/u.test(label)) throw error()
    labels.push(label)
    at += size
  }
  ++at
  if (at + 4 > packet.length || packet.readUInt16BE(at + 2) !== 1) throw error()
  const questionEnd = at + 4
  // One bounded EDNS0 OPT is accepted and omitted from the small response.
  // Fixed Mihomo may advertise its UDP payload size through this record.
  if (packet.readUInt16BE(10) === 1) {
    if (
      questionEnd + 11 > packet.length ||
      packet[questionEnd] !== 0 ||
      packet.readUInt16BE(questionEnd + 1) !== 41 ||
      packet[questionEnd + 6] !== 0 ||
      questionEnd + 11 + packet.readUInt16BE(questionEnd + 9) !== packet.length
    )
      throw error()
  } else if (questionEnd !== packet.length) throw error()
  const matched = labels.join('.').toLowerCase() === domain,
    isA = matched && packet.readUInt16BE(at) === 1,
    header = Buffer.alloc(12)
  packet.copy(header, 0, 0, 2)
  header.writeUInt16BE(0x8000 | (packet.readUInt16BE(2) & 0x0100) | (matched ? 0x0400 : 5), 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(isA ? 1 : 0, 6)
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 198, 51, 100, 1])
  return {
    response: Buffer.concat([header, packet.subarray(12, questionEnd), ...(isA ? [answer] : [])]),
    matched
  }
}

// Only loopback listeners and fresh private fixture files. There is no helper,
// Mihomo, shell, TUN, system setting or remote-network operation in this factory.
export async function serveTunAcceptanceFixture() {
  if (!process.getuid?.()) throw error()
  const directory = await realpath(await mkdtemp('/private/tmp/relay-tun-acceptance-')),
    nonce = randomBytes(16).toString('hex'),
    domain = `${nonce}.${domainSuffix}`,
    sockets = new Set<Duplex>(),
    dns = createSocket('udp4'),
    proxy = createServer((_request, response) => response.writeHead(405).end()),
    state: State = {
      version: 1,
      nonce,
      ports: { connect: 0, dns: 0 },
      profiles: {
        route: { path: join(directory, 'route.json'), sha256: '' },
        dns: { path: join(directory, 'dns.json'), sha256: '' }
      },
      refusedDNS: 0,
      events: []
    }
  let sequence = 0,
    writing = Promise.resolve(),
    closed = false
  const persist = (): Promise<void> => {
    const bytes = JSON.stringify(state)
    writing = writing.then(async () => {
      const temporary = join(directory, `.state-${randomUUID()}`),
        file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, join(directory, 'fixture-state.json'))
    })
    return writing
  }
  const record = (event: Omit<Event, 'id'>): Promise<void> => {
    state.events.push({ id: ++sequence, ...event })
    if (state.events.length > 2000) state.events.shift()
    return persist()
  }
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(7000, () => socket.destroy())
  })
  proxy.on('connect', (request, socket, head) => {
    const target = request.url ?? '',
      connectId = randomUUID()
    if (![`${address}:${destinationPort}`, `${domain}:${destinationPort}`].includes(target)) {
      socket.destroy()
      return
    }
    void record({ kind: 'connect', connectId, target })
      .then(() => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'))
      .catch(() => socket.destroy())
    let buffered = Buffer.alloc(0),
      answered = false
    const receive = (bytes: Buffer): void => {
      if (answered) return
      buffered = Buffer.concat([buffered, bytes])
      if (buffered.length > 8192) {
        socket.destroy()
        return
      }
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      answered = true
      const first = buffered.subarray(0, end).toString('ascii').split('\r\n')[0],
        match = /^GET \/([a-f0-9]{32}) HTTP\/1\.[01]$/u.exec(first)
      if (!match || buffered.length !== end + 4) {
        socket.destroy()
        return
      }
      const challenge = match[1],
        body = JSON.stringify({
          fixtureNonce: nonce,
          challenge,
          connectId,
          transport: 'relay-fixture-connect'
        })
      void record({ kind: 'response', connectId, target, challenge })
        .then(() =>
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
          )
        )
        .catch(() => socket.destroy())
    }
    socket.on('data', receive)
    if (head.length) receive(head)
  })
  dns.on('error', () => {})
  dns.on('message', (packet, remote) => {
    if (remote.address !== '127.0.0.1') return
    try {
      const answered = fixtureDNS(packet, domain)
      if (!answered.matched) ++state.refusedDNS
      const saved = answered.matched ? record({ kind: 'dns' }) : persist()
      void saved
        .then(() => dns.send(answered.response, remote.port, remote.address))
        .catch(() => {})
    } catch {
      /* Malformed/unsupported DNS is never forwarded. */
    }
  })
  try {
    state.ports.connect = await fixturePort(proxy)
    await new Promise<void>((resolve, reject) => {
      dns.once('error', reject)
      dns.bind(0, '127.0.0.1', resolve)
    })
    state.ports.dns = dns.address().port
    const base = {
      port: 0,
      'socks-port': 0,
      'mixed-port': 0,
      'redir-port': 0,
      'tproxy-port': 0,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      ipv6: false,
      mode: 'rule',
      'log-level': 'warning',
      'external-controller': '',
      'external-controller-tls': '',
      'geo-auto-update': false,
      'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' },
      'find-process-mode': 'off',
      ntp: { enable: false },
      sniffer: { enable: false },
      profile: { 'store-selected': false, 'store-fake-ip': false },
      proxies: [
        {
          name: 'Relay-Acceptance-Loopback',
          type: 'http',
          server: '127.0.0.1',
          port: state.ports.connect
        }
      ],
      rules: ['MATCH,Relay-Acceptance-Loopback'],
      tun: {
        enable: true,
        device: 'utun',
        stack: 'gvisor',
        mtu: 1500,
        'auto-route': true,
        'auto-detect-interface': false,
        'auto-redirect': false,
        recvmsgx: false,
        sendmsgx: false,
        gso: false,
        'dns-mode': 'disabled',
        'dns-hijack': [] as string[],
        'inet6-address': [],
        'route-address': ['198.51.100.0/24']
      }
    }
    for (const phase of ['route', 'dns'] as const) {
      const configuration =
          phase === 'route'
            ? { ...base, dns: { enable: false } }
            : {
                ...base,
                tun: {
                  ...base.tun,
                  'dns-mode': 'native',
                  'dns-hijack': ['any:53'],
                  'route-address': [...base.tun['route-address'], '198.18.0.2/32']
                },
                dns: {
                  enable: true,
                  listen: '',
                  ipv6: false,
                  'enhanced-mode': 'redir-host',
                  'use-hosts': false,
                  'use-system-hosts': false,
                  nameserver: [`udp://127.0.0.1:${state.ports.dns}`],
                  'default-nameserver': [`127.0.0.1:${state.ports.dns}`]
                }
              },
        bytes = JSON.stringify(configuration, null, 2) + '\n',
        file = await open(state.profiles[phase].path, 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      state.profiles[phase].sha256 = hash(bytes)
    }
    await persist()
  } catch (failure) {
    sockets.forEach((socket) => socket.destroy())
    proxy.close()
    dns.close()
    throw failure
  }
  return {
    public: {
      profiles: { route: state.profiles.route.path, dns: state.profiles.dns.path },
      nonce,
      ports: { ...state.ports }
    },
    state: (): State => structuredClone(state),
    close: async (): Promise<void> => {
      if (closed) return
      closed = true
      sockets.forEach((socket) => socket.destroy())
      await Promise.all([
        closeFixture(proxy),
        new Promise<void>((resolve) => dns.close(resolve)),
        writing
      ])
    },
    cleanup: async (): Promise<void> => {
      if (!closed) throw error()
      for (const phase of ['route', 'dns'] as const)
        if (
          hash(await privateBytes(state.profiles[phase].path, 65536)) !==
          state.profiles[phase].sha256
        )
          throw error()
      const saved = JSON.parse(
        (await privateBytes(join(directory, 'fixture-state.json'), 1024 * 1024)).toString('utf8')
      ) as State
      if (saved.nonce !== nonce) throw error()
      for (const path of [
        state.profiles.route.path,
        state.profiles.dns.path,
        join(directory, 'fixture-state.json')
      ])
        await unlink(path)
      await rmdir(directory)
    }
  }
}

export function validateFixtureAuthorization(raw: unknown, nonce: string, phase: Phase): void {
  const value = raw as Record<string, unknown>,
    candidate = value?.candidate as Record<string, unknown> | undefined
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'approved,approvedAt,authorizationId,candidate,fixtureNonce,stages,version' ||
    value.version !== 1 ||
    value.approved !== true ||
    value.fixtureNonce !== nonce ||
    typeof value.authorizationId !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.authorizationId) ||
    typeof value.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.approvedAt)) ||
    !Array.isArray(value.stages) ||
    !value.stages.includes(phase) ||
    value.stages.some((item) => !['route', 'dns'].includes(item)) ||
    !candidate ||
    Object.keys(candidate).sort().join(',') !== 'appSHA256,pkgSHA256' ||
    !hex(candidate.appSHA256) ||
    !hex(candidate.pkgSHA256)
  )
    throw error()
}

export async function requestTunAcceptance(
  profile: string,
  phase: Phase,
  authorization: string,
  progress: (stage: RequestStage) => void = () => {}
) {
  progress('validation')
  const directory = dirname(profile),
    state = JSON.parse(
      (await privateBytes(join(directory, 'fixture-state.json'), 1024 * 1024)).toString('utf8')
    ) as State
  if (
    state.version !== 1 ||
    !hex(state.nonce, 32) ||
    state.profiles[phase]?.path !== profile ||
    hash(await privateBytes(profile, 65536)) !== state.profiles[phase].sha256
  )
    throw error()
  validateFixtureAuthorization(
    parseTunHostFrame(await privateBytes(authorization, 8192)),
    state.nonce,
    phase
  )
  const before = state.events.at(-1)?.id ?? 0,
    domain = `${state.nonce}.${domainSuffix}`
  if (phase === 'dns') progress('system-lookup')
  const destination = phase === 'dns' ? (await lookup(domain, { family: 4 })).address : address
  if (destination !== address) throw error()
  progress('direct-connect')
  const challenge = randomBytes(16).toString('hex'),
    body = await new Promise<string>((resolve, reject) => {
      // Intentionally direct TCP: no HTTP_PROXY/SOCKS URL or custom DNS hook.
      const socket = createConnection({ host: destination, port: destinationPort }),
        chunks: Buffer[] = []
      let size = 0
      socket.setTimeout(7000, () => socket.destroy(error()))
      socket.once('error', reject)
      socket.on('data', (bytes: Buffer) => {
        size += bytes.length
        if (size > 8192) socket.destroy(error())
        else chunks.push(bytes)
      })
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.once('connect', () => {
        progress('response')
        socket.write(
          `GET /${challenge} HTTP/1.1\r\nHost: ${phase === 'dns' ? domain : address}:${destinationPort}\r\nConnection: close\r\n\r\n`
        )
      })
    })
  progress('proof')
  const at = body.indexOf('\r\n\r\n')
  if (!body.startsWith('HTTP/1.1 200 OK\r\n') || at < 0) throw error()
  const proof = JSON.parse(body.slice(at + 4)) as Record<string, unknown>,
    after = JSON.parse(
      (await privateBytes(join(directory, 'fixture-state.json'), 1024 * 1024)).toString('utf8')
    ) as State
  if (
    proof.fixtureNonce !== state.nonce ||
    proof.challenge !== challenge ||
    proof.transport !== 'relay-fixture-connect' ||
    !after.events.some(
      (event) =>
        event.id > before &&
        event.kind === 'response' &&
        event.challenge === challenge &&
        event.connectId === proof.connectId
    ) ||
    (phase === 'dns' && !after.events.some((event) => event.id > before && event.kind === 'dns'))
  )
    throw error()
  return { status: 'passed', phase, challenge, proof, dnsObserved: phase === 'dns' }
}

export function acceptanceCommand(
  arguments_: string[]
):
  | { action: 'serve' }
  | { action: 'request'; profile: string; phase: Phase; authorization: string } {
  if (arguments_.join(',') === '--serve-fixture') return { action: 'serve' }
  if (
    arguments_.length === 7 &&
    arguments_[0] === '--request-test' &&
    arguments_[1] === '--profile' &&
    arguments_[3] === '--phase' &&
    ['route', 'dns'].includes(arguments_[4]) &&
    arguments_[5] === '--authorization' &&
    arguments_[2].startsWith('/') &&
    arguments_[6].startsWith('/')
  )
    return {
      action: 'request',
      profile: arguments_[2],
      phase: arguments_[4] as Phase,
      authorization: arguments_[6]
    }
  throw error()
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const command = acceptanceCommand(process.argv.slice(2))
    if (command.action === 'serve') {
      const fixture = await serveTunAcceptanceFixture()
      process.stdout.write(JSON.stringify(fixture.public) + '\n')
      const stop = (): void => {
        void fixture.close().then(() => process.exit(0))
      }
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
    } else {
      let stage: RequestStage = 'validation'
      const diagnostic = (reason: 'timeout' | 'failure'): void => {
        process.stderr.write(
          JSON.stringify({ status: 'failed', phase: command.phase, stage, reason }) + '\n'
        )
      }
      const deadline = setTimeout(() => {
        diagnostic('timeout')
        process.stderr.write('TUN验收请求超时；请立即在Relay明确停用并复核恢复。\n')
        process.exit(1)
      }, 10000)
      try {
        process.stdout.write(
          JSON.stringify(
            await requestTunAcceptance(
              command.profile,
              command.phase,
              command.authorization,
              (next) => {
                stage = next
              }
            )
          ) + '\n'
        )
      } catch (cause) {
        diagnostic('failure')
        throw cause
      } finally {
        clearTimeout(deadline)
      }
    }
  } catch {
    process.stderr.write(error().message + '\n')
    process.exitCode = 1
  }
}
