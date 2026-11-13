import { createHash } from 'crypto'
import { mkdtemp, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TunHostObservation, TunSessionBinding } from './tun/service'

type TestEvent = { sender: unknown; senderFrame: unknown }
type Handler = (event: TestEvent, input?: unknown) => unknown

const mocks = vi.hoisted(() => {
  const mainFrame = {}
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    openDevTools: vi.fn(),
    send: vi.fn()
  }
  return {
    home: '',
    handlers: new Map<string, Handler>(),
    window: {
      webContents,
      on: vi.fn(),
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getNormalBounds: () => ({ x: 0, y: 0, width: 1180, height: 800 }),
      setMinimumSize: vi.fn(),
      setBounds: vi.fn(),
      removeListener: vi.fn(),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      loadFile: vi.fn().mockResolvedValue(undefined)
    },
    exit: vi.fn(),
    inspectTun: vi.fn(),
    takeChecked: vi.fn(),
    tunEvents: [] as string[],
    confirm: vi.fn(async () => ({ response: 1 }))
  }
})

vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    setPath: vi.fn(),
    getPath: (name: string) =>
      name === 'home'
        ? mocks.home
        : name === 'appData'
          ? join(mocks.home, 'Library', 'Application Support')
          : join(mocks.home, 'Library', 'Application Support', 'Relay-Preview'),
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    getVersion: () => '1.0.0',
    on: vi.fn(),
    quit: vi.fn(),
    exit: mocks.exit,
    isPackaged: false
  },
  BrowserWindow: class {
    constructor() {
      return mocks.window
    }
  },
  ipcMain: {
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler)
  },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  nativeTheme: { on: vi.fn(), removeListener: vi.fn(), themeSource: 'system' },
  screen: {
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  dialog: { showMessageBox: mocks.confirm },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  session: {
    defaultSession: {
      webRequest: { onBeforeRequest: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn()
    }
  }
}))
vi.mock('../utils/dirs', () => ({
  logPath: () => join(mocks.home, 'relay-fixture.log'),
  trafficUsageDatabasePath: () => join(mocks.home, 'relay-fixture.sqlite')
}))
vi.mock('../utils/logger', () => ({
  setAppLogSizeMiB: vi.fn(),
  mainWindowLogger: { info: vi.fn(async () => {}), error: vi.fn(async () => {}) }
}))
vi.mock('../traffic/database-worker?nodeWorker', () => ({
  default: () => {
    throw new Error('Traffic database worker is unavailable in the IPC fixture')
  }
}))
vi.mock('./native', () => ({ nativeReady: () => true, previewNative: vi.fn() }))
vi.mock('./configuration/service', async (original) => {
  const module = await original<typeof import('./configuration/service')>()
  return {
    ...module,
    createCompleteConfigurationService: (
      ...args: Parameters<typeof module.createCompleteConfigurationService>
    ) => ({ ...module.createCompleteConfigurationService(...args), takeChecked: mocks.takeChecked })
  }
})
vi.mock('./tun/transport', () => ({
  prepareTunDiagnostics: async () => {},
  readTunInstallation: async () => ({
    execution: 'core-managed',
    revision: 'a'.repeat(64),
    helperSHA256: 'b'.repeat(64),
    coreSHA256: 'c'.repeat(64),
    clientSHA256: 'd'.repeat(64)
  }),
  inspectTunNative: mocks.inspectTun,
  openTunNativeHost: async (
    _installed: unknown,
    _baseline: unknown,
    _runtime: unknown,
    binding: TunSessionBinding,
    _launch: unknown,
    register: (host: unknown) => void
  ) => {
    let phase: TunHostObservation['phase'] = 'idle'
    const observe = (): TunHostObservation => {
      const states: Record<
        string,
        [TunHostObservation['core'], TunHostObservation['device'], TunHostObservation['network']]
      > = {
        idle: ['none', 'none', 'unchanged'],
        acquired: ['none', 'held', 'unchanged'],
        coreReady: ['running', 'held', 'unchanged'],
        active: ['running', 'held', 'active'],
        coreStopped: ['stopped', 'held', 'active'],
        released: ['stopped', 'released', 'restored'],
        restored: ['stopped', 'absent', 'restored']
      }
      const [core, device, network] = states[phase]
      return { version: 1, ...binding, phase, core, device, network }
    }
    const action = (name: string, next: typeof phase) => async () => {
      mocks.tunEvents.push(name)
      phase = next
      return observe()
    }
    const host = {
      acquire: action('acquire', 'acquired'),
      startCore: action('startCore', 'active'),
      activate: action('activate', 'active'),
      inspect: async () => observe(),
      stopCore: action('stopCore', 'coreStopped'),
      release: action('release', 'released'),
      verifyRestored: action('verifyRestored', 'restored'),
      revokeActivation: async () => {
        mocks.tunEvents.push('revoke')
      },
      dispose: async () => {
        mocks.tunEvents.push('dispose')
      }
    }
    register(host)
    return host
  }
}))

const event: TestEvent = {
  sender: mocks.window.webContents,
  senderFrame: mocks.window.webContents.mainFrame
}

function invoke(channel: string, input?: unknown, caller = event): unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing test handler: ${channel}`)
  return handler(caller, input)
}

beforeAll(async () => {
  mocks.home = await realpath(await mkdtemp(join(tmpdir(), 'relay-ipc-fixture-')))
  vi.stubGlobal('__dirname', '/fixture/out/main')
  await import('./index')
  await vi.waitFor(() => expect(mocks.window.loadFile).toHaveBeenCalled())
  expect(mocks.exit).not.toHaveBeenCalled()
})
afterAll(async () => {
  vi.unstubAllGlobals()
  if (mocks.home) await rm(mocks.home, { recursive: true, force: true })
})

describe('Preview main-process IPC', () => {
  it('runs the registered complete-check handoff through TUN prepare/start/inspect/stop and preserves ownership gates', async () => {
    const hash = (s: string) => createHash('sha256').update(s).digest('hex')
    const configuration = {
        ipv6: false,
        port: 0,
        'allow-lan': false,
        mode: 'rule',
        'geo-auto-update': false,
        'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' },
        secret: 'PRIVATE',
        tun: {
          enable: true,
          device: 'utun',
          stack: 'gvisor',
          'auto-route': false,
          'auto-detect-interface': false,
          'dns-hijack': [],
          mtu: 1500
        },
        rules: ['MATCH,REJECT']
      },
      source = JSON.stringify(configuration),
      sha = hash(source),
      at = Date.now()
    const recheck = vi.fn(async () => {})
    mocks.takeChecked.mockImplementation(async (request) => {
      expect(request).toEqual({ evidenceId: '11111111-1111-4111-8111-111111111111' })
      return {
        configuration: source,
        configurationSHA256: sha,
        bundleSHA256: hash(JSON.stringify({ configuration, assets: [], pins: [], unresolved: [] })),
        expiresAt: at + 60_000,
        assets: [],
        pins: [],
        parser: {
          status: 'passed',
          scope: 'complete-parser',
          configurationSHA256: sha,
          coreVersion: 'v1.19.33',
          active: false,
          runtimeAccepted: false,
          warnings: []
        },
        recheck
      }
    })
    mocks.inspectTun.mockResolvedValue({
      helper: {
        version: 1,
        source: 'native',
        observedAt: at,
        revision: 'a'.repeat(64),
        state: 'ready',
        identity: 'authenticated',
        authorization: 'approved',
        rootOwned: true,
        runningAsRoot: false,
        execution: 'core-managed',
        privilegedCoreVerified: true,
        clientUID: process.getuid?.() ?? 501,
        helperSHA256: 'b'.repeat(64),
        coreSHA256: 'c'.repeat(64)
      },
      network: {
        version: 1,
        source: 'native',
        observedAt: at,
        state: 'observed',
        revision: 'd'.repeat(64),
        routesSHA256: 'e'.repeat(64),
        dnsSHA256: 'f'.repeat(64),
        interfacesSHA256: '1'.repeat(64),
        proxySHA256: '2'.repeat(64),
        protectionSHA256: '3'.repeat(64),
        existingTunnel: 'none',
        recovery: 'available'
      },
      baseline: { networkSHA256: '4'.repeat(64), protectionSHA256: '5'.repeat(64) }
    })
    const prepared = (await invoke('relayTunPrepare', {
      evidenceId: '11111111-1111-4111-8111-111111111111'
    })) as { evidenceId: string }
    expect(JSON.stringify(prepared)).not.toContain('PRIVATE')
    const started = (await invoke('relayTunStart', { evidenceId: prepared.evidenceId })) as {
      status: string
      state: { sessionId: string }
    }
    expect(started.status).toBe('started')
    expect(await invoke('relayTunInspect')).toMatchObject({
      phase: 'active',
      owned: true,
      protectionVerified: false
    })
    expect(() => invoke('relayCorePrepare', { mode: 'rule' })).toThrow('TUN')
    await expect(
      invoke('relayTunPrepare', { evidenceId: '11111111-1111-4111-8111-111111111111' })
    ).rejects.toThrow('TUN')
    expect(await invoke('relayTunStop', { sessionId: started.state.sessionId })).toMatchObject({
      status: 'restored',
      state: { owned: false, restorationVerified: true }
    })
    expect(mocks.tunEvents).toEqual([
      'startCore',
      'stopCore',
      'release',
      'verifyRestored',
      'dispose'
    ])
    expect(recheck).toHaveBeenCalled()
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('relayTunUpdated')
  })
  it('forwards the sidebar patch payload through the real registered handler', async () => {
    expect(await invoke('patchAppConfig', { siderWidth: 360 })).toBeUndefined()
    expect(invoke('getAppConfig')).toMatchObject({ siderWidth: 360 })
  })
  it('still refuses a combined sidebar and network patch without partial mutation', async () => {
    const before = invoke('getAppConfig')
    await expect(async () =>
      invoke('patchAppConfig', { siderWidth: 300, autoSetDNS: true })
    ).rejects.toThrow()
    expect(invoke('getAppConfig')).toEqual(before)
    expect(() => invoke('mihomoHotReloadConfig')).toThrow()
    expect(invoke('relayStatus')).toMatchObject({
      version: '1.0.0',
      coreRunning: false,
      networkChangesAllowed: false,
      guardEnabled: false
    })
  })
  it('refuses mode changes without an owned running core and keeps system writes locked', async () => {
    const coreBefore = await invoke('getControledMihomoConfig')
    const appBefore = invoke('getAppConfig')
    await expect(invoke('patchControledMihomoConfig', { mode: 'global' })).rejects.toThrow('启动')
    await expect(invoke('patchMihomoConfig', { mode: 'global' })).rejects.toThrow('启动')
    await expect(async () =>
      invoke('patchAppConfig', { sysProxy: { enable: true } })
    ).rejects.toThrow()
    await expect(invoke('mihomoCloseAllConnections')).rejects.toThrow()
    expect(await invoke('getControledMihomoConfig')).toEqual(coreBefore)
    expect(invoke('getAppConfig')).toEqual(appBefore)
  })
  it('rejects view updates from another window or a child frame', () => {
    const before = invoke('getAppConfig')
    for (const caller of [
      { sender: {}, senderFrame: event.senderFrame },
      { sender: event.sender, senderFrame: {} }
    ]) {
      expect(() => invoke('patchAppConfig', { siderWidth: 300 }, caller)).toThrow('Untrusted')
    }
    expect(invoke('getAppConfig')).toEqual(before)
  })
})
