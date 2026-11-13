import { lstat, readdir, realpath } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readBinaryResource, resourceHash } from '../resources/source'
import { coreEnvironment } from '../core/configuration'

export interface ProtectedConfigurationSnapshot {
  revision: string
  entries: { label: string; revision: string; exists: boolean }[]
}
export interface ClaudeTransportObservation {
  endpoint: 'anthropic-api' | 'claude-web'
  status: number
  tlsResponse: true
}
export interface SystemRuntimeObservation {
  effectiveProxyRevision: string
  effectiveDnsRevision: string
}
const hash = (value: unknown): string => resourceHash(Buffer.from(JSON.stringify(value)))
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, child]) => [key, canonical(child)])
    )
  return value
}
// Caller supplies its trusted current-user home. This helper only reads fixed
// protection paths; neither snapshots nor reports contain file bodies/secrets.
export async function captureProtectedConfiguration(
  home: string,
  edgePolicyRevision: string
): Promise<ProtectedConfigurationSnapshot> {
  if (
    !isAbsolute(home) ||
    resolve(home) !== home ||
    (await realpath(home)) !== home ||
    !/^[a-f0-9]{64}$/u.test(edgePolicyRevision)
  )
    throw new Error('保护配置检查上下文无效。')
  const entries: ProtectedConfigurationSnapshot['entries'] = []
  let total = 0
  const read = async (path: string): Promise<{ bytes: Buffer; mode: number } | undefined> => {
    let first: Awaited<ReturnType<typeof lstat>>
    try {
      first = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (
      !first.isFile() ||
      first.isSymbolicLink() ||
      first.uid !== process.getuid?.() ||
      first.nlink !== 1 ||
      first.size < 1 ||
      first.size > 8 * 1024 * 1024
    )
      throw new Error('保护配置文件类型或大小未确认。')
    total += first.size
    if (total > 32 * 1024 * 1024) throw new Error('保护配置检查总量过大。')
    const bytes = await readBinaryResource(path),
      after = await lstat(path)
    if (
      first.dev !== after.dev ||
      first.ino !== after.ino ||
      first.mode !== after.mode ||
      first.uid !== after.uid ||
      first.nlink !== after.nlink ||
      first.mtimeMs !== after.mtimeMs ||
      first.ctimeMs !== after.ctimeMs ||
      bytes.length !== first.size
    )
      throw new Error('保护配置在读取期间改变。')
    return { bytes, mode: after.mode & 0o7777 }
  }
  const file = async (label: string, relative: string, keys?: string[]): Promise<void> => {
    const source = await read(join(home, relative))
    if (!source) {
      entries.push({ label, exists: false, revision: hash('missing') })
      return
    }
    let content: unknown = resourceHash(source.bytes)
    if (keys) {
      const root: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)
      )
      if (!root || typeof root !== 'object' || Array.isArray(root))
        throw new Error('浏览器保护配置格式未确认。')
      const object = root as Record<string, unknown>
      content = canonical(
        Object.fromEntries(
          keys.filter((key) => Object.hasOwn(object, key)).map((key) => [key, object[key]])
        )
      )
    }
    entries.push({ label, exists: true, revision: hash({ mode: source.mode, content }) })
  }
  await file('claude-code-settings', '.claude/settings.json')
  await file(
    'claude-desktop-settings',
    'Library/Application Support/Claude/claude_desktop_config.json'
  )
  await file('codex-settings', '.codex/config.toml')
  const clash = 'Library/Application Support/mihomo-party'
  for (const name of [
    'config.yaml',
    'mihomo.yaml',
    'profile.yaml',
    'override.yaml',
    'work/config.yaml'
  ])
    await file(`clash-${name}`, `${clash}/${name}`)
  for (const group of ['profiles', 'overrides']) {
    const directory = join(home, clash, group)
    let names: string[]
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
        throw new Error('配置来源目录未确认。')
      names = (await readdir(directory))
        .filter((name) => /\.(?:yaml|yml|json|js)$/u.test(name))
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []
      else throw error
    }
    if (names.length > 200) throw new Error('保护配置来源过多。')
    const contents: { name: string; revision: string }[] = []
    for (const name of names) {
      const source = await read(join(directory, name))
      if (!source) throw new Error('配置来源在读取期间消失。')
      contents.push({
        name: resourceHash(Buffer.from(name)),
        revision: hash({ mode: source.mode, sha256: resourceHash(source.bytes) })
      })
    }
    entries.push({
      label: `clash-${group}-inventory`,
      exists: names.length > 0,
      revision: hash(contents)
    })
  }
  for (const [label, relative] of [
    ['legacy-chrome', 'Library/Application Support/Claude Private Browser'],
    ['relay-chrome', 'Library/Application Support/Relay-Preview/Private Browser']
  ]) {
    await file(`${label}-dns`, `${relative}/Local State`, ['dns_over_https', 'proxy'])
    await file(`${label}-webrtc`, `${relative}/Default/Preferences`, ['webrtc', 'proxy'])
  }
  entries.push({ label: 'edge-known-managed-policies', exists: true, revision: edgePolicyRevision })
  return { entries, revision: hash(entries) }
}
export function compareProtectedConfiguration(
  before: ProtectedConfigurationSnapshot,
  after: ProtectedConfigurationSnapshot
): string[] {
  const old = new Map(before.entries.map((entry) => [entry.label, entry])),
    next = new Map(after.entries.map((entry) => [entry.label, entry]))
  return [...new Set([...old.keys(), ...next.keys()])]
    .filter(
      (label) =>
        old.get(label)?.revision !== next.get(label)?.revision ||
        old.get(label)?.exists !== next.get(label)?.exists
    )
    .sort()
}
const exec = promisify(execFile)
export async function captureSystemRuntime(
  run: (argument: '--proxy' | '--dns') => Promise<string> = async (argument) =>
    (
      await exec('/usr/sbin/scutil', [argument], {
        timeout: 5000,
        maxBuffer: 262144,
        env: coreEnvironment()
      })
    ).stdout
): Promise<SystemRuntimeObservation> {
  try {
    const proxy = await run('--proxy'),
      dns = await run('--dns')
    if (
      !proxy.trimStart().startsWith('<dictionary>') ||
      !/^(?:DNS configuration|No DNS configuration available)/u.test(dns.trimStart())
    )
      throw new Error()
    return {
      effectiveProxyRevision: resourceHash(Buffer.from(proxy)),
      effectiveDnsRevision: resourceHash(Buffer.from(dns))
    }
  } catch {
    throw new Error('系统当前生效的代理／DNS信息未确认，不能作为已恢复的证据。')
  }
}
export async function probeClaudeTransport(
  port: number,
  run: (arguments_: string[]) => Promise<string> = async (arguments_) =>
    (
      await exec('/usr/bin/curl', arguments_, {
        timeout: 18000,
        maxBuffer: 4096,
        env: coreEnvironment()
      })
    ).stdout
): Promise<ClaudeTransportObservation[]> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('现有代理端口无效。')
  const observations: ClaudeTransportObservation[] = []
  for (const [endpoint, url] of [
    ['anthropic-api', 'https://api.anthropic.com/'],
    ['claude-web', 'https://claude.ai/']
  ] as const) {
    try {
      const output = await run([
        '-q',
        '--proto',
        '=https',
        '--head',
        '--silent',
        '--show-error',
        '--proxy',
        `http://127.0.0.1:${port}`,
        '--noproxy',
        '',
        '--connect-timeout',
        '5',
        '--max-time',
        '15',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        url
      ])
      const status = Number(output.trim())
      if (!/^\d{3}$/u.test(output.trim()) || status < 200 || status >= 500) throw new Error()
      observations.push({ endpoint, status, tlsResponse: true })
    } catch {
      throw new Error(
        '现有代理到Claude端点的TLS／HTTP响应未确认；不携带账号、不跟随重定向、不直连重试。'
      )
    }
  }
  return observations
}
export function sameClaudeTransport(
  before: ClaudeTransportObservation[],
  after: ClaudeTransportObservation[]
): boolean {
  return (
    before.length === 2 &&
    after.length === 2 &&
    before.every(
      (value, index) =>
        value.endpoint === after[index].endpoint &&
        value.status === after[index].status &&
        value.tlsResponse &&
        after[index].tlsResponse
    )
  )
}
export function hostRestorationAccepted(result: {
  submitted: boolean
  proxyRestored: boolean
  configurationUnchanged: boolean
  systemRuntimeRestored: boolean
  transportRestored: boolean
  temporaryResourcesClosed: boolean
  checksPassed: boolean
}): boolean {
  return (
    result.submitted &&
    result.proxyRestored &&
    result.configurationUnchanged &&
    result.systemRuntimeRestored &&
    result.transportRestored &&
    result.temporaryResourcesClosed &&
    result.checksPassed
  )
}
