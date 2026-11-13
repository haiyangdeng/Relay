import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { relayUpstreamChannels } from '../../shared/relay/channels'
import { APP_UPDATE_IPC_CHANNELS } from '../../shared/relay/app-updates'
import { RELAY_LOCAL_PROXY_PLAN_CHANNELS } from '../../shared/relay/local-proxy-plan'
import { RELAY_MAINTENANCE_CHANNELS } from '../../shared/relay/maintenance'
import { RELAY_OWNED_RESET_CHANNELS } from '../../shared/relay/owned-reset'
import { validatePreviewInput } from '../../shared/relay/protocol'
import { RELAY_SIMPLE_CHANNELS } from '../../shared/relay/simple'
import { RELAY_SIMPLE_CONFIGURATION_CHANNELS } from '../../shared/relay/simple-configuration'
import { RELAY_SIMPLE_PUBLICATION_CHANNELS } from '../../shared/relay/simple-publication'
import { RELAY_SIMPLE_SOURCE_CHANNELS } from '../../shared/relay/simple-sources'
import {
  defaultUIPreferences,
  RELAY_UI_PREFERENCES_CHANNELS
} from '../../shared/relay/ui-preferences'
import { createPreviewBackend, previewReadChannels } from './preview'
import { allowedPreviewRequest } from './navigation'

const input = { httpPort: 7890, node: 'fixture-node', existingJSON: '{}', internalExceptions: '' }
const channelGroups = new Map<string, readonly string[]>([
  ['APP_UPDATE_IPC_CHANNELS', APP_UPDATE_IPC_CHANNELS],
  ['RELAY_LOCAL_PROXY_PLAN_CHANNELS', RELAY_LOCAL_PROXY_PLAN_CHANNELS],
  ['RELAY_MAINTENANCE_CHANNELS', RELAY_MAINTENANCE_CHANNELS],
  ['RELAY_OWNED_RESET_CHANNELS', RELAY_OWNED_RESET_CHANNELS],
  ['RELAY_SIMPLE_CHANNELS', RELAY_SIMPLE_CHANNELS],
  ['RELAY_SIMPLE_CONFIGURATION_CHANNELS', RELAY_SIMPLE_CONFIGURATION_CHANNELS],
  ['RELAY_SIMPLE_PUBLICATION_CHANNELS', RELAY_SIMPLE_PUBLICATION_CHANNELS],
  ['RELAY_SIMPLE_SOURCE_CHANNELS', RELAY_SIMPLE_SOURCE_CHANNELS],
  ['RELAY_UI_PREFERENCES_CHANNELS', RELAY_UI_PREFERENCES_CHANNELS]
])

function expandChannelList(source: string): string[] {
  return source
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .flatMap((entry) => {
      const item = entry.trim()
      if (!item) return []
      const literal = /^'(\w+)'$/.exec(item)
      if (literal) return [literal[1]]
      const spread = /^\.\.\.(\w+)$/.exec(item)
      const group = spread && channelGroups.get(spread[1])
      if (!group) throw new Error(`Unknown channel list entry: ${item}`)
      return group
    })
}

const explicitChannels = (main: string): string[] =>
  [...main.matchAll(/ipcMain\.handle\('([^']+)'/gu)].map((match) => match[1])

describe('Relay offline boundary', () => {
  it('returns the active startup frame and GPU settings through the existing config read', () => {
    const read = createPreviewBackend({
      preferences: defaultUIPreferences,
      windowPreferences: { useWindowFrame: false, disableHardwareAcceleration: true },
      patchView: async () => {}
    })
    expect(read('getAppConfig')).toMatchObject({
      useWindowFrame: false,
      disableHardwareAcceleration: true
    })
    expect(createPreviewBackend()('getAppConfig')).toMatchObject({
      useWindowFrame: true,
      disableHardwareAcceleration: false
    })
  })
  it('does not report any live core or system proxy', () => {
    const read = createPreviewBackend()
    expect(read('mihomoGroups')).toEqual([])
    expect(read('mihomoProxies')).toEqual({ proxies: {} })
    expect(read('checkAutoRun')).toBe(false)
    expect(read('getControledMihomoConfig')).toMatchObject({ tun: { enable: false } })
    expect(read('getAppConfig')).toMatchObject({
      modeSelected: true,
      useSubStore: false,
      enableTrafficLogger: false,
      autoCheckUpdate: false
    })
  })
  it('rejects unscoped upstream operations', () => {
    const read = createPreviewBackend()
    for (const channel of relayUpstreamChannels) {
      if (previewReadChannels.some((safe) => safe === channel))
        expect(() => read(channel)).not.toThrow()
      else expect(() => read(channel)).toThrow()
    }
  })
  it('refuses mutation and prototype-shaped channel names', () => {
    const read = createPreviewBackend()
    for (const channel of [
      'restartCore',
      'mihomoHotReloadConfig',
      'triggerSysProxy',
      'patchControledMihomoConfig',
      'setControlDns',
      'enableAutoRun',
      'downloadAndInstallUpdate',
      '__proto__',
      'constructor',
      'toString'
    ]) {
      expect(() => read(channel)).toThrow()
    }
  })
  it('keeps preview state isolated from attempted external mutation', () => {
    const read = createPreviewBackend()
    const config = read('getAppConfig') as { useSubStore: boolean }
    config.useSubStore = true
    expect(read('getAppConfig')).toMatchObject({ useSubStore: false })
  })
  it('retains sidebar resizing in memory for the existing config read path', () => {
    const backend = createPreviewBackend()
    for (const siderWidth of [60, 70, 250, 328.5, 400]) {
      expect(backend('patchAppConfig', { siderWidth })).toBeUndefined()
      expect(backend('getAppConfig')).toMatchObject({ siderWidth })
    }
    expect(createPreviewBackend()('getAppConfig')).toMatchObject({ siderWidth: 250 })
  })
  it('rejects mixed view and network patches atomically', () => {
    const backend = createPreviewBackend()
    const original = backend('getAppConfig')
    for (const setting of [
      { autoSetDNS: true },
      { useSubStore: true },
      { enableTrafficLogger: true },
      { autoCheckUpdate: true },
      { sysProxy: { enable: true } },
      { tun: { enable: true } },
      { __proto__: { autoSetDNS: true }, unknown: true },
      JSON.parse('{"__proto__":{"autoSetDNS":true}}')
    ]) {
      expect(() => backend('patchAppConfig', { siderWidth: 300, ...setting })).toThrow()
      expect(backend('getAppConfig')).toEqual(original)
    }
  })
  it('rejects invalid view input without changing state', () => {
    const backend = createPreviewBackend()
    const original = backend('getAppConfig')
    for (const value of [
      undefined,
      null,
      [],
      {},
      { siderWidth: '300' },
      { siderWidth: NaN },
      { siderWidth: Infinity },
      { siderWidth: -1 },
      { siderWidth: 249 },
      { siderWidth: 401 }
    ]) {
      expect(() => backend('patchAppConfig', value)).toThrow()
      expect(backend('getAppConfig')).toEqual(original)
    }
  })
  it('matches the actual preload whitelist to fallback, explicit, and delegated channels', () => {
    const source = readFileSync('src/preload/index.ts', 'utf8')
      .split('const validInvokeChannels = [')[1]
      .split('] as const')[0]
    const main = readFileSync('src/main/relay/index.ts', 'utf8')
    expect(main).toContain('registerAppUpdateIPC(ipcMain, trusted, appUpdates)')
    const channels = expandChannelList(source)
    expect(new Set(channels)).toEqual(
      new Set([...relayUpstreamChannels, ...explicitChannels(main), ...APP_UPDATE_IPC_CHANNELS])
    )
    expect(channels).toHaveLength(new Set(channels).size)
  })
  it('registers a handler only once even when the legacy fallback inventory overlaps', () => {
    const main = readFileSync('src/main/relay/index.ts', 'utf8')
    const special = new Set(
      expandChannelList(main.split('const special = new Set([')[1].split('])')[0])
    )
    const registered = [...explicitChannels(main), ...APP_UPDATE_IPC_CHANNELS]
    const fallback = new Set<string>(
      relayUpstreamChannels.filter((channel) => !special.has(channel))
    )
    expect(registered).toHaveLength(new Set(registered).size)
    expect(registered.filter((channel) => fallback.has(channel))).toEqual([])
    expect(
      relayUpstreamChannels.filter(
        (channel) => special.has(channel) && !registered.includes(channel)
      )
    ).toEqual([])
  })
  it('uses a separate production entry without live lifecycle imports', () => {
    const source = readFileSync('src/main/relay/index.ts', 'utf8')
    expect(source).not.toMatch(/from ['"]\.\.\/(?:core|config|lifecycle|index|sys)/)
    expect(source).toContain("'Relay-Preview'")
    expect(source).toContain('networkChangesAllowed: false')
    expect(source).not.toContain('startCore(')
  })
})

describe('Renderer request scope', () => {
  const root = '/Applications/Relay.app/Contents/Resources/app.asar/out/renderer'
  it('allows only packaged file assets and in-memory UI schemes', () => {
    for (const url of [
      `file://${root}/index.html`,
      `file://${root}/assets/main.js`,
      'data:image/png;base64,AA==',
      'blob:null/uuid'
    ]) {
      expect(allowedPreviewRequest(url, root)).toBe(true)
    }
  })
  it('blocks remote, localhost, websocket and unrelated local files', () => {
    for (const url of [
      'https://api.anthropic.com',
      'http://127.0.0.1:7890',
      'ws://127.0.0.1:9090',
      'file:///Users/fixture/.claude/settings.json',
      `file://${root}-other/secret`,
      `file://${root}/../main/index.js`,
      'file://example.com/secret',
      'invalid'
    ]) {
      expect(allowedPreviewRequest(url, root)).toBe(false)
    }
  })
})

describe('Native preview input', () => {
  it('accepts valid input and trims the node', () => {
    expect(validatePreviewInput({ ...input, node: ' fixture-node ' }).node).toBe('fixture-node')
  })
  it('rejects invalid ports, builtins, malformed shapes and large data', () => {
    for (const port of [-1, 0, 65536, 17890, 1.5, '7890', null])
      expect(() => validatePreviewInput({ ...input, httpPort: port })).toThrow()
    for (const node of ['', 'DIRECT', 'REJECT-DROP', 'GLOBAL', 'n\nnode', 'n,node'])
      expect(() => validatePreviewInput({ ...input, node })).toThrow()
    for (const value of [
      null,
      [],
      { ...input, existingJSON: {} },
      { ...input, existingJSON: 'x'.repeat(131073) }
    ])
      expect(() => validatePreviewInput(value)).toThrow()
  })
})
