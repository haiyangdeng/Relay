import { generateKeyPairSync } from 'crypto'

type Node = { name: string; type: string } & Record<string, unknown>
export function protocolFixtures(certificate: string, loopbackPort = 9): Node[] {
  const key = Buffer.alloc(32, 7).toString('base64'),
    uuid = '00000000-0000-4000-8000-000000000001'
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const base = { server: '127.0.0.1', port: loopbackPort }
  const configurations: Record<string, Record<string, unknown>> = {
    ss: { ...base, cipher: 'aes-128-gcm', password: 'fixture' },
    ssr: { ...base, cipher: 'aes-128-cfb', password: 'fixture', obfs: 'plain', protocol: 'origin' },
    socks5: base,
    http: base,
    vmess: { ...base, uuid, alterId: 0, cipher: 'auto' },
    vless: { ...base, uuid },
    snell: { ...base, psk: 'fixture', version: 3 },
    trojan: { ...base, password: 'fixture' },
    hysteria: { ...base, 'auth-str': 'fixture', up: '10 Mbps', down: '10 Mbps' },
    hysteria2: { ...base, password: 'fixture' },
    wireguard: {
      ...base,
      ip: '10.0.0.2',
      'private-key': key,
      'public-key': key,
      'allowed-ips': ['0.0.0.0/0']
    },
    tuic: { ...base, uuid, password: 'fixture' },
    shadowquic: { ...base, username: 'fixture', password: 'fixture' },
    'gost-relay': base,
    direct: {},
    dns: {},
    reject: {},
    rematch: { 'target-rematch-name': 'fixture' },
    ssh: { ...base, username: 'fixture', password: 'fixture' },
    mieru: { ...base, username: 'fixture', password: 'fixture', transport: 'TCP' },
    anytls: { ...base, password: 'fixture' },
    sudoku: { ...base, key: 'fixture' },
    masque: {
      ...base,
      'private-key': ec.privateKey.export({ type: 'sec1', format: 'der' }).toString('base64'),
      'public-key': ec.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      ip: '10.0.0.2'
    },
    trusttunnel: { ...base, username: 'fixture', password: 'fixture' },
    openvpn: {
      ...base,
      ca: certificate,
      username: 'fixture',
      password: 'fixture',
      proto: 'tcp',
      dev: 'tun'
    },
    tailscale: { 'control-url': `http://127.0.0.1:${loopbackPort}`, ephemeral: true },
    zerotier: { network: '8056c2e21c000001' },
    easytier: {
      'network-name': 'fixture',
      'no-listener': true,
      peers: [`tcp://127.0.0.1:${loopbackPort}`]
    }
  }
  return Object.entries(configurations).map(([type, fields]) => ({
    name: 'Fixture-' + type,
    type,
    ...fields
  }))
}

export function transportFixtures(certificate: string, loopbackPort = 9): Node[] {
  const all = protocolFixtures(certificate, loopbackPort),
    find = (type: string): Node => {
      const node = all.find((n) => n.type === type)
      if (!node) throw new Error('Missing fixture protocol')
      return node
    }
  const vmess = find('vmess'),
    vless = find('vless'),
    trojan = find('trojan'),
    ss = find('ss')
  const publicKey = generateKeyPairSync('x25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64url')
  const variant = (name: string, node: Node, options: Record<string, unknown>): Node => ({
    ...node,
    ...options,
    name
  })
  return [
    variant('vmess-ws', vmess, {
      network: 'ws',
      'ws-opts': {
        path: '/ws',
        headers: { Host: 'fixture.invalid' },
        'max-early-data': 2048,
        'early-data-header-name': 'Sec-WebSocket-Protocol'
      }
    }),
    variant('vmess-http', vmess, {
      network: 'http',
      'http-opts': { method: 'GET', path: ['/http'], headers: { Host: ['fixture.invalid'] } }
    }),
    variant('vmess-h2', vmess, {
      network: 'h2',
      tls: true,
      alpn: ['h2'],
      'h2-opts': { host: ['fixture.invalid'], path: '/h2' }
    }),
    variant('vmess-grpc', vmess, {
      network: 'grpc',
      tls: true,
      'grpc-opts': {
        'grpc-service-name': 'fixture',
        'grpc-user-agent': 'fixture',
        'ping-interval': 30,
        'max-connections': 2
      }
    }),
    variant('vmess-mkcp', vmess, {
      network: 'mkcp',
      'mkcp-opts': { mtu: 1350, tti: 50, header: 'none', seed: 'fixture' }
    }),
    variant('vmess-mekya', vmess, {
      network: 'mekya',
      tls: true,
      'mekya-opts': {
        url: `https://127.0.0.1:${loopbackPort}/fixture`,
        kcp: { mtu: 1350, header: 'none' }
      }
    }),
    variant('vmess-smux', vmess, {
      smux: {
        enabled: true,
        protocol: 'h2mux',
        'max-connections': 2,
        padding: true,
        'brutal-opts': { enabled: false }
      }
    }),
    variant('vless-xhttp', vless, {
      network: 'xhttp',
      'xhttp-opts': {
        path: '/x',
        host: 'fixture.invalid',
        mode: 'auto',
        headers: { 'x-fixture': 'yes' },
        'reuse-settings': { 'max-concurrency': '2-4' }
      }
    }),
    variant('vless-xhttp-download', vless, {
      network: 'xhttp',
      'xhttp-opts': {
        mode: 'packet-up',
        'download-settings': {
          server: '127.0.0.1',
          port: loopbackPort,
          tls: false,
          path: '/download',
          headers: { 'x-test': 'yes' }
        }
      }
    }),
    variant('vless-reality', vless, {
      tls: true,
      servername: 'fixture.invalid',
      'reality-opts': { 'public-key': publicKey, 'short-id': '00' },
      'client-fingerprint': 'chrome'
    }),
    variant('vless-ws-upgrade', vless, {
      network: 'ws',
      'ws-opts': { path: '/ws', 'v2ray-http-upgrade': true }
    }),
    variant('vless-grpc', vless, {
      network: 'grpc',
      'grpc-opts': { 'grpc-service-name': 'fixture' }
    }),
    variant('trojan-ws', trojan, {
      network: 'ws',
      'ws-opts': { path: '/ws', headers: { Host: 'fixture.invalid' } }
    }),
    variant('trojan-grpc', trojan, {
      network: 'grpc',
      'grpc-opts': { 'grpc-service-name': 'fixture' }
    }),
    variant('trojan-ss', trojan, {
      'ss-opts': { enabled: true, method: 'aes-128-gcm', password: 'fixture' }
    }),
    variant('ss-obfs', ss, {
      plugin: 'obfs',
      'plugin-opts': { mode: 'http', host: 'fixture.invalid' }
    }),
    variant('ss-v2ray-plugin', ss, {
      plugin: 'v2ray-plugin',
      'plugin-opts': { mode: 'websocket', host: 'fixture.invalid', path: '/ws', tls: false }
    }),
    variant('ss-gost-plugin', ss, {
      plugin: 'gost-plugin',
      'plugin-opts': { mode: 'websocket', host: 'fixture.invalid' }
    }),
    variant('ss-shadow-tls', ss, {
      plugin: 'shadow-tls',
      'plugin-opts': { host: 'fixture.invalid', password: 'fixture', version: 3 }
    }),
    variant('ss-kcptun', ss, {
      plugin: 'kcptun',
      'plugin-opts': { key: 'fixture', crypt: 'aes', mode: 'fast', mtu: 1350 }
    }),
    variant('wireguard-peers', find('wireguard'), {
      reserved: 'AAH/',
      'ip-stack': { mode: 'gvisor' },
      peers: [
        {
          server: '127.0.0.1',
          port: loopbackPort,
          'public-key': Buffer.alloc(32, 7).toString('base64'),
          'allowed-ips': ['0.0.0.0/0']
        }
      ]
    })
  ]
}
