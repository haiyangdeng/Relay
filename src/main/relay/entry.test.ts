import AdmZip from 'adm-zip'
import { app, Menu, type MenuItemConstructorOptions, type MessageBoxOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RelayObservation,
  RelaySavePreferencesRequest,
  RelayRecoveryInspection,
  RelayCodePreparation
} from '../../shared/relay/protocol'
import type { RelayCoreMode } from '../../shared/relay/core'
import type { LocalProxyRulesSnapshot, LocalResolverMode } from '../../shared/relay/local-proxy'
import type { DedicatedListenerPlan } from '../../shared/relay/dedicated-listeners'
import type { LocalProxyPlanRecord } from '../../shared/relay/local-proxy-plan'
import type { RelayStoredProfile } from '../../shared/relay/profiles'
import type { RelayRuntimeCheckResult } from '../../shared/relay/runtime'
import type { RelayBackupRecoveryPlan } from '../../shared/relay/backup'
import type {
  RelayRemoteBackupPlan,
  RelayRemoteBackupResult
} from '../../shared/relay/backup-remote'
import type {
  LegacyRelayInspection,
  LegacyRelayMigrationReport
} from '../../shared/relay/legacy-relay'
import type { RelayBackupAccount } from '../../shared/relay/backup-accounts'
import type { TunSessionState } from '../../shared/relay/tun'
import type { GeoOriginRecord } from '../../shared/relay/geo-origins'
import type { TunResourcesResult } from '../../shared/relay/tun-resources'
import type { TunRuleProvidersResult } from '../../shared/relay/tun-rule-providers'
import type {
  TunRuntimeRuleConfirmation,
  TunRuntimeRulesResult
} from '../../shared/relay/tun-rules'
import type { RelayWebdavBackupSchedulerState } from '../../shared/relay/backup-scheduler'
import type { RelayRuntimeGistSyncState } from '../../shared/relay/runtime-gist-sync'
import type {
  RelayRuntimeGistDiscoveryPlan,
  RelayRuntimeGistDiscoveryResult
} from '../../shared/relay/runtime-gist-discovery'
import type { RelayWebdavDirectoryPlan } from '../../shared/relay/backup-directory'
import type {
  OverrideLibraryBindings,
  OverrideLibraryFetchPlan,
  OverrideLibraryFetchResult,
  OverrideLibraryRecord
} from '../../shared/relay/override-library'
import { defaultShellSettings, type RelayShellAction } from '../../shared/relay/shell'
import type { createOnlineThemeService } from './shell/theme-service'
import type { TunRuleProviderConfirmation } from './tun/rule-providers'
import type { GeoAutomaticOwner, GeoAutomaticPermit } from './resources/automatic-permit'
import type { OwnedCoreRequestGuards } from './core/owned-runtime'
import { backupSnapshotSHA256 } from './backup/archive'
import { readOnlyFixture } from './__fixtures__/read-only'
import { preferenceFixture } from './__fixtures__/preferences'
import { recoveryFixture, preflightFixture } from './__fixtures__/recovery'
import { codeFixture, appliedCodeFixture } from './__fixtures__/code'
import { desktopReadinessFixture } from './__fixtures__/desktop-readiness'
import { desktopResponse } from './__fixtures__/desktop-session'
import { edgeFixture } from './__fixtures__/edge'
import { guardReadinessFixture } from './__fixtures__/guard'
import type { CoreStoreSnapshot } from './core/store'
import { profileRuntimeSource } from './__fixtures__/profile-runtime'
import { profileHash } from './profiles/source'
import { compileProfileRuntime } from './profiles/runtime'
import { inspectProfile } from './profiles/inspect'
import { localProxyConfiguration } from './core/local-proxy-runtime'
import type { RemoteBackupUploadGuards } from './backup/remote'
import type { TunRuntimeCaptureResult, TunResourceConfirmation } from './tun/service'
import type { TunInstallation } from './tun/transport'
import geodataCoreManifest from './core/geodata-manifest.json'
import officialCoreManifest from './core/manifest.json'
import type { createElectronShellHost } from './shell/electron-host'
type ThemeAdapters = Parameters<typeof createOnlineThemeService>[0]
type ShellHostOptions = Parameters<typeof createElectronShellHost>[0]

const fixture = vi.hoisted(() => {
  const frame = {}
  const webContents = {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    openDevTools: vi.fn(),
    send: vi.fn()
  }
  const window = {
    webContents,
    on: vi.fn(),
    loadFile: vi.fn(async () => {
      const ready = webContents.on.mock.calls.find(([name]) => name === 'ipc-message')?.[1]
      ready?.({ sender: webContents, senderFrame: frame }, 'rendererFirstContentReady')
    }),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    getNormalBounds: vi.fn(() => ({ x: 130, y: 50, width: 1180, height: 800 })),
    setMinimumSize: vi.fn(),
    setBounds: vi.fn(),
    hide: vi.fn(),
    maximize: vi.fn(),
    removeListener: vi.fn()
  }
  return {
    window,
    privateHome: '',
    browserChannels: [] as { dispose(): Promise<void> }[],
    startupWarn: vi.fn(async () => {}),
    packaged: false,
    knownNoRetainedCore: false,
    trayItems: [] as MenuItemConstructorOptions[],
    loginRead: vi.fn(),
    loginWrite: vi.fn(),
    automaticUninstallStart: vi.fn(),
    automaticUninstallStop: vi.fn(),
    automaticUninstallPrepare: vi.fn(),
    closePrivateBrowser: vi.fn(),
    handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
    afterBackupRestore: undefined as (() => void | Promise<void>) | undefined,
    writeBackupExport: undefined as
      ((bytes: Buffer, isCurrent: () => boolean) => Promise<boolean>) | undefined,
    geometryRead: vi.fn(),
    geometrySave: vi.fn(),
    backupStage: vi.fn(),
    backupDiscard: vi.fn(),
    backupCommit: vi.fn(),
    backupSnapshot: vi.fn(),
    backupArchive: vi.fn(),
    backupRecoveryList: vi.fn(),
    backupRecoveryPrepare: vi.fn(),
    backupRecoveryCommit: vi.fn(),
    backupRecoveryDiscard: vi.fn(),
    legacyPrepare: vi.fn(),
    legacyRecordPlan: vi.fn(),
    legacyRelayFactory: vi.fn(),
    legacyRelayInspect: vi.fn(),
    legacyRelayPrepare: vi.fn(),
    legacyRelayCancel: vi.fn(),
    legacyRelayRecord: vi.fn(),
    editRead: vi.fn(),
    editSave: vi.fn(),
    editClear: vi.fn(),
    editInherit: vi.fn(),
    libraryList: vi.fn(),
    libraryRead: vi.fn(),
    libraryCreate: vi.fn(),
    libraryMetadata: vi.fn(),
    libraryBody: vi.fn(),
    libraryRemove: vi.fn(),
    libraryFetched: vi.fn(),
    libraryAssertBindings: vi.fn(),
    accountRead: vi.fn(),
    accountList: vi.fn(),
    accountSave: vi.fn(),
    accountDisable: vi.fn(),
    accountCredential: vi.fn(),
    accountClearTrust: vi.fn(),
    receiptInspect: vi.fn(),
    receiptOpen: vi.fn(),
    receiptUploaded: vi.fn(),
    receiptBegin: vi.fn(),
    receiptFinish: vi.fn(),
    safeAvailable: vi.fn(() => true),
    safeEncrypt: vi.fn((text: string) => Buffer.from(text)),
    safeDecrypt: vi.fn((bytes: Buffer) => bytes.toString()),
    remoteDownload: vi.fn(),
    remoteUpload: vi.fn(),
    realBackupTransport: false,
    runtimeGistRequest: vi.fn(),
    copy: vi.fn(),
    write: vi.fn(async () => {}),
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async (_url: string) => {}),
    openBackupDirectory: vi.fn(async () => ({ status: 'requested', source: 'relay' })),
    desktopReadinessNative: vi.fn(),
    inspectEdgeNative: vi.fn(),
    openEdgeToolNative: vi.fn(),
    guardReadinessNative: vi.fn(),
    coreInspect: vi.fn(),
    coreAcquire: vi.fn(),
    coreUpdate: vi.fn(),
    coreRelease: vi.fn(),
    coreResources: vi.fn(),
    variantAcquire: vi.fn(),
    coreStart: vi.fn(),
    tunDiagnostics: vi.fn(async () => {}),
    themeAdapters: undefined as ThemeAdapters | undefined,
    downloadThemes: vi.fn<(_port: number, _signal: AbortSignal) => Promise<Buffer>>(),
    shellHostOptions: undefined as ShellHostOptions | undefined,
    shellApply: vi.fn(async () => {}),
    shellShowWindow: vi.fn(),
    shellShouldHide: vi.fn(() => false),
    shellSilentStart: false,
    tunOpen: vi.fn(),
    tunInspect: vi.fn(),
    tunReadInstallation:
      vi.fn<(execution?: 'core-managed') => Promise<TunInstallation | undefined>>(),
    tunStateOverride: undefined as TunSessionState | undefined,
    simulateTunRuntime: false,
    simulateTunRules: false,
    tunRulesRead: vi.fn<(raw: unknown, assertUI: () => void) => Promise<TunRuntimeRulesResult>>(),
    tunRuleChange: vi.fn<(raw: unknown, assertUI: () => void) => Promise<TunRuntimeRulesResult>>(),
    tunInvalidateRules: vi.fn(),
    simulateTunResources: false,
    simulateTunProviders: false,
    tunProvidersRead:
      vi.fn<(raw: unknown, assertUI: () => void) => Promise<TunRuleProvidersResult>>(),
    tunProviderReplace:
      vi.fn<(raw: unknown, assertUI: () => void) => Promise<TunRuleProvidersResult>>(),
    tunProviderConfirm: undefined as
      ((report: TunRuleProviderConfirmation) => Promise<boolean>) | undefined,
    tunResourcesRead: vi.fn<(raw: unknown, assertUI: () => void) => Promise<TunResourcesResult>>(),
    tunResourceReplace:
      vi.fn<(raw: unknown, assertUI: () => void) => Promise<TunResourcesResult>>(),
    tunInvalidateResources: vi.fn(),
    tunInvalidateInteractiveResources: vi.fn(),
    tunAutomaticOwner: vi.fn<(sessionId: string) => GeoAutomaticOwner | undefined>(),
    tunResourceScheduled:
      vi.fn<
        (
          raw: unknown,
          permit: GeoAutomaticPermit,
          assertScope: () => void
        ) => Promise<TunResourcesResult>
      >(),
    tunResourceConfirm: undefined as
      ((report: TunResourceConfirmation) => Promise<boolean>) | undefined,
    tunRuleConfirm: undefined as
      ((report: TunRuntimeRuleConfirmation) => Promise<boolean>) | undefined,
    tunCapture: vi.fn<(port: number, signal: AbortSignal) => Promise<TunRuntimeCaptureResult>>(),
    tunAssertRuntime: vi.fn(),
    coreStop: vi.fn(),
    localStart: vi.fn(),
    localStop: vi.fn(),
    localSelect: vi.fn(),
    localPort: vi.fn(),
    localOwnsListener: vi.fn(),
    localPatchMode: vi.fn(),
    localRulesRead: vi.fn<() => Promise<Record<string, unknown>>>(),
    localPatchRule:
      vi.fn<(index: number, disabled: boolean, guards: OwnedCoreRequestGuards) => Promise<void>>(),
    localReload: vi.fn(),
    coreUpdateRuntime: vi.fn(),
    profileSource: vi.fn(),
    profileSave: vi.fn(),
    profileList: vi.fn(),
    profileRead: vi.fn(),
    providerCacheSave: vi.fn(),
    providerCacheList: vi.fn(),
    providerCacheRead: vi.fn(),
    subscriptionDownload: vi.fn(),
    sourceList: vi.fn(),
    sourceRead: vi.fn(),
    sourceCreate: vi.fn(),
    sourceCommit: vi.fn(),
    resourceSave: vi.fn(),
    resourceRead: vi.fn(),
    resourceList: vi.fn(),
    resourceDownload: vi.fn(),
    binaryRead: vi.fn(),
    resolvePath: vi.fn(async (path: string) => path),
    resourceCheck: vi.fn(),
    resourceClosing: vi.fn(),
    originList: vi.fn(),
    originRead: vi.fn(),
    originSave: vi.fn(),
    originCommitHead: vi.fn(),
    selectedRoot: vi.fn<(root: string) => Promise<string>>(),
    mrsConvert: vi.fn(),
    profileCheck: vi.fn(),
    completeCheck: vi.fn(),
    runtimeScript: vi.fn(),
    coreRecordRecoveryNative: vi.fn(),
    readCoreSelectionNative: vi.fn(),
    saveCoreSelectionNative: vi.fn(),
    systemProxyNative: vi.fn(),
    verifyProxyTarget: vi.fn(async () => {}),
    probeNetwork: vi.fn(async () => ({
      networkSHA256: 'a'.repeat(64),
      protectionSHA256: 'b'.repeat(64),
      existingTunnel: false
    })),
    chooseOpen: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    openDesktopTransport: vi.fn(),
    desktopRequest: vi.fn(),
    chooseSave: vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined })),
    readFile: vi.fn(async () => 'bundled reference text'),
    readPreferencesNative: vi.fn(),
    savePreferencesNative: vi.fn(),
    recoveryStatusNative: vi.fn(),
    recoveryPreflightNative: vi.fn(),
    recoveryRestoreNative: vi.fn(),
    prepareCodeNative: vi.fn(),
    applyCodeNative: vi.fn(),
    openRelayBrowser: vi.fn(async () => ({
      status: 'requested',
      warnings: ['fixture browser request']
    })),
    confirmRestore: vi.fn(async (_window: unknown, _options: MessageBoxOptions) => ({
      response: 0,
      checkboxChecked: false
    })),
    appOn: vi.fn(),
    powerOn: vi.fn(),
    appQuit: vi.fn(),
    appRelaunch: vi.fn(),
    diagnoseNative: vi.fn(),
    edgeProfileNative: vi.fn(async () => ({
      profileXML: '<?xml?><plist/>',
      installed: false,
      warnings: ['未安装']
    })),
    guardPlanNative: vi.fn(async () => ({ plan: 'verified fixture plan', warnings: ['未部署'] })),
    previewNative: vi.fn(async () => ({
      settingsJSON: '{}',
      noProxy: 'localhost',
      plan: 'fixture plan',
      rules: 'rules: []',
      dns: 'dns: {}',
      listeners: 'listeners: []',
      warnings: ['未应用配置']
    })),
    simulateNative: vi.fn(async () => ({
      protected: false,
      rows: Array.from({ length: 10 }, () => ({
        name: 'fixture',
        expected: 'drop',
        actual: 'drop',
        passed: true
      })),
      warnings: ['只模拟策略']
    }))
  }
})

const savedBackupAccount: RelayBackupAccount = {
  id: '00000000-0000-4000-8000-000000000037',
  revision: 'f'.repeat(64),
  name: 'Saved WebDAV fixture',
  provider: 'webdav',
  proxyPort: 18191,
  directoryURL: 'https://dav.example/Relay/',
  username: 'fixture-user',
  state: 'active',
  hasCredential: true,
  createdAt: 1,
  updatedAt: 1
}

vi.mock('../utils/logger', () => ({
  mainWindowLogger: {
    info: vi.fn(async () => {}),
    warn: fixture.startupWarn,
    error: vi.fn(async () => {})
  },
  setAppLogSizeMiB: vi.fn()
}))

vi.mock('./network-info/network-observer', () => ({ inspectProbeNetwork: fixture.probeNetwork }))
vi.mock('./tun/transport', () => ({
  prepareTunDiagnostics: fixture.tunDiagnostics,
  openTunNativeHost: fixture.tunOpen,
  inspectTunNative: fixture.tunInspect,
  readTunInstallation: fixture.tunReadInstallation
}))
vi.mock('./tun/service', async (original) => {
  const actual = await original<typeof import('./tun/service')>()
  return {
    ...actual,
    createTunSessionService: (adapters: Parameters<typeof actual.createTunSessionService>[0]) => {
      const service = actual.createTunSessionService(adapters)
      fixture.tunRuleConfirm = adapters.confirmRule
      fixture.tunResourceConfirm = adapters.confirmResource
      fixture.tunProviderConfirm = adapters.confirmRuleProvider
      return {
        ...service,
        readRuleProviders: (raw: unknown, assertUI: () => void) =>
          fixture.simulateTunProviders
            ? fixture.tunProvidersRead(raw, assertUI)
            : service.readRuleProviders(raw, assertUI),
        replaceRuleProvider: (raw: unknown, assertUI: () => void) =>
          fixture.simulateTunProviders
            ? fixture.tunProviderReplace(raw, assertUI)
            : service.replaceRuleProvider(raw, assertUI),
        readResources: (raw: unknown, assertUI: () => void) =>
          fixture.simulateTunResources
            ? fixture.tunResourcesRead(raw, assertUI)
            : service.readResources(raw, assertUI),
        replaceResource: (raw: unknown, assertUI: () => void) =>
          fixture.simulateTunResources
            ? fixture.tunResourceReplace(raw, assertUI)
            : service.replaceResource(raw, assertUI),
        invalidateResources: () => {
          fixture.tunInvalidateResources()
          service.invalidateResources()
        },
        invalidateInteractiveResources: () => {
          fixture.tunInvalidateInteractiveResources()
          service.invalidateInteractiveResources()
        },
        automaticResourceOwner: (sessionId: string) =>
          fixture.simulateTunResources
            ? fixture.tunAutomaticOwner(sessionId)
            : service.automaticResourceOwner(sessionId),
        replaceResourceScheduled: (
          raw: unknown,
          permit: GeoAutomaticPermit,
          assertScope: () => void
        ) =>
          fixture.simulateTunResources
            ? fixture.tunResourceScheduled(raw, permit, assertScope)
            : service.replaceResourceScheduled(raw, permit, assertScope),
        readRules: (raw: unknown, assertUI: () => void) =>
          fixture.simulateTunRules
            ? fixture.tunRulesRead(raw, assertUI)
            : service.readRules(raw, assertUI),
        changeRule: (raw: unknown, assertUI: () => void) =>
          fixture.simulateTunRules
            ? fixture.tunRuleChange(raw, assertUI)
            : service.changeRule(raw, assertUI),
        invalidateRules: () => {
          fixture.tunInvalidateRules()
          service.invalidateRules()
        },
        captureRuntime: (port: number, signal: AbortSignal) =>
          fixture.simulateTunRuntime
            ? fixture.tunCapture(port, signal)
            : service.captureRuntime(port, signal),
        assertRuntime: (snapshot: Parameters<typeof service.assertRuntime>[0]) =>
          fixture.simulateTunRuntime
            ? fixture.tunAssertRuntime(snapshot)
            : service.assertRuntime(snapshot),
        state: () => fixture.tunStateOverride ?? service.state(),
        isBlocking: () =>
          fixture.tunStateOverride
            ? fixture.tunStateOverride.owned || fixture.tunStateOverride.pending
            : service.isBlocking()
      }
    }
  }
})

vi.mock('../utils/dirs', () => ({
  logPath: () => '/fake/home/relay-fixture.log',
  trafficUsageDatabasePath: () => '/fake/home/relay-fixture.sqlite'
}))
vi.mock('./resources/service', async (original) => {
  const actual = await original<typeof import('./resources/service')>()
  return {
    ...actual,
    createResourceService: (...args: Parameters<typeof actual.createResourceService>) => {
      const service = actual.createResourceService(...args)
      return {
        ...service,
        requestClose: () => {
          fixture.resourceClosing()
          return service.requestClose()
        }
      }
    }
  }
})
vi.mock('../traffic/database-worker?nodeWorker', () => ({
  default: () => {
    throw new Error('Traffic database worker is unavailable in the entry fixture')
  }
}))
vi.mock('./core-owner/runtime', async (original) => {
  const actual = await original<typeof import('./core-owner/runtime')>()
  return {
    ...actual,
    createCoreOwnerRuntime: (...args: Parameters<typeof actual.createCoreOwnerRuntime>) => {
      const owner = actual.createCoreOwnerRuntime(...args)
      return { ...owner, isBlocking: () => !fixture.knownNoRetainedCore && owner.isBlocking() }
    }
  }
})

vi.mock('./automatic-uninstall', () => ({
  startAutomaticUninstallMonitor: fixture.automaticUninstallStart,
  prepareAutomaticUninstall: fixture.automaticUninstallPrepare
}))
vi.mock('./private-browser-uninstall', () => ({
  closePrivateBrowserForUninstall: fixture.closePrivateBrowser
}))
vi.mock('./shell/login-item-registration', () => ({
  createLoginItemRegistration: ({
    legacy
  }: {
    legacy: { read(): { openAtLogin: boolean }; write(enabled: boolean): void }
  }) => ({ ...legacy, migrate: () => {} })
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: fixture.safeAvailable,
    encryptString: fixture.safeEncrypt,
    decryptString: fixture.safeDecrypt
  },
  screen: {
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  powerMonitor: { on: fixture.powerOn, removeListener: vi.fn() },
  app: {
    get isPackaged() {
      return fixture.packaged
    },
    getLoginItemSettings: fixture.loginRead,
    setLoginItemSettings: fixture.loginWrite,
    getVersion: () => '2.0.0-dev.3',
    setName: vi.fn(),
    setPath: vi.fn(),
    getPath: (name: string) =>
      name === 'home'
        ? '/fake/home'
        : name === 'appData'
          ? '/fake/home/Library/Application Support'
          : '/fake/home/Library/Application Support/Relay-Preview',
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => Promise.resolve(),
    on: fixture.appOn,
    quit: fixture.appQuit,
    relaunch: fixture.appRelaunch,
    exit: vi.fn()
  },
  BrowserWindow: class {
    constructor() {
      return fixture.window
    }
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
      if (fixture.handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`)
      fixture.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => fixture.handlers.delete(channel)
  },
  clipboard: { writeText: fixture.copy },
  shell: { openPath: fixture.openPath, openExternal: fixture.openExternal },
  dialog: {
    showSaveDialog: fixture.chooseSave,
    showMessageBox: fixture.confirmRestore,
    showOpenDialog: fixture.chooseOpen
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  session: {
    defaultSession: {
      webRequest: { onBeforeRequest: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn()
    }
  }
}))

vi.mock('./backup/key-file', () => ({ writeBackupKeyFile: fixture.write }))
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  const privatePath = (path: unknown): boolean =>
    typeof path === 'string' &&
    !!fixture.privateHome &&
    (path === fixture.privateHome || path.startsWith(fixture.privateHome + '/'))
  const privateOperation =
    (name: 'mkdir' | 'open' | 'chmod' | 'rename' | 'rm') =>
    (...args: unknown[]) => {
      if (!privatePath(args[0]) || (name === 'rename' && !privatePath(args[1])))
        throw new Error('Unexpected fixture filesystem mutation: ' + name)
      return (actual[name] as (...input: unknown[]) => unknown)(...args)
    }
  return {
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      privatePath(args[0]) ? actual.readFile(...args) : fixture.readFile(...args),
    realpath: (path: string) =>
      privatePath(path) ? actual.realpath(path) : fixture.resolvePath(path),
    mkdir: privateOperation('mkdir'),
    open: privateOperation('open'),
    chmod: privateOperation('chmod'),
    rename: privateOperation('rename'),
    rm: privateOperation('rm'),
    lstat: async (path: string, options?: { bigint?: boolean }) => {
      if (privatePath(path)) return actual.lstat(path, options)
      // Model an owned home without saved state. Probe and update startup must
      // distinguish this from an unknown owner or an unreadable directory.
      if (path !== '/fake/home')
        throw Object.assign(new Error('Fixture path is absent'), { code: 'ENOENT' })
      const uid = process.getuid?.() ?? -1
      return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: options?.bigint ? 0o40700n : 0o40700,
        uid: options?.bigint ? BigInt(uid) : uid
      }
    }
  }
})
vi.mock('../utils/safeFile', async (original) => {
  const actual = await original<typeof import('../utils/safeFile')>()
  return {
    ...actual,
    atomicWriteFile: (...args: Parameters<typeof actual.atomicWriteFile>) =>
      args[0].startsWith(fixture.privateHome + '/')
        ? actual.atomicWriteFile(...args)
        : fixture.write(...args)
  }
})
// Exercise the actual private-file and Unix binding checks under an owned
// temporary home; the simulated OS context must never create /fake/home.
vi.mock('./core/local-proxy-plan-store', async (original) => {
  const actual = await original<typeof import('./core/local-proxy-plan-store')>()
  return {
    LocalProxyPlanStore: class extends actual.LocalProxyPlanStore {
      constructor() {
        super({
          home: fixture.privateHome,
          stateRoot: fixture.privateHome + '/Library/Application Support/Relay-Preview'
        })
      }
    }
  }
})
vi.mock('./browser-binding', async (original) => {
  const actual = await original<typeof import('./browser-binding')>()
  return {
    createBrowserBindingChannel: (
      ...args: Parameters<typeof actual.createBrowserBindingChannel>
    ) => {
      const channel = actual.createBrowserBindingChannel(
        {
          home: fixture.privateHome,
          stateRoot: fixture.privateHome + '/Library/Application Support/Relay-Preview'
        },
        args[1]
      )
      fixture.browserChannels.push(channel)
      return channel
    }
  }
})
vi.mock('./native', () => ({
  nativeReady: () => true,
  previewNative: fixture.previewNative,
  simulateNative: fixture.simulateNative,
  diagnoseNative: fixture.diagnoseNative,
  edgeProfileNative: fixture.edgeProfileNative,
  guardPlanNative: fixture.guardPlanNative,
  readPreferencesNative: fixture.readPreferencesNative,
  savePreferencesNative: fixture.savePreferencesNative,
  recoveryStatusNative: fixture.recoveryStatusNative,
  recoveryPreflightNative: fixture.recoveryPreflightNative,
  recoveryRestoreNative: fixture.recoveryRestoreNative,
  prepareCodeNative: fixture.prepareCodeNative,
  applyCodeNative: fixture.applyCodeNative,
  desktopReadinessNative: fixture.desktopReadinessNative,
  inspectEdgeNative: fixture.inspectEdgeNative,
  openEdgeToolNative: fixture.openEdgeToolNative,
  guardReadinessNative: fixture.guardReadinessNative,
  coreRecordRecoveryNative: fixture.coreRecordRecoveryNative,
  readCoreSelectionNative: fixture.readCoreSelectionNative,
  saveCoreSelectionNative: fixture.saveCoreSelectionNative,
  systemProxyNative: fixture.systemProxyNative,
  backupMoveNative: vi.fn(),
  backupPublishNative: vi.fn(),
  backupFileNative: vi.fn()
}))
vi.mock('./system-proxy/target', () => ({ verifyProxyTarget: fixture.verifyProxyTarget }))
vi.mock('./browser', () => ({ openRelayBrowser: fixture.openRelayBrowser }))
vi.mock('./backup-directory', () => ({ openBackupDirectory: fixture.openBackupDirectory }))
vi.mock('./desktop-transport', () => ({ openDesktopTransport: fixture.openDesktopTransport }))
vi.mock('./core/store', () => ({
  CoreStore: class {
    inspect = fixture.coreInspect
    acquire = fixture.coreAcquire
  }
}))
vi.mock('./core/resources', () => ({ verifyCoreResource: fixture.coreResources }))
vi.mock('./backup/store', () => ({
  RelayBackupStore: class {
    stageRestore = fixture.backupStage
    discard = fixture.backupDiscard
    commitRestore = fixture.backupCommit
    snapshot = fixture.backupSnapshot
    archive = fixture.backupArchive
    unresolved = vi.fn(async () => [])
    listRecoveryRecords = fixture.backupRecoveryList
    prepareRecovery = fixture.backupRecoveryPrepare
    commitRecovery = fixture.backupRecoveryCommit
    discardRecovery = fixture.backupRecoveryDiscard
  }
}))
vi.mock('./backup/legacy-record', () => ({
  prepareLegacyMigrationRecord: fixture.legacyPrepare,
  prepareLegacyRelayMigrationRecord: fixture.legacyRelayRecord
}))
vi.mock('./backup/legacy-relay', () => ({
  createLegacyRelayMigration: (input: unknown) => {
    fixture.legacyRelayFactory(input)
    return {
      inspect: fixture.legacyRelayInspect,
      prepare: fixture.legacyRelayPrepare,
      cancel: fixture.legacyRelayCancel
    }
  }
}))
vi.mock('./backup/accounts-store', () => ({
  RelayBackupAccountsStore: class {
    read = fixture.accountRead
    list = fixture.accountList
    save = fixture.accountSave
    disable = fixture.accountDisable
    credential = fixture.accountCredential
    clearTrust = fixture.accountClearTrust
  }
}))
vi.mock('./backup/webdav-receipts', async (original) => ({
  ...(await original<typeof import('./backup/webdav-receipts')>()),
  RelayWebdavReceiptStore: class {
    inspect = fixture.receiptInspect
    open = fixture.receiptOpen
    recordUploaded = fixture.receiptUploaded
    beginDeletion = fixture.receiptBegin
    finishDeletion = fixture.receiptFinish
  }
}))
vi.mock('./backup/remote', async (original) => {
  const actual = await original<typeof import('./backup/remote')>()
  return {
    ...actual,
    createRemoteBackupTransport: () =>
      fixture.realBackupTransport
        ? actual.createRemoteBackupTransport()
        : { download: fixture.remoteDownload, upload: fixture.remoteUpload },
    GIST_ARCHIVE_MAX_BYTES: 512 * 1024
  }
})
vi.mock('./backup/service', async (original) => {
  const actual = await original<typeof import('./backup/service')>()
  return {
    ...actual,
    createBackupService: (adapters: Parameters<typeof actual.createBackupService>[0]) => {
      fixture.afterBackupRestore = adapters.afterRestore
      fixture.writeBackupExport = adapters.writeExport
      return actual.createBackupService(adapters)
    }
  }
})
vi.mock('./shell/window-state', async (original) => {
  const actual = await original<typeof import('./shell/window-state')>()
  return {
    ...actual,
    RelayWindowStateStore: class {
      read = fixture.geometryRead
      save = fixture.geometrySave
    }
  }
})
vi.mock('./shell/theme-download', () => ({ downloadOnlineThemes: fixture.downloadThemes }))
vi.mock('./shell/theme-service', async (original) => {
  const actual = await original<typeof import('./shell/theme-service')>()
  return {
    ...actual,
    createOnlineThemeService: (adapters: ThemeAdapters) => {
      fixture.themeAdapters = adapters
      return actual.createOnlineThemeService(adapters)
    }
  }
})
vi.mock('./shell/electron-host', () => ({
  createElectronShellHost: (options: ShellHostOptions) => {
    fixture.shellHostOptions = options
    return {
      ensureTray: vi.fn(),
      registerShortcut: () => true,
      unregisterShortcut: vi.fn(),
      apply: fixture.shellApply,
      perform: vi.fn(async (action: RelayShellAction) => {
        if (action === 'showWindow') {
          fixture.shellShowWindow()
          return
        }
        if (action === 'showFloatingWindow') return
        if (action === 'runInBackground') {
          options.backgroundChosen?.()
          return
        }
        return options.perform(action)
      }),
      showWindow: fixture.shellShowWindow,
      dispose: vi.fn(),
      setWorkflowMenu: vi.fn((items: MenuItemConstructorOptions[]) => {
        fixture.trayItems = items
      }),
      shouldHideOnClose: fixture.shellShouldHide,
      refreshMenu: vi.fn(),
      invalidateFloatingTraffic: vi.fn()
    }
  }
}))
vi.mock('./shell/store', async () => {
  const { defaultShellSettings } = await import('../../shared/relay/shell')
  return {
    RelayShellStore: class {
      record = {
        settings: { ...defaultShellSettings(), silentStart: fixture.shellSilentStart },
        revision: '',
        exists: false
      }
      async read() {
        return structuredClone(this.record)
      }
      async save(settings: ReturnType<typeof defaultShellSettings>, revision: string) {
        if (revision !== this.record.revision) throw new Error('revision')
        this.record = { settings: structuredClone(settings), revision: 'saved', exists: true }
        return structuredClone(this.record)
      }
    }
  }
})
vi.mock('./core/variant-store', () => ({
  VariantStore: class {
    async acquire(request: unknown) {
      await fixture.variantAcquire(request)
    }
    async resolveCoreRoot(root: string) {
      return fixture.selectedRoot(root)
    }
    async list() {
      return { records: [], activeCoreId: undefined, activeSmartId: undefined, pinnedDefault: true }
    }
  }
}))
vi.mock('./configuration/edit-store', () => ({
  ConfigurationEditStore: class {
    read = fixture.editRead
    save = fixture.editSave
    clear = fixture.editClear
    inherit = fixture.editInherit
  }
}))
vi.mock('./configuration/override-library-store', async (original) => ({
  ...(await original<typeof import('./configuration/override-library-store')>()),
  OverrideLibraryStore: class {
    list = fixture.libraryList
    read = fixture.libraryRead
    create = fixture.libraryCreate
    saveMetadata = fixture.libraryMetadata
    saveBody = fixture.libraryBody
    remove = fixture.libraryRemove
    saveFetched = fixture.libraryFetched
    assertBindings = fixture.libraryAssertBindings
  }
}))

vi.mock('./core/isolated-runtime', async (original) => ({
  ...(await original<typeof import('./core/isolated-runtime')>()),
  startIsolatedCore: fixture.coreStart
}))
vi.mock('./core/profile-check', () => ({ checkProfileRuntime: fixture.profileCheck }))
vi.mock('./configuration/checker', async (original) => ({
  ...(await original<typeof import('./configuration/checker')>()),
  checkCompleteConfiguration: fixture.completeCheck
}))
vi.mock('./configuration/script', () => ({ runConfigurationScript: fixture.runtimeScript }))
vi.mock('./subscriptions/source-transfer', () => ({
  transferSubscriptionSource: fixture.subscriptionDownload
}))
vi.mock('./subscriptions/transfer', async (original) => ({
  ...(await original<typeof import('./subscriptions/transfer')>()),
  downloadSubscription: fixture.subscriptionDownload
}))
vi.mock('./core/local-proxy-runtime', async (original) => ({
  ...(await original<typeof import('./core/local-proxy-runtime')>()),
  startLocalProxyCore: fixture.localStart
}))
vi.mock('./core/port', async (original) => ({
  ...(await original<typeof import('./core/port')>()),
  probeLocalPort: fixture.localPort,
  ownsHttpListener: fixture.localOwnsListener
}))
vi.mock('./profiles/store', () => ({
  ProfileStore: class {
    save
    list
    read
    constructor(_context: unknown, namespace = 'Configurations') {
      this.save =
        namespace === 'ProviderResources' ? fixture.providerCacheSave : fixture.profileSave
      this.list =
        namespace === 'ProviderResources' ? fixture.providerCacheList : fixture.profileList
      this.read =
        namespace === 'ProviderResources' ? fixture.providerCacheRead : fixture.profileRead
    }
  },
  ProfileWriteUncertain: class extends Error {}
}))
vi.mock('./subscriptions/source-store', () => ({
  SubscriptionSourceStore: class {
    list = fixture.sourceList
    read = fixture.sourceRead
    create = fixture.sourceCreate
    commit = fixture.sourceCommit
  },
  SubscriptionJournalUncertain: class extends Error {}
}))
vi.mock('./resources/store', () => ({
  ResourceStore: class {
    save = fixture.resourceSave
    read = fixture.resourceRead
    list = fixture.resourceList
  }
}))
vi.mock('./resources/origin-store', () => ({
  ResourceOriginStore: class {
    list = fixture.originList
    read = fixture.originRead
    readId = fixture.originRead
    save = fixture.originSave
    commitHead = fixture.originCommitHead
  }
}))
vi.mock('./resources/source', async (original) => ({
  ...(await original<typeof import('./resources/source')>()),
  readBinaryResource: fixture.binaryRead,
  downloadBinaryResource: fixture.resourceDownload
}))
vi.mock('./resources/checker', () => ({ checkResourceWithCore: fixture.resourceCheck }))
vi.mock('./resources/mrs-convert', () => ({ convertRuleMRS: fixture.mrsConvert }))
vi.mock('../resolve/plugin/http-client', async (original) => ({
  ...(await original<typeof import('../resolve/plugin/http-client')>()),
  requestOnce: fixture.runtimeGistRequest
}))
vi.mock('./profiles/source', async (original) => ({
  ...(await original<typeof import('./profiles/source')>()),
  pickProfileSource: fixture.profileSource
}))

function legacyRelayInspectionFixture(): LegacyRelayInspection {
  return {
    inspectionId: '00000000-0000-0000-0000-000000000039',
    origin: 'Relay-Preview',
    sourceSHA256: '6'.repeat(64),
    preparedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    profiles: [
      {
        id: '00000000-0000-0000-0000-000000000040',
        name: 'Old private profile',
        createdAt: '2026-10-24T00:00:00.000Z',
        sha256: '1'.repeat(64),
        revision: '2'.repeat(64),
        summary: { proxies: 0, groups: 0, rules: 1, proxyProviders: 0, ruleProviders: 0 }
      }
    ],
    incomplete: 0,
    warnings: []
  }
}
function legacyRelayReportFixture(): LegacyRelayMigrationReport {
  const inspected = legacyRelayInspectionFixture(),
    source = inspected.profiles[0]
  return {
    format: 'relay-legacy-profiles-v1',
    origin: inspected.origin,
    sourceSHA256: inspected.sourceSHA256,
    originalArchiveSHA256: '8'.repeat(64),
    containsSecrets: true,
    profiles: [
      {
        legacyId: source.id,
        legacySHA256: source.sha256,
        legacyRevision: source.revision,
        profileId: '00000000-0000-0000-0000-000000000041',
        profileSHA256: source.sha256
      }
    ],
    warnings: []
  }
}
function legacyRelayRecordFixture() {
  return {
    archiveBytes: Buffer.from('merged old Relay candidate'),
    migrationId: '00000000-0000-0000-0000-000000000042',
    expectedBaselineSHA256: backupSnapshotSHA256({ directories: [], entries: [] }),
    report: legacyRelayReportFixture(),
    recordPlan: fixture.legacyRecordPlan
  }
}
function libraryRecordFixture(): OverrideLibraryRecord {
  const remote = {
      url: 'https://overrides.example/PRIVATE/fixture.yaml?token=PRIVATE',
      proxyPort: 18191
    },
    content = 'log-level: info\n'
  return {
    revision: '4'.repeat(64),
    item: {
      id: '00000000-0000-4000-8000-000000000033',
      name: 'Remote library fixture',
      kind: 'yaml',
      type: 'remote',
      metadataRevision: '5'.repeat(64),
      bodyRevision: profileHash(content),
      bodyBytes: Buffer.byteLength(content),
      bodyState: 'current',
      createdAt: 1,
      metadataUpdatedAt: 1,
      bodyUpdatedAt: 1,
      lastFetchedAt: 1,
      remote,
      content,
      sourceFingerprint: profileHash('relay-override-source-v1\0' + JSON.stringify(remote))
    }
  }
}
beforeEach(async (context) => {
  const actualFS = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  fixture.privateHome = await actualFS.mkdtemp('/private/tmp/re-')
  fixture.appQuit.mockReset()
  fixture.appRelaunch.mockReset()
  fixture.automaticUninstallStop.mockReset()
  fixture.automaticUninstallPrepare.mockReset().mockResolvedValue(false)
  fixture.closePrivateBrowser.mockReset().mockResolvedValue(undefined)
  fixture.automaticUninstallStart
    .mockReset()
    .mockReturnValue({ stop: fixture.automaticUninstallStop })
  fixture.downloadThemes.mockReset()
  // The app constructs its schedulers during import, so install the clock
  // before that construction rather than after Date.now has been captured.
  if (
    context.task.suite?.name === 'WebDAV session backup scheduler entry' ||
    context.task.suite?.name === 'Runtime Gist automatic session sync entry' ||
    context.task.suite?.name === 'TUN runtime Gist source entry' ||
    context.task.suite?.name === 'WebDAV session-owned retention entry' ||
    context.task.suite?.name === 'Legacy WebDAV ZIP entry' ||
    context.task.suite?.name === 'Runtime Gist candidate discovery entry' ||
    context.task.suite?.name === 'Override library entry'
  )
    vi.useFakeTimers()
  fixture.variantAcquire.mockReset().mockResolvedValue(undefined)
  fixture.probeNetwork.mockReset().mockResolvedValue({
    networkSHA256: 'a'.repeat(64),
    protectionSHA256: 'b'.repeat(64),
    existingTunnel: false
  })
  fixture.verifyProxyTarget.mockClear()
  fixture.systemProxyNative
    .mockReset()
    .mockImplementation(async (_executable: string, _context: unknown, action: string) => ({
      status: 'inactive',
      revision: 'a'.repeat(64),
      location: 'Location-A',
      services: [
        {
          id: 'Wi-Fi',
          name: 'Wi-Fi',
          enabled: true,
          http: false,
          https: false,
          socks: false,
          pac: false
        }
      ],
      canApply: action === 'prepare',
      canRestore: false,
      currentProxyPorts: [],
      currentPacURLHashes: [],
      warnings: []
    }))
  fixture.readCoreSelectionNative.mockReset().mockResolvedValue({ revision: 'a'.repeat(64) })
  fixture.saveCoreSelectionNative
    .mockReset()
    .mockImplementation(
      async (
        _executable: string,
        _context: unknown,
        selection: { id: string; sha256: string }
      ) => ({ revision: 'b'.repeat(64), selection })
    )
  fixture.powerOn.mockClear()
  fixture.coreRecordRecoveryNative
    .mockReset()
    .mockResolvedValue({ status: 'clear', canArchive: false, warnings: [] })
  fixture.completeCheck.mockReset().mockImplementation(async (_root: string, source: string) => ({
    status: 'passed',
    scope: 'complete-parser',
    configurationSHA256: profileHash(source),
    active: false,
    runtimeAccepted: false,
    warnings: []
  }))
  fixture.runtimeScript
    .mockReset()
    .mockImplementation(
      async (_executable: string, _script: string, configuration: Record<string, unknown>) => ({
        configuration,
        logs: []
      })
    )
  vi.clearAllMocks()
  fixture.shellApply.mockReset().mockResolvedValue(undefined)
  fixture.shellShowWindow.mockReset()
  fixture.shellShouldHide.mockReset().mockReturnValue(false)
  fixture.shellSilentStart = false
  fixture.tunStateOverride = undefined
  fixture.tunReadInstallation.mockReset().mockResolvedValue(undefined)
  fixture.tunInspect.mockReset()
  fixture.simulateTunRuntime = false
  fixture.simulateTunRules = false
  fixture.tunRulesRead.mockReset()
  fixture.tunRuleChange.mockReset()
  fixture.tunInvalidateRules.mockReset()
  fixture.tunRuleConfirm = undefined
  fixture.simulateTunResources = false
  fixture.simulateTunProviders = false
  fixture.tunProvidersRead.mockReset()
  fixture.tunProviderReplace.mockReset()
  fixture.tunProviderConfirm = undefined
  fixture.tunResourcesRead.mockReset()
  fixture.tunResourceReplace.mockReset()
  fixture.tunInvalidateResources.mockReset()
  fixture.tunInvalidateInteractiveResources.mockReset()
  fixture.tunAutomaticOwner.mockReset()
  fixture.tunResourceScheduled.mockReset()
  fixture.tunResourceConfirm = undefined
  fixture.selectedRoot.mockReset().mockImplementation(async (root) => root)
  fixture.originList.mockReset().mockResolvedValue({ origins: [], incomplete: 0, warnings: [] })
  fixture.originRead.mockReset()
  fixture.originSave.mockReset()
  fixture.originCommitHead.mockReset()
  fixture.tunCapture.mockReset()
  fixture.tunAssertRuntime.mockReset()
  fixture.realBackupTransport = context.task.suite?.name === 'WebDAV session-owned retention entry'
  fixture.packaged = false
  fixture.loginRead.mockReset().mockReturnValue({ openAtLogin: false })
  fixture.loginWrite.mockReset().mockImplementation((settings: { openAtLogin: boolean }) => {
    fixture.loginRead.mockReturnValue({ openAtLogin: settings.openAtLogin })
  })
  vi.resetModules()
  fixture.handlers.clear()
  fixture.window.isVisible.mockReset().mockReturnValue(true)
  fixture.window.isDestroyed.mockReset().mockReturnValue(false)
  fixture.window.webContents.isDestroyed.mockReset().mockReturnValue(false)
  fixture.window.getNormalBounds
    .mockReset()
    .mockReturnValue({ x: 130, y: 50, width: 1180, height: 800 })
  fixture.geometryRead.mockReset().mockResolvedValue({
    revision: 'a'.repeat(64),
    writable: true,
    warnings: [],
    saved: {
      version: 1,
      normalBounds: { x: 130, y: 50, width: 1180, height: 800 },
      maximized: false
    }
  })
  fixture.geometrySave.mockReset().mockResolvedValue('b'.repeat(64))
  fixture.editRead.mockReset().mockResolvedValue({
    document: { globalOverrides: [], profileOverrides: [], controlled: {} },
    revision: '',
    exists: false
  })
  fixture.editSave.mockReset().mockImplementation(async (document) => {
    const record = { document, revision: 'e'.repeat(64), exists: true }
    fixture.editRead.mockResolvedValue(record)
    return record
  })
  fixture.editClear.mockReset().mockResolvedValue(undefined)
  fixture.editInherit.mockReset().mockResolvedValue(undefined)
  const library = libraryRecordFixture(),
    {
      remote: _libraryRemote,
      content: _libraryContent,
      sourceFingerprint: _source,
      ...item
    } = library.item
  fixture.libraryList.mockReset().mockResolvedValue({
    revision: library.revision,
    exists: true,
    items: [item]
  })
  fixture.libraryRead.mockReset().mockResolvedValue(library)
  fixture.libraryCreate.mockReset().mockResolvedValue(library)
  fixture.libraryMetadata.mockReset().mockResolvedValue(library)
  fixture.libraryBody.mockReset().mockResolvedValue(library)
  fixture.libraryRemove.mockReset().mockResolvedValue({
    revision: '6'.repeat(64),
    exists: true,
    items: []
  })
  fixture.libraryFetched.mockReset().mockImplementation(async (input: { content: string }) => ({
    ...library,
    revision: '6'.repeat(64),
    item: { ...library.item, content: input.content, bodyRevision: profileHash(input.content) }
  }))
  fixture.libraryAssertBindings.mockReset().mockResolvedValue(undefined)
  fixture.accountRead.mockReset().mockResolvedValue({ ...savedBackupAccount })
  fixture.accountList
    .mockReset()
    .mockResolvedValue({ accounts: [{ ...savedBackupAccount }], incomplete: 0 })
  fixture.accountSave.mockReset().mockResolvedValue({ ...savedBackupAccount })
  fixture.accountDisable
    .mockReset()
    .mockResolvedValue({ ...savedBackupAccount, state: 'disabled', revision: 'e'.repeat(64) })
  fixture.accountCredential
    .mockReset()
    .mockResolvedValue({ account: { ...savedBackupAccount }, secret: 'PRIVATE_SAVED_PASSWORD' })
  fixture.accountClearTrust.mockReset()
  fixture.receiptInspect.mockReset().mockImplementation(async (binding) => ({
    binding,
    scopeSHA256: profileHash(JSON.stringify(binding)),
    headSHA256: null,
    sequence: -1,
    owned: [],
    uncertain: []
  }))
  fixture.receiptOpen.mockReset()
  fixture.receiptUploaded.mockReset()
  fixture.receiptBegin.mockReset()
  fixture.receiptFinish.mockReset()
  fixture.backupStage.mockReset().mockImplementation(async () => ({
    id: '00000000-0000-0000-0000-000000000037',
    baselineSHA256: 'a'.repeat(64),
    targetSHA256: 'b'.repeat(64),
    archiveSHA256: 'c'.repeat(64),
    files: 1,
    replacedFiles: 1,
    removedFiles: 0,
    containsSecrets: true,
    preparedAt: Date.now()
  }))
  fixture.backupDiscard.mockReset()
  fixture.backupCommit.mockReset().mockResolvedValue('restored')
  fixture.backupSnapshot.mockReset().mockResolvedValue({ directories: [], entries: [] })
  fixture.backupArchive.mockReset().mockImplementation(async () => {
    const bytes = Buffer.from('PRIVATE-scheduled-backup')
    return { bytes, sha256: profileHash(bytes.toString()), files: 1 }
  })
  fixture.backupRecoveryList.mockReset().mockResolvedValue([
    {
      id: '00000000-0000-0000-0000-000000000037',
      version: 2,
      phase: 'uncertain',
      actions: ['resume', 'rollback'],
      containsSecrets: true
    }
  ])
  fixture.backupRecoveryPrepare
    .mockReset()
    .mockImplementation(async ({ id, action }: { id: string; action: 'resume' | 'rollback' }) => ({
      id,
      action,
      evidenceId: 'recovery-entry-proof',
      recordSHA256: 'a'.repeat(64),
      baselineSHA256: 'b'.repeat(64),
      targetSHA256: 'c'.repeat(64),
      currentSHA256: 'd'.repeat(64),
      files: 2,
      containsSecrets: true,
      preparedAt: Date.now(),
      expiresAt: Date.now() + 60000
    }))
  fixture.backupRecoveryCommit.mockReset().mockResolvedValue('restored')
  fixture.backupRecoveryDiscard.mockReset()
  fixture.legacyRecordPlan.mockReset().mockResolvedValue(undefined)
  fixture.legacyRelayFactory.mockReset()
  fixture.legacyRelayInspect.mockReset().mockResolvedValue(legacyRelayInspectionFixture())
  fixture.legacyRelayPrepare.mockReset()
  fixture.legacyRelayCancel.mockReset()
  fixture.legacyRelayRecord.mockReset().mockResolvedValue(legacyRelayRecordFixture())
  fixture.legacyPrepare.mockReset().mockResolvedValue({
    migrationId: '00000000-0000-0000-0000-000000000038',
    archiveBytes: Buffer.from('merged legacy fixture archive'),
    expectedBaselineSHA256: 'a'.repeat(64),
    report: {
      format: 'clash-party-legacy-zip',
      archiveSHA256: 'e'.repeat(64),
      containsSecrets: true,
      files: [],
      profiles: [],
      counts: {
        profiles: 1,
        sources: 0,
        overrides: 2,
        rulePatches: 1,
        applied: 4,
        retained: 1,
        'decision-required': 1
      }
    },
    recordPlan: fixture.legacyRecordPlan
  })
  fixture.remoteDownload.mockReset().mockResolvedValue(Buffer.from('validated fixture archive'))
  fixture.remoteUpload
    .mockReset()
    .mockImplementation(
      async (
        _request: unknown,
        _envelope: Buffer,
        _signal: AbortSignal,
        recheck?: () => Promise<void>,
        guards?: RemoteBackupUploadGuards
      ) => {
        await recheck?.()
        guards?.assertLive?.()
        guards?.submitted?.()
        return { status: 'uploaded' }
      }
    )
  fixture.runtimeGistRequest.mockReset().mockRejectedValue(new Error('Unexpected external request'))
  fixture.subscriptionDownload.mockReset().mockResolvedValue(profileRuntimeSource)
  fixture.sourceList.mockReset().mockResolvedValue({ sources: [], incomplete: 0, warnings: [] })
  fixture.sourceCreate.mockReset().mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000001',
    revision: 'a'.repeat(64),
    name: 'Fixture',
    origin: 'https://sub.invalid',
    proxyPort: 18191,
    createdAt: '2026-10-25',
    versions: [],
    locked: false
  })
  fixture.sourceRead.mockReset()
  fixture.sourceCommit.mockReset()
  fixture.resourceSave.mockReset()
  fixture.resourceRead.mockReset()
  fixture.resourceList.mockReset().mockResolvedValue({ resources: [], incomplete: 0, warnings: [] })
  fixture.resourceDownload.mockReset().mockResolvedValue(Buffer.from('fixture.invalid'))
  fixture.binaryRead.mockReset().mockResolvedValue(Buffer.from('body{color:red}'))
  fixture.resolvePath.mockReset().mockImplementation(async (path: string) => path)
  fixture.resourceCheck.mockReset()
  fixture.mrsConvert.mockReset()
  fixture.providerCacheSave.mockReset()
  fixture.providerCacheRead.mockReset()
  fixture.providerCacheList
    .mockReset()
    .mockResolvedValue({ profiles: [], incomplete: 0, activeId: null, warnings: [] })
  let localMember = 'Node',
    localChild: 'running' | 'stopped' = 'running'
  fixture.localPort.mockReset().mockResolvedValue(true)
  fixture.localOwnsListener.mockReset().mockResolvedValue(true)
  fixture.localPatchMode.mockReset()
  let localRuleDisabled = false
  fixture.localRulesRead.mockReset().mockImplementation(async () => ({
    rules: [
      {
        index: 0,
        type: 'Domain',
        payload: 'fixture.invalid',
        proxy: 'REJECT',
        size: 0,
        extra: { disabled: localRuleDisabled, hitCount: 0 }
      }
    ]
  }))
  fixture.localPatchRule.mockReset().mockImplementation(async (index, disabled, guards) => {
    guards.assertLive()
    if (index !== 0) throw new Error('Unknown fixture rule')
    guards.submitted?.()
    localRuleDisabled = disabled
  })
  fixture.localReload.mockReset()
  fixture.localStop.mockReset().mockImplementation(async () => {
    localChild = 'stopped'
  })
  fixture.localSelect.mockReset().mockImplementation(async (_group: string, member: string) => {
    localMember = member
  })
  fixture.localStart
    .mockReset()
    .mockImplementation(
      async (
        _root: string,
        source: string,
        port: number,
        register: (stop: () => Promise<void>) => void,
        mode: LocalResolverMode = 'off',
        dedicated?: DedicatedListenerPlan
      ) => {
        localChild = 'running'
        localMember = 'Node'
        let configuration = localProxyConfiguration(source, port, mode, dedicated).configuration
        fixture.localPatchMode.mockImplementation(async (next: RelayCoreMode) => {
          configuration = JSON.stringify({ ...JSON.parse(configuration), mode: next })
        })
        fixture.localReload.mockImplementation(async (next: string) => {
          configuration = next
          return { evidenceId: 'fixture-reload', runtimeSHA256: profileHash(next) }
        })
        register(fixture.localStop)
        return {
          pid: 4567,
          version: 'v1.19.33',
          directory: '/fixture/proxy',
          socket: '/fixture/proxy.sock',
          state: () => localChild,
          stop: fixture.localStop,
          patchMode: fixture.localPatchMode,
          patchRule: fixture.localPatchRule,
          reload: fixture.localReload,
          read: async (endpoint: string) =>
            endpoint === 'configs'
              ? JSON.parse(configuration)
              : endpoint === 'version'
                ? { version: 'v1.19.33' }
                : endpoint === 'rules'
                  ? fixture.localRulesRead()
                  : {
                      proxies: {
                        Group: { type: 'Selector', now: localMember, all: ['Node', 'DIRECT'] }
                      }
                    },
          group: async () => ({ now: localMember }),
          select: fixture.localSelect
        }
      }
    )
  const summary = inspectProfile(profileRuntimeSource).summary
  if (!summary) throw new Error('fixture summary missing')
  fixture.profileRead.mockReset().mockImplementation(async () => ({
    profile: {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource),
      name: 'Runtime fixture',
      createdAt: '2026-10-24',
      summary
    },
    text: profileRuntimeSource,
    revision: 'a'.repeat(64)
  }))
  fixture.profileCheck
    .mockReset()
    .mockImplementation(
      async (_root: string, source: string): Promise<RelayRuntimeCheckResult> => ({
        status: 'passed',
        scope: 'isolated-projection',
        fullSourceVerified: false,
        active: false,
        runtimeSHA256: profileHash(compileProfileRuntime(source).configuration ?? ''),
        version: 'v1.19.33',
        warnings: ['Not full source validation']
      })
    )
  fixture.chooseOpen.mockResolvedValue({ canceled: true, filePaths: [] })
  fixture.profileSource.mockResolvedValue({
    name: 'Local.yaml',
    text: 'mode: rule\nPRIVATE: keep\n',
    readAgain: async () => 'mode: rule\nPRIVATE: keep\n'
  })
  fixture.profileSave.mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Local.yaml',
    createdAt: '2026-10-24T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    summary: { proxies: 0, groups: 0, rules: 0, proxyProviders: 0, ruleProviders: 0 }
  } satisfies RelayStoredProfile)
  fixture.profileList.mockResolvedValue({
    profiles: [],
    incomplete: 0,
    activeId: null,
    warnings: []
  })
  fixture.coreInspect.mockResolvedValue({
    mode: 'rule',
    revision: 'a'.repeat(64),
    lease: 'missing'
  } satisfies CoreStoreSnapshot)
  fixture.coreUpdate.mockResolvedValue(undefined)
  fixture.coreRelease.mockResolvedValue(undefined)
  fixture.coreUpdateRuntime.mockReset().mockResolvedValue(undefined)
  fixture.coreAcquire.mockResolvedValue({
    update: fixture.coreUpdate,
    updateRuntime: fixture.coreUpdateRuntime,
    release: fixture.coreRelease
  })
  fixture.coreResources.mockResolvedValue({ version: 'v1.19.33' })
  fixture.coreStop.mockResolvedValue(undefined)
  fixture.coreStart.mockImplementation(
    async (_root: string, mode: RelayCoreMode, register: (stop: () => Promise<void>) => void) => {
      register(fixture.coreStop)
      return {
        pid: 1234,
        state: () => 'running',
        stop: fixture.coreStop,
        read: async () => ({
          mode,
          'allow-lan': false,
          tun: { enable: false },
          port: 0,
          'socks-port': 0,
          'mixed-port': 0,
          'redir-port': 0,
          'tproxy-port': 0
        })
      }
    }
  )
  fixture.chooseSave.mockResolvedValue({ canceled: true, filePath: undefined })
  fixture.diagnoseNative.mockResolvedValue(readOnlyFixture())
  fixture.readPreferencesNative.mockResolvedValue(preferenceFixture())
  fixture.recoveryStatusNative.mockResolvedValue(recoveryFixture())
  fixture.recoveryPreflightNative.mockResolvedValue(preflightFixture())
  fixture.recoveryRestoreNative.mockResolvedValue({
    status: 'restored',
    warnings: ['fixture restored']
  })
  fixture.prepareCodeNative.mockResolvedValue(codeFixture())
  fixture.applyCodeNative.mockResolvedValue(appliedCodeFixture())
  fixture.desktopReadinessNative.mockResolvedValue(desktopReadinessFixture())
  fixture.inspectEdgeNative.mockResolvedValue(edgeFixture())
  fixture.guardReadinessNative.mockResolvedValue(guardReadinessFixture())
  fixture.openEdgeToolNative.mockImplementation(async (_executable: string, action: string) => ({
    status: 'requested',
    action,
    installed: false,
    warnings: ['fixture not installed']
  }))
  fixture.desktopRequest.mockImplementation(async (action: string) =>
    desktopResponse(2, action === 'start' ? 'active' : 'idle', action === 'close')
  )
  fixture.openDesktopTransport.mockImplementation(() => ({
    ready: Promise.resolve(desktopResponse()),
    request: fixture.desktopRequest,
    gone: () => false
  }))
  fixture.confirmRestore.mockResolvedValue({ response: 0, checkboxChecked: false })
  fixture.savePreferencesNative.mockImplementation(
    async (_executable: string, request: RelaySavePreferencesRequest) => ({
      ...preferenceFixture(),
      preferences: request.preferences,
      source: 'relay',
      revision: 'b'.repeat(64)
    })
  )
  await import('./index')
  await vi.waitFor(() => expect(fixture.window.loadFile).toHaveBeenCalled())
})

afterEach(async () => {
  try {
    for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'closed') listener()
  } finally {
    await Promise.all(fixture.browserChannels.splice(0).map((channel) => channel.dispose()))
    const actualFS = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    await actualFS.rm(fixture.privateHome, { recursive: true, force: true })
  }
})

describe('Relay entry IPC integration with simulated OS adapters', () => {
  it('prepares diagnostics during startup without opening a native host or a core', () => {
    expect(fixture.tunDiagnostics).toHaveBeenCalledExactlyOnceWith()
    expect(fixture.tunOpen).not.toHaveBeenCalled()
    expect(fixture.tunInspect).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.accountList).not.toHaveBeenCalled()
    expect(fixture.accountCredential).not.toHaveBeenCalled()
    expect(fixture.safeAvailable).not.toHaveBeenCalled()
  })
  const event = () => ({
    sender: fixture.window.webContents,
    senderFrame: fixture.window.webContents.mainFrame
  })
  const invoke = (channel: string, input?: unknown): unknown => {
    const handler = fixture.handlers.get(channel)
    if (!handler) throw new Error('handler missing')
    return handler(event(), input)
  }
  it('reads workspace visibility only from the trusted main frame without changing startup state', () => {
    expect(invoke('relayWorkspaceVisible')).toBe(true)
    fixture.window.isVisible.mockReturnValue(false)
    expect(invoke('relayWorkspaceVisible')).toBe(false)
    expect(() => invoke('relayWorkspaceVisible', { visible: true })).toThrow('不接受参数')
    const handler = fixture.handlers.get('relayWorkspaceVisible')
    expect(() => handler?.({ sender: {}, senderFrame: {} })).toThrow('Untrusted')
    expect(() => handler?.({ sender: fixture.window.webContents, senderFrame: {} })).toThrow(
      'Untrusted'
    )
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('automatically drains an authenticated removal intent with the independent native after the app moves', async () => {
    fixture.knownNoRetainedCore = true
    fixture.loginRead.mockReturnValue({ openAtLogin: true })
    fixture.window.isVisible.mockReturnValue(false)
    const onRequested = fixture.automaticUninstallStart.mock.calls.at(-1)?.[0].onRequested
    expect(onRequested).toBeTypeOf('function')
    const executable = '/Library/Application Support/Relay/Uninstall/RelayNative'
    await onRequested(executable)
    expect(fixture.closePrivateBrowser).toHaveBeenCalledOnce()
    expect(fixture.loginWrite).toHaveBeenCalledWith({ openAtLogin: false })
    expect(fixture.appQuit).toHaveBeenCalledOnce()
    expect(() => invoke('relaySavePreferences', {})).toThrow('自动卸载')
    fixture.appQuit.mockClear()
    fixture.systemProxyNative.mockClear()
    const quit = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1]
    const prevented = vi.fn()
    quit({ preventDefault: prevented })
    expect(prevented).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    expect(fixture.systemProxyNative.mock.calls.every(([native]) => native === executable)).toBe(
      true
    )
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    for (const [name, listener] of fixture.appOn.mock.calls) if (name === 'quit') listener({}, 0)
    expect(fixture.automaticUninstallStop).toHaveBeenCalledOnce()
  })
  it('keeps the removal intent blocked and retryable if disabling the login item fails', async () => {
    fixture.loginWrite.mockImplementationOnce(() => {
      throw new Error('login unavailable')
    })
    const onRequested = fixture.automaticUninstallStart.mock.calls.at(-1)?.[0].onRequested
    const executable = '/Library/Application Support/Relay/Uninstall/RelayNative'
    await expect(onRequested(executable)).rejects.toThrow('login unavailable')
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(() => invoke('relaySavePreferences', {})).toThrow('自动卸载')
    await onRequested(executable)
    expect(fixture.appQuit).toHaveBeenCalledOnce()
  })
  it('retains the owned browser and recovery state until its graceful uninstall close is confirmed', async () => {
    fixture.closePrivateBrowser.mockRejectedValueOnce(new Error('private browser not closed'))
    const onRequested = fixture.automaticUninstallStart.mock.calls.at(-1)?.[0].onRequested
    const executable = '/Library/Application Support/Relay/Uninstall/RelayNative'
    await expect(onRequested(executable)).rejects.toThrow('private browser not closed')
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(fixture.loginWrite).not.toHaveBeenCalled()
    expect(() => invoke('relaySavePreferences', {})).toThrow('自动卸载')
    await onRequested(executable)
    expect(fixture.appQuit).toHaveBeenCalledOnce()
  })
  it('handles automatic uninstall preparation before ordinary bootstrap, actors or UI registration', async () => {
    const args = process.argv
    const resources = process.resourcesPath
    try {
      process.argv = ['/Applications/Relay.app/Contents/MacOS/Relay', '--relay-uninstall-prepare']
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: '/packaged/resources'
      })
      fixture.packaged = true
      fixture.automaticUninstallPrepare.mockResolvedValueOnce(true)
      fixture.automaticUninstallStart.mockClear()
      fixture.tunDiagnostics.mockClear()
      fixture.handlers.clear()
      vi.mocked(app.setPath).mockClear()
      vi.mocked(app.exit).mockClear()
      vi.resetModules()
      await import('./index')
      await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(0))
      expect(fixture.automaticUninstallPrepare).toHaveBeenCalledWith(
        expect.objectContaining({
          packaged: true,
          args: ['--relay-uninstall-prepare']
        })
      )
      expect(vi.mocked(app.setPath).mock.calls).toEqual([
        ['userData', '/fake/home/Library/Application Support/Relay-Preview'],
        ['sessionData', '/fake/home/Library/Application Support/Relay-Preview/Chromium']
      ])
      expect(fixture.tunDiagnostics).not.toHaveBeenCalled()
      expect(fixture.automaticUninstallStart).not.toHaveBeenCalled()
      expect(fixture.handlers.size).toBe(0)
    } finally {
      process.argv = args
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources })
    }
  })
  it('registers the diagnostic log preference on trusted exact-scope channels', async () => {
    await expect(invoke('relayAppLogSizeRead')).resolves.toEqual({ revision: '', sizeMiB: 10 })
    expect(() => invoke('relayAppLogSizeRead', { path: '/foreign/log' })).toThrow('不接受参数')
    expect(() =>
      invoke('relayAppLogSizeSave', { revision: '', sizeMiB: 8, path: '/foreign/log' })
    ).toThrow('偏好无效')
    expect(() =>
      fixture.handlers.get('relayAppLogSizeSave')?.({ sender: {}, senderFrame: {} })
    ).toThrow('Untrusted')
  })
  const localPreparation = async (
    dedicated?: DedicatedListenerPlan
  ): Promise<{ evidenceId: string }> => {
    const saved = (await invoke('relayLocalProxyPlanRead')) as LocalProxyPlanRecord
    await invoke('relayLocalProxyPlanSave', {
      expectedRevision: saved.revision,
      document: { httpPort: 18191, resolverMode: 'off', ...(dedicated ? { dedicated } : {}) }
    })
    return (await invoke('relayLocalProxyPrepare', {
      profile: {
        id: '00000000-0000-0000-0000-000000000001',
        sha256: profileHash(profileRuntimeSource)
      },
      httpPort: 18191,
      resolverMode: 'off',
      ...(dedicated ? { dedicated } : {})
    })) as { evidenceId: string }
  }
  describe('legacy dedicated pin before the first idle profile switch', () => {
    const plan = {
      httpPort: 18191,
      resolverMode: 'off',
      dedicated: { route: 'Node', httpPort: 17891, socksPort: 17890 }
    }
    const legacyPlan = async () => {
      await invoke('relayLocalProxyPlanSave', { expectedRevision: '', document: plan })
      const fs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
      const path =
        fixture.privateHome +
        '/Library/Application Support/Relay-Preview/Configuration/local-proxy-plan.json'
      await fs.writeFile(path, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 })
      return { fs, path }
    }
    it.each(['missing-node', 'different-same-name'])(
      'pins the previous selected source before selecting %s without starting a core',
      async (kind) => {
        const original = await fixture.profileRead()
        const text =
          kind === 'missing-node'
            ? original.text.replaceAll('Node', 'Other')
            : original.text.replace('127.0.0.1', '192.0.2.99')
        const candidate = {
          ...original,
          profile: {
            ...original.profile,
            id: '00000000-0000-0000-0000-000000000002',
            sha256: profileHash(text)
          },
          text,
          revision: 'b'.repeat(64)
        }
        fixture.profileRead.mockImplementation(async (selection) => {
          const stored = selection.id === original.profile.id ? original : candidate
          if (stored.profile.sha256 !== selection.sha256) throw new Error('stale profile')
          return stored
        })
        fixture.readCoreSelectionNative.mockResolvedValue({
          selection: { id: original.profile.id, sha256: original.profile.sha256 },
          revision: 'a'.repeat(64)
        })
        fixture.saveCoreSelectionNative.mockImplementation(
          async (_executable, _context, selection) => {
            const snapshot = { selection, revision: 'b'.repeat(64) }
            fixture.readCoreSelectionNative.mockResolvedValue(snapshot)
            return snapshot
          }
        )
        const { fs, path } = await legacyPlan()
        const before = await invoke('relayLocalProxyPlanRead')
        fixture.window.isVisible.mockReturnValue(false)
        await invoke('changeCurrentProfile', {
          id: candidate.profile.id,
          sha256: candidate.profile.sha256
        })
        fixture.window.isVisible.mockReturnValue(true)
        const saved = JSON.parse(await fs.readFile(path, 'utf8'))
        expect(saved.pinnedNode).toMatchObject({
          sourceProfileId: original.profile.id,
          node: { name: 'Node', server: '127.0.0.1' }
        })
        expect(await invoke('relayLocalProxyPlanRead')).toEqual(before)
        expect(fixture.localStart).not.toHaveBeenCalled()
        const preparation = invoke('relayLocalProxyPrepare', {
          profile: { id: candidate.profile.id, sha256: candidate.profile.sha256 },
          ...plan
        })
        if (kind === 'missing-node')
          await expect(preparation).resolves.toMatchObject({ canStart: true })
        else await expect(preparation).rejects.toThrow('本地代理准备未完成')
        expect(JSON.parse(await fs.readFile(path, 'utf8')).pinnedNode).toEqual(saved.pinnedNode)
        expect(fixture.localStart).not.toHaveBeenCalled()
      }
    )
    it.each(['missing', 'stale'])(
      'refuses a %s previous selection without binding a candidate or persisting selection',
      async (kind) => {
        const original = await fixture.profileRead()
        const candidate = { id: original.profile.id, sha256: original.profile.sha256 }
        fixture.readCoreSelectionNative.mockResolvedValue({
          revision: 'a'.repeat(64),
          ...(kind === 'stale'
            ? { selection: { id: '00000000-0000-0000-0000-000000000002', sha256: 'f'.repeat(64) } }
            : {})
        })
        fixture.profileRead.mockImplementation(async (selection) => {
          if (selection.id !== candidate.id) throw new Error('stale previous profile')
          return original
        })
        const { fs, path } = await legacyPlan()
        const bytes = await fs.readFile(path)
        await expect(invoke('changeCurrentProfile', candidate)).rejects.toThrow()
        expect(await fs.readFile(path)).toEqual(bytes)
        expect(fixture.saveCoreSelectionNative).not.toHaveBeenCalled()
        expect(fixture.localStart).not.toHaveBeenCalled()
      }
    )
    it('cannot bind a different same-name candidate through direct preparation before switching', async () => {
      const original = await fixture.profileRead()
      const text = original.text.replace('127.0.0.1', '192.0.2.99')
      const candidate = {
        ...original,
        profile: {
          ...original.profile,
          id: '00000000-0000-0000-0000-000000000002',
          sha256: profileHash(text)
        },
        text,
        revision: 'b'.repeat(64)
      }
      fixture.profileRead.mockImplementation(async (selection) =>
        selection.id === original.profile.id ? original : candidate
      )
      fixture.readCoreSelectionNative.mockResolvedValue({
        selection: { id: original.profile.id, sha256: original.profile.sha256 },
        revision: 'a'.repeat(64)
      })
      const { fs, path } = await legacyPlan()
      await expect(
        invoke('relayLocalProxyPrepare', {
          profile: { id: candidate.profile.id, sha256: candidate.profile.sha256 },
          ...plan
        })
      ).rejects.toThrow('本地代理准备未完成')
      expect(JSON.parse(await fs.readFile(path, 'utf8')).pinnedNode).toMatchObject({
        sourceProfileId: original.profile.id,
        node: { name: 'Node', server: '127.0.0.1' }
      })
      expect(fixture.saveCoreSelectionNative).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
    })
    it('refuses a dedicated plan change while an idle profile selection is being persisted', async () => {
      const original = await fixture.profileRead()
      const selection = { id: original.profile.id, sha256: original.profile.sha256 }
      const before = (await invoke('relayLocalProxyPlanRead')) as LocalProxyPlanRecord
      const pending = Promise.withResolvers<{ revision: string; selection: typeof selection }>()
      fixture.saveCoreSelectionNative.mockReturnValueOnce(pending.promise)
      const changing = invoke('changeCurrentProfile', selection)
      await vi.waitFor(() => expect(fixture.saveCoreSelectionNative).toHaveBeenCalledOnce())
      try {
        await expect(
          invoke('relayLocalProxyPlanSave', { expectedRevision: before.revision, document: plan })
        ).rejects.toThrow('配置选择')
        expect(await invoke('relayLocalProxyPlanRead')).toEqual(before)
      } finally {
        pending.resolve({ revision: 'b'.repeat(64), selection })
        await changing
      }
      expect(fixture.localStart).not.toHaveBeenCalled()
    })
  })
  describe('selected-profile startup Main wiring', () => {
    // The older fixture intentionally lacks DNS bootstrapping and is normally
    // used with resolverMode=off. Startup uses the supported profile DNS path.
    const startupSource = profileRuntimeSource.replace(
      /^dns:.*$/mu,
      'dns: {enable: true, nameserver: [1.1.1.1], default-nameserver: [1.1.1.1]}'
    )
    const reboot = async (beforeReady?: () => Promise<void>): Promise<void> => {
      let firstContentSent = false
      fixture.window.webContents.on.mockClear()
      fixture.window.on.mockClear()
      fixture.window.loadFile.mockClear().mockImplementationOnce(async () => {
        // Electron emits initial navigation before first-content-ready. It must
        // invalidate old renderer capabilities without cancelling this startup.
        for (const [name, listener] of fixture.window.webContents.on.mock.calls)
          if (name === 'did-start-navigation')
            listener({ isMainFrame: true, isSameDocument: false })
        await beforeReady?.()
        fixture.window.webContents.on.mock.calls.find(([name]) => name === 'ipc-message')?.[1](
          event(),
          'rendererFirstContentReady'
        )
        firstContentSent = true
      })
      fixture.handlers.clear()
      vi.resetModules()
      await import('./index')
      await vi.waitFor(() => expect(fixture.window.loadFile).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(firstContentSent).toBe(true))
    }
    const saved = async (): Promise<RelayStoredProfile> => {
      const stored = await fixture.profileRead()
      stored.text = startupSource
      stored.profile.sha256 = profileHash(startupSource)
      fixture.profileRead.mockResolvedValue(stored)
      fixture.readCoreSelectionNative.mockReset().mockResolvedValue({
        selection: { id: stored.profile.id, sha256: stored.profile.sha256 },
        revision: 'a'.repeat(64)
      })
      return stored.profile
    }
    it.each(['legacy', 'new'] as const)(
      'distinguishes a %s dedicated plan before default selection at cold startup',
      async (kind) => {
        const profile = await saved()
        const document = {
          httpPort: 18191,
          resolverMode: 'off',
          dedicated: { route: 'Node', httpPort: 17891, socksPort: 17890 }
        }
        await invoke('relayLocalProxyPlanSave', { expectedRevision: '', document })
        const fs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
        const path =
          fixture.privateHome +
          '/Library/Application Support/Relay-Preview/Configuration/local-proxy-plan.json'
        if (kind === 'legacy')
          await fs.writeFile(path, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
        const before = await fs.readFile(path)
        fixture.readCoreSelectionNative.mockResolvedValue({ revision: 'a'.repeat(64) })
        fixture.profileList.mockResolvedValue({
          profiles: [profile],
          incomplete: 0,
          activeId: null,
          warnings: []
        })
        fixture.saveCoreSelectionNative.mockImplementation(
          async (_executable, _context, selection) => {
            const snapshot = { selection, revision: 'b'.repeat(64) }
            fixture.readCoreSelectionNative.mockResolvedValue(snapshot)
            return snapshot
          }
        )
        await reboot()
        if (kind === 'legacy') {
          await vi.waitFor(() => expect(fixture.startupWarn).toHaveBeenCalledOnce())
          expect(fixture.saveCoreSelectionNative).not.toHaveBeenCalled()
          expect(fixture.localStart).not.toHaveBeenCalled()
          expect(await fs.readFile(path)).toEqual(before)
        } else {
          await vi.waitFor(() => expect(fixture.localStart).toHaveBeenCalledOnce())
          expect(fixture.saveCoreSelectionNative).toHaveBeenCalledOnce()
          expect(JSON.parse(await fs.readFile(path, 'utf8')).pinnedNode.sourceProfileId).toBe(
            profile.id
          )
          expect(fixture.startupWarn).not.toHaveBeenCalled()
        }
        expect(fixture.systemProxyNative).not.toHaveBeenCalled()
      }
    )
    it('starts the saved profile after initial navigation and content-ready, only once, without system takeover', async () => {
      const profile = await saved()
      await reboot()
      await vi.waitFor(() =>
        expect(invoke('relayLocalProxyState')).toMatchObject({
          profileId: profile.id,
          phase: 'running',
          httpPort: 18191,
          lifetime: 'main'
        })
      )
      expect(fixture.localStart).toHaveBeenCalledOnce()
      for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'show') listener()
      await Promise.resolve()
      expect(fixture.localStart).toHaveBeenCalledOnce()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
      expect(fixture.coreRecordRecoveryNative).not.toHaveBeenCalled()
    })
    it.each(['profile', 'source'] as const)(
      'waits for the first renderer %s-list read before starting the remembered profile',
      async (kind) => {
        const profile = await saved()
        let release!: () => void
        const listing = new Promise<void>((resolve) => {
          release = resolve
        })
        let reading: Promise<unknown> | undefined
        await reboot(async () => {
          // Loading a document is asynchronous; finish construction's resolved
          // inventory/cache work before simulating mounted renderer effects.
          await new Promise<void>((resolve) => setImmediate(resolve))
          // Install after construction's own inventory reads, immediately before
          // the route's readonly IPC; the first-content handshake then overlaps it.
          if (kind === 'profile')
            fixture.profileList.mockImplementationOnce(async () => {
              await listing
              return { profiles: [profile], incomplete: 0, activeId: null, warnings: [] }
            })
          else
            fixture.sourceList.mockImplementationOnce(async () => {
              await listing
              return { sources: [], incomplete: 0, warnings: [] }
            })
          reading = Promise.resolve(
            invoke(kind === 'profile' ? 'relayProfileList' : 'relaySourceList')
          )
          if (kind === 'source')
            expect(invoke('relaySourceState')).toMatchObject({ pending: true, phase: 'reading' })
        })
        await vi.waitFor(() => expect(fixture.readCoreSelectionNative).toHaveBeenCalled())
        // Drain promise-only selection/source reads without a production retry timer.
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(fixture.localStart).not.toHaveBeenCalled()
        release()
        await reading
        await vi.waitFor(() => expect(fixture.localStart).toHaveBeenCalledOnce())
        expect(invoke('relayLocalProxyState')).toMatchObject({
          owned: true,
          phase: 'running',
          profileId: profile.id
        })
        expect(fixture.startupWarn).not.toHaveBeenCalled()
        expect(fixture.systemProxyNative).not.toHaveBeenCalled()
        expect(fixture.tunOpen).not.toHaveBeenCalled()
        expect(fixture.coreStart).not.toHaveBeenCalled()
      }
    )
    it('waits for a profile list that begins during preparation before starting the core', async () => {
      const profile = await saved()
      let release!: () => void
      const listing = new Promise<void>((resolve) => {
        release = resolve
      })
      let reading: Promise<unknown> | undefined
      await reboot(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        fixture.coreInspect.mockImplementationOnce(async () => {
          fixture.profileList.mockImplementationOnce(async () => {
            await listing
            return { profiles: [profile], incomplete: 0, activeId: null, warnings: [] }
          })
          reading = Promise.resolve(invoke('relayProfileList'))
          return { mode: 'rule', revision: 'a'.repeat(64), lease: 'missing' }
        })
      })
      await vi.waitFor(() => expect(reading).toBeDefined())
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(invoke('relayLocalProxyState')).toMatchObject({
        phase: 'idle',
        pending: false,
        owned: false
      })
      expect(fixture.localStart).not.toHaveBeenCalled()
      release()
      await reading
      await vi.waitFor(() => expect(fixture.localStart).toHaveBeenCalledOnce())
      expect(fixture.startupWarn).not.toHaveBeenCalled()
    })
    it.each(['hide', 'manual-stop'] as const)(
      'does not start after %s supersedes the startup inventory wait',
      async (action) => {
        const profile = await saved()
        let release!: () => void
        const listing = new Promise<void>((resolve) => {
          release = resolve
        })
        let reading: Promise<unknown> | undefined
        await reboot(async () => {
          await new Promise<void>((resolve) => setImmediate(resolve))
          fixture.profileList.mockImplementationOnce(async () => {
            await listing
            return { profiles: [profile], incomplete: 0, activeId: null, warnings: [] }
          })
          reading = Promise.resolve(invoke('relayProfileList'))
        })
        await vi.waitFor(() => expect(fixture.readCoreSelectionNative).toHaveBeenCalled())
        await new Promise<void>((resolve) => setImmediate(resolve))
        let stopping: Promise<unknown> | undefined
        if (action === 'hide') {
          fixture.window.isVisible.mockReturnValue(false)
          for (const [name, listener] of fixture.window.on.mock.calls)
            if (name === 'hide') listener()
        } else
          stopping = Promise.resolve(
            invoke('relayLocalProxyAction', {
              action: 'stop',
              instanceId: '00000000-0000-0000-0000-000000000001'
            })
          ).catch(() => {})
        release()
        await Promise.all([reading, stopping])
        await new Promise<void>((resolve) => setImmediate(resolve))
        fixture.window.isVisible.mockReturnValue(true)
        for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'show') listener()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(fixture.localStart).not.toHaveBeenCalled()
        expect(fixture.startupWarn).not.toHaveBeenCalled()
        expect(invoke('relayLocalProxyState')).toMatchObject({ owned: false })
        expect(fixture.systemProxyNative).not.toHaveBeenCalled()
        expect(fixture.tunOpen).not.toHaveBeenCalled()
      }
    )
    it('does not wait through a profile write or retry startup after the write finishes', async () => {
      const profile = await saved()
      let finish!: (profile: RelayStoredProfile) => void
      let saving: Promise<unknown> | undefined
      await reboot(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        fixture.chooseOpen.mockResolvedValue({
          canceled: false,
          filePaths: ['/fixture/chosen.yaml']
        })
        const prepared = (await invoke('relayProfilePrepare')) as { evidenceId: string }
        fixture.profileSave.mockImplementationOnce(
          () =>
            new Promise<RelayStoredProfile>((resolve) => {
              finish = resolve
            })
        )
        saving = Promise.resolve(invoke('relayProfileSave', { evidenceId: prepared.evidenceId }))
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      })
      await vi.waitFor(() => expect(fixture.startupWarn).toHaveBeenCalledOnce())
      expect(fixture.localStart).not.toHaveBeenCalled()
      finish(profile)
      expect(await saving).toMatchObject({ status: 'saved' })
      for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'show') listener()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.startupWarn).toHaveBeenCalledOnce()
    })
    it('does not undo a manual stop issued before initial content-ready', async () => {
      await saved()
      await reboot(async () => {
        await Promise.resolve(
          invoke('relayLocalProxyAction', {
            action: 'stop',
            instanceId: '00000000-0000-0000-0000-000000000001'
          })
        ).catch(() => {})
      })
      await vi.waitFor(() => expect(fixture.shellApply).toHaveBeenCalled())
      await Promise.resolve()
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.readCoreSelectionNative).not.toHaveBeenCalled()
    })
    it('keeps the selected running core on window close and drains it only on explicit app quit', async () => {
      await saved()
      await reboot()
      await vi.waitFor(() => expect(fixture.localStart).toHaveBeenCalledOnce())
      const close = fixture.window.on.mock.calls.find(([name]) => name === 'close')?.[1]
      const preventDefault = vi.fn()
      close({ preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(fixture.window.hide).toHaveBeenCalledOnce()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.appQuit).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
      expect(invoke('relayLocalProxyState')).toMatchObject({ owned: true, phase: 'running' })
      const quit = fixture.appOn.mock.calls.filter(([name]) => name === 'before-quit').at(-1)?.[1]
      quit({ preventDefault: vi.fn() })
      await vi.waitFor(() => expect(fixture.localStop).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
      expect(fixture.systemProxyNative.mock.calls.every((call) => call[2] === 'inspect')).toBe(true)
    })
    it('remembers and starts the first available main profile when no saved choice exists', async () => {
      const profile = await saved()
      fixture.readCoreSelectionNative.mockResolvedValue({ revision: 'a'.repeat(64) })
      fixture.profileList.mockResolvedValue({
        profiles: [profile],
        incomplete: 0,
        activeId: null,
        warnings: []
      })
      fixture.saveCoreSelectionNative.mockImplementation(
        async (_executable, _context, selection) => {
          const snapshot = { selection, revision: 'b'.repeat(64) }
          fixture.readCoreSelectionNative.mockResolvedValue(snapshot)
          return snapshot
        }
      )
      await reboot()
      await vi.waitFor(() =>
        expect(invoke('relayLocalProxyState')).toMatchObject({
          profileId: profile.id,
          phase: 'running',
          httpPort: 18191,
          lifetime: 'main'
        })
      )
      expect(await invoke('getProfileConfig')).toMatchObject({ current: profile.id })
      expect(fixture.saveCoreSelectionNative).toHaveBeenCalledOnce()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('defers a silent launch until first show, without cancelling startup at its initial hide or retrying later', async () => {
      await saved()
      fixture.shellApply.mockImplementationOnce(async () => {
        fixture.window.isVisible.mockReturnValue(false)
        for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'hide') listener()
      })
      await reboot()
      await vi.waitFor(() => expect(fixture.shellApply).toHaveBeenCalled())
      expect(fixture.localStart).not.toHaveBeenCalled()
      fixture.window.isVisible.mockReturnValue(true)
      for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'show') listener()
      await vi.waitFor(() => expect(fixture.localStart).toHaveBeenCalledOnce())
      for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'hide') listener()
      for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'show') listener()
      expect(fixture.localStart).toHaveBeenCalledOnce()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
    })
    it('uses the available latest subscription version rather than an older historical first inventory item', async () => {
      const latest = await saved(),
        older = { ...latest, id: '00000000-0000-0000-0000-000000000002' }
      fixture.readCoreSelectionNative.mockResolvedValue({ revision: 'a'.repeat(64) })
      fixture.profileList.mockResolvedValue({
        profiles: [older, latest],
        incomplete: 0,
        activeId: null,
        warnings: []
      })
      fixture.sourceList.mockResolvedValue({
        sources: [{ versions: [{ profile: older }, { profile: latest }] }],
        incomplete: 0,
        warnings: []
      })
      fixture.saveCoreSelectionNative.mockImplementation(
        async (_executable, _context, selection) => {
          const snapshot = { selection, revision: 'b'.repeat(64) }
          fixture.readCoreSelectionNative.mockResolvedValue(snapshot)
          return snapshot
        }
      )
      await reboot()
      await vi.waitFor(() =>
        expect(invoke('relayLocalProxyState')).toMatchObject({
          profileId: latest.id,
          phase: 'running'
        })
      )
      expect(fixture.saveCoreSelectionNative.mock.calls[0][2]).toEqual({
        id: latest.id,
        sha256: latest.sha256
      })
      expect(fixture.localStart).toHaveBeenCalledOnce()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('waits for an auto read to cancel before selecting a manually chosen profile and never starts the old choice', async () => {
      const profile = await saved()
      const selected = { ...profile, id: '00000000-0000-0000-0000-000000000002' }
      let finishRead!: () => void
      fixture.readCoreSelectionNative.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishRead = resolve
        })
        return { selection: { id: profile.id, sha256: profile.sha256 }, revision: 'a'.repeat(64) }
      })
      await reboot()
      await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'))
      fixture.profileRead.mockImplementation(async (selection) => ({
        profile: selection?.id === selected.id ? selected : profile,
        text: startupSource,
        revision: 'b'.repeat(64)
      }))
      const choosing = invoke('changeCurrentProfile', { id: selected.id, sha256: selected.sha256 })
      finishRead()
      await choosing
      expect(await invoke('getProfileConfig')).toMatchObject({ current: selected.id })
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
    })
    it('cancels pending automatic preparation when the main document navigates again', async () => {
      await saved()
      let finishInspect!: () => void
      fixture.coreInspect.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishInspect = resolve
        })
        return { mode: 'rule', revision: 'a'.repeat(64), lease: 'missing' }
      })
      await reboot()
      await vi.waitFor(() => expect(finishInspect).toBeTypeOf('function'))
      for (const [name, listener] of fixture.window.webContents.on.mock.calls)
        if (name === 'did-start-navigation') listener({ isMainFrame: true, isSameDocument: false })
      finishInspect()
      await vi.waitFor(() =>
        expect(invoke('relayLocalProxyState')).toMatchObject({ pending: false })
      )
      expect(fixture.localStart).not.toHaveBeenCalled()
      fixture.window.webContents.on.mock.calls.find(([name]) => name === 'ipc-message')?.[1](
        event(),
        'rendererFirstContentReady'
      )
    })
  })
  it('initializes once without silent-start after a delayed first screen and never repeats on refresh', async () => {
    vi.useFakeTimers()
    try {
      fixture.shellApply.mockClear()
      fixture.shellSilentStart = true
      fixture.window.webContents.on.mockClear()
      fixture.window.loadFile.mockImplementationOnce(async () => {})
      fixture.handlers.clear()
      vi.resetModules()
      await import('./index')
      await vi.waitFor(() =>
        expect(fixture.window.webContents.on).toHaveBeenCalledWith(
          'ipc-message',
          expect.any(Function)
        )
      )
      expect(fixture.shellApply).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(fixture.shellApply).not.toHaveBeenCalled()
      const signal = fixture.window.webContents.on.mock.calls.find(
        ([name]) => name === 'ipc-message'
      )?.[1]
      if (!signal) throw new Error('Missing renderer-ready handler')
      signal(event(), 'rendererFirstContentReady')
      await vi.waitFor(() =>
        expect(fixture.shellApply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ silentStart: true }),
          false
        )
      )
      expect(fixture.shellShowWindow).toHaveBeenCalled()
      const navigate = fixture.window.webContents.on.mock.calls.find(
        ([name]) => name === 'did-start-navigation'
      )?.[1]
      if (!navigate) throw new Error('Missing main-document navigation handler')
      navigate({ isMainFrame: true, isSameDocument: false })
      signal(event(), 'rendererFirstContentReady')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(fixture.shellApply).toHaveBeenCalledOnce()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
      expect(fixture.appQuit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('retains an owned session and keeps a renderer failure visible after silent-start finishes', async () => {
    const visibility: string[] = []
    let finishApply!: () => void
    fixture.shellSilentStart = true
    fixture.shellApply.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishApply = resolve
      })
      visibility.push('hidden-by-silent-start')
    })
    fixture.shellShowWindow.mockImplementation(() => {
      visibility.push('shown')
    })
    fixture.window.webContents.on.mockClear()
    fixture.window.loadFile.mockClear()
    fixture.handlers.clear()
    vi.resetModules()
    await import('./index')
    await vi.waitFor(() => expect(finishApply).toBeTypeOf('function'))
    expect(fixture.shellApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ silentStart: true }),
      true
    )
    const plan = await localPreparation()
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: plan.evidenceId })
    expect(invoke('relayLocalProxyState')).toMatchObject({ owned: true })
    const gone = fixture.window.webContents.on.mock.calls.find(
      ([name]) => name === 'render-process-gone'
    )?.[1]
    expect(gone).toBeTypeOf('function')
    gone()
    expect(visibility.at(-1)).toBe('shown')
    finishApply()
    await vi.waitFor(() => expect(visibility).toEqual(['shown', 'hidden-by-silent-start', 'shown']))
    expect(invoke('relayLocalProxyState')).toMatchObject({ owned: true })
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.coreStop).not.toHaveBeenCalled()
    expect(fixture.appQuit).not.toHaveBeenCalled()
  })
  const subscriptionPreparation = (): { evidenceId: string } =>
    invoke('relaySubscriptionPrepare', {
      name: 'Subscription fixture',
      url: 'https://subscription.invalid/PRIVATE?token=PRIVATE',
      proxyPort: 18191
    }) as { evidenceId: string }
  it('requires the read edit revision on renderer saves and clears before calling the shared document store', async () => {
    const document = { globalOverrides: [], profileOverrides: [], controlled: {} }
    await expect(invoke('relayConfigEditSave', document) as Promise<unknown>).rejects.toThrow(
      '已读取的版本'
    )
    await expect(invoke('relayConfigEditClear') as Promise<unknown>).rejects.toThrow('已读取的版本')
    expect(fixture.editSave).not.toHaveBeenCalled()
    expect(fixture.editClear).not.toHaveBeenCalled()
    expect(await invoke('relayConfigEditSave', { document, expectedRevision: '' })).toMatchObject({
      revision: 'e'.repeat(64)
    })
    expect(fixture.editSave).toHaveBeenCalledWith(document, '')
    await invoke('relayConfigEditClear', { expectedRevision: 'e'.repeat(64) })
    expect(fixture.editClear).toHaveBeenCalledWith('e'.repeat(64))
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.localStop).not.toHaveBeenCalled()
  })
  it('queues OS-delivered CPX without reading or replacing a draft and consumes it only on explicit preview', async () => {
    const opened = fixture.appOn.mock.calls.find((call) => call[0] === 'open-file')?.[1]
    if (!opened) throw new Error('Missing CPX OS entry.')
    const event = { preventDefault: vi.fn() },
      before = fixture.binaryRead.mock.calls.length
    expect(await invoke('relayPluginOpenedPending')).toBe(false)
    opened(event, 'https://foreign.invalid/plugin.cpx')
    expect(event.preventDefault).not.toHaveBeenCalled()
    opened(event, '/private/os-opened.cpx')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(fixture.binaryRead).toHaveBeenCalledTimes(before)
    expect(await invoke('relayPluginOpenedPending')).toBe(true)
    expect(() => invoke('relayPluginPreviewOpened', { path: '/renderer/choice.cpx' })).toThrow()
    const text = JSON.stringify({
      magic: 'CPXF',
      v: 2,
      spec: 'cpx-plugin/2',
      loginUrl: 'https://provider.example/authorize',
      provider: { name: 'Opened provider' }
    })
    fixture.binaryRead.mockResolvedValueOnce(Buffer.from(text))
    expect(await invoke('relayPluginPreviewOpened')).toMatchObject({ status: 'preview', text })
    expect(fixture.binaryRead).toHaveBeenCalledWith('/private/os-opened.cpx', false, 1024 * 1024)
    expect(await invoke('relayPluginOpenedPending')).toBe(false)
    expect(await invoke('relayPluginPreviewOpened')).toEqual({ status: 'cancelled' })
    expect(fixture.chooseOpen).not.toHaveBeenCalled()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('reads CPX only through the native picker and returns an inert public draft', async () => {
    expect(() => invoke('relayPluginPreviewFile', { sourcePath: '/renderer/choice.cpx' })).toThrow()
    expect(fixture.chooseOpen).not.toHaveBeenCalled()
    expect(await invoke('relayPluginPreviewFile')).toEqual({ status: 'cancelled' })
    const text = JSON.stringify({
      magic: 'CPXF',
      v: 2,
      spec: 'cpx-plugin/2',
      loginUrl: 'https://provider.example/authorize',
      provider: { name: 'Picked provider' }
    })
    fixture.chooseOpen.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/private/selected.cpx']
    })
    fixture.binaryRead.mockResolvedValueOnce(Buffer.from(text))
    const result = await invoke('relayPluginPreviewFile')
    expect(result).toMatchObject({
      status: 'preview',
      text,
      preview: { origins: ['https://provider.example'] }
    })
    expect(fixture.binaryRead).toHaveBeenCalledWith('/private/selected.cpx', false, 1024 * 1024)
    expect(JSON.stringify(result)).not.toContain('/private/selected.cpx')
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('routes a candidate import from one trusted action without activating or starting a core', async () => {
    const { UpdateCandidateStore } = await import('./updates/store')
    const { trustedUpdateCatalog, publicUpdateAsset } = await import('./updates/catalog')
    const asset = trustedUpdateCatalog().find((asset) => asset.target === 'core-alpha')
    if (!asset) throw new Error('Missing fixed Alpha asset.')
    const record = {
      ...publicUpdateAsset(asset),
      id: '00000000-0000-4000-8000-000000000039',
      payloadBytes: asset.payloadBytes,
      payloadSHA256: asset.payloadSHA256,
      stagedAt: 1,
      installed: false as const,
      applied: false as const
    }
    const resolve = vi
      .spyOn(UpdateCandidateStore.prototype, 'resolve')
      .mockResolvedValue({ record, path: '/private/verified-candidate' })
    try {
      const request = { id: record.id }
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      expect(await invoke('relayUpdateImportVariant', request)).toEqual({ status: 'imported' })
      expect(fixture.variantAcquire).toHaveBeenCalledExactlyOnceWith({
        kind: 'core',
        sourcePath: '/private/verified-candidate',
        architecture: asset.architecture,
        version: asset.version,
        sha256: asset.payloadSHA256,
        size: asset.payloadBytes
      })
      expect(fixture.coreStart).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(() =>
        fixture.handlers.get('relayUpdateImportVariant')?.({ sender: {}, senderFrame: {} }, request)
      ).toThrow('Untrusted')
    } finally {
      resolve.mockRestore()
    }
  })
  it('stores system proxy defaults through trusted portable-draft IPC without applying the OS proxy', async () => {
    const { SystemProxyDraftStore } = await import('./system-proxy/draft-store')
    const { defaultSystemProxyDraft, systemProxyDraftSaveRequest } =
      await import('../../shared/relay/system-proxy-draft')
    const nativeBefore = fixture.systemProxyNative.mock.calls.length
    const record = await invoke('relaySystemProxyDraftRead')
    expect(record).toEqual({ document: defaultSystemProxyDraft(), revision: '', exists: false })
    expect(() =>
      fixture.handlers.get('relaySystemProxyDraftRead')?.({ sender: {}, senderFrame: {} })
    ).toThrow('Untrusted')
    expect(() => invoke('relaySystemProxyDraftRead', {})).toThrow('不接受参数')
    const save = vi
      .spyOn(SystemProxyDraftStore.prototype, 'save')
      .mockImplementation(async (raw, assertCurrent, recheck) => {
        const request = systemProxyDraftSaveRequest(raw)
        assertCurrent?.()
        await recheck?.()
        return { document: request.document, revision: 'b'.repeat(64), exists: true }
      })
    try {
      const document = { ...defaultSystemProxyDraft(), host: 'proxy.example' }
      expect(await invoke('relaySystemProxyDraftSave', { document, expectedRevision: '' })).toEqual(
        { document, revision: 'b'.repeat(64), exists: true }
      )
      expect(save).toHaveBeenCalledWith(
        { document, expectedRevision: '' },
        expect.any(Function),
        expect.any(Function)
      )
      expect(() =>
        fixture.handlers.get('relaySystemProxyDraftSave')?.(
          { sender: {}, senderFrame: {} },
          { document, expectedRevision: '' }
        )
      ).toThrow('Untrusted')
      await expect(
        invoke('relaySystemProxyDraftSave', {
          document: { ...document, port: 7890 },
          expectedRevision: ''
        })
      ).rejects.toThrow('字段无效')
      expect(fixture.systemProxyNative.mock.calls.length).toBe(nativeBefore)
      expect(fixture.coreStart).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
    } finally {
      save.mockRestore()
    }
  })
  it('routes explicit system proxy preparation and direct submission with lost native acknowledgement without stopping a core', async () => {
    const read = await invoke('relaySystemProxyInspect')
    expect(read).toMatchObject({ status: 'inactive', canRestore: false })
    const plan = (await invoke('relaySystemProxyPrepare', {
      mode: 'manual',
      host: '127.0.0.1',
      port: 18191,
      socks: false,
      bypass: ['localhost'],
      excludeSimple: true,
      serviceIDs: ['Wi-Fi'],
      pacScript: ''
    })) as { evidenceId: string }
    expect(await invoke('relaySystemProxyExecute', { evidenceId: plan.evidenceId })).toMatchObject({
      status: 'uncertain'
    })
    expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual([
      'inspect',
      'prepare',
      'prepare',
      'apply'
    ])
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.verifyProxyTarget).toHaveBeenCalledTimes(2)
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.coreStop).not.toHaveBeenCalled()
  })
  it('wires power events to proof invalidation and observation-only resume without startup native recovery', async () => {
    expect(fixture.coreRecordRecoveryNative).not.toHaveBeenCalled()
    expect(fixture.readCoreSelectionNative).toHaveBeenCalledOnce()
    const plan = await localPreparation()
    const suspend = fixture.powerOn.mock.calls.find((call) => call[0] === 'suspend')?.[1],
      resume = fixture.powerOn.mock.calls.find((call) => call[0] === 'resume')?.[1]
    expect(suspend).toBeTypeOf('function')
    suspend()
    expect(invoke('relayCoreLifecycleState')).toMatchObject({ phase: 'asleep', observed: false })
    await expect(
      invoke('relayLocalProxyAction', { action: 'start', evidenceId: plan.evidenceId })
    ).rejects.toThrow()
    resume()
    await vi.waitFor(() =>
      expect(invoke('relayCoreLifecycleState')).toMatchObject({
        phase: 'awake',
        observed: true,
        core: 'none',
        localProxy: 'none'
      })
    )
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.coreRecordRecoveryNative).not.toHaveBeenCalled()
  })
  it('holds proxy lifecycle and subscription mutations while a real-system transaction acknowledgement is pending', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: true })
    const normal = fixture.systemProxyNative.getMockImplementation()
    if (!normal) throw new Error('Missing native fixture')
    let release: (() => void) | undefined
    fixture.systemProxyNative.mockImplementation(
      async (executable: string, context: unknown, action: string) => {
        const report = await normal(executable, context, action)
        if (action !== 'apply') return report
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return {
          ...report,
          status: 'applied',
          recordID: '00000000-0000-0000-0000-000000000001',
          revision: 'b'.repeat(64),
          canRestore: true
        }
      }
    )
    const plan = (await invoke('relaySystemProxyPrepare', {
      mode: 'manual',
      host: '127.0.0.1',
      port: 18191,
      socks: false,
      bypass: ['localhost'],
      excludeSimple: true,
      serviceIDs: ['Wi-Fi'],
      pacScript: ''
    })) as { evidenceId: string }
    const submitting = invoke('relaySystemProxyExecute', { evidenceId: plan.evidenceId })
    await vi.waitFor(() =>
      expect(fixture.systemProxyNative.mock.calls.some((call) => call[2] === 'apply')).toBe(true)
    )
    expect(() =>
      invoke('relayLocalProxyAction', {
        action: 'stop',
        instanceId: '00000000-0000-0000-0000-000000000001'
      })
    ).toThrow('系统代理')
    expect(() => subscriptionPreparation()).toThrow('结束')
    expect(fixture.localStop).not.toHaveBeenCalled()
    release?.()
    expect(await submitting).toMatchObject({ status: 'applied' })
  })
  it('restores a validated source choice through the ordinary list without starting or adopting a process', async () => {
    const stored = await fixture.profileRead()
    fixture.readCoreSelectionNative.mockResolvedValueOnce({
      selection: { id: stored.profile.id, sha256: stored.profile.sha256 },
      revision: 'a'.repeat(64)
    })
    expect(await invoke('getProfileConfig')).toMatchObject({ current: stored.profile.id })
    // Startup already read the empty saved preference; this explicit list read
    // now loads the new synthetic saved selection without re-running startup.
    expect(fixture.readCoreSelectionNative).toHaveBeenCalledTimes(2)
    expect(fixture.saveCoreSelectionNative).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('routes stale record preparation to native inspection and reports an unacknowledged archive without retry', async () => {
    fixture.coreRecordRecoveryNative.mockResolvedValue({
      status: 'stale',
      canArchive: true,
      revision: 'a'.repeat(64),
      warnings: []
    })
    const plan = (await invoke('relayCoreRecordPrepare')) as { evidenceId: string }
    expect(await invoke('relayCoreRecordArchive', { evidenceId: plan.evidenceId })).toMatchObject({
      status: 'uncertain'
    })
    expect(fixture.coreRecordRecoveryNative).toHaveBeenCalledTimes(3)
    expect(fixture.coreRecordRecoveryNative.mock.calls[0]?.[2]).toBe('inspect')
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('routes complete candidate preparation and a single-use parser check without exposing source bytes or launching a proxy', async () => {
    const source = 'rules: ["MATCH,REJECT"]'
    const read = await fixture.profileRead()
    fixture.profileRead.mockResolvedValue({ ...read, text: source })
    const plan = (await invoke('relayCompleteConfigurationPrepare', {
      profile: { id: read.profile.id, sha256: read.profile.sha256 },
      options: {
        globalOverrides: [{ id: 'J', kind: 'js', content: 'PRIVATE script' }],
        profileOverrides: [],
        controlled: {}
      },
      bindings: []
    })) as { evidenceId: string; readyForParserCheck: boolean }
    expect(plan.readyForParserCheck).toBe(true)
    expect(JSON.stringify(plan)).not.toContain('PRIVATE')
    expect(fixture.runtimeScript).toHaveBeenCalledOnce()
    expect(fixture.completeCheck).not.toHaveBeenCalled()
    expect(
      await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
    ).toMatchObject({
      status: 'passed',
      scope: 'complete-parser',
      active: false,
      runtimeAccepted: false
    })
    expect(fixture.completeCheck).toHaveBeenCalledOnce()
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
    await expect(
      invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
    ).rejects.toThrow()
    expect(() => invoke('relayCompleteConfigurationCancel', { path: '/PRIVATE' })).toThrow('不接受')
    await invoke('relayProviderResourceList')
    expect(fixture.providerCacheList).toHaveBeenCalledOnce()
  })
  it('prepares a TUN candidate from strict saved-profile identity without installing, saving or starting a core', async () => {
    const read = await fixture.profileRead(),
      source = JSON.stringify({ rules: ['MATCH,REJECT'] }),
      selection = { id: read.profile.id, sha256: profileHash(source) }
    fixture.profileRead.mockResolvedValue({
      ...read,
      profile: { ...read.profile, sha256: selection.sha256 },
      text: source
    })
    expect(() =>
      fixture.handlers.get('relayTunConfigurationPrepare')?.(
        { sender: {}, senderFrame: {} },
        selection
      )
    ).toThrow('Untrusted')
    await expect(
      invoke('relayTunConfigurationPrepare', { ...selection, options: { controlled: {} } })
    ).rejects.toThrow('只接受')
    const plan = (await invoke('relayTunConfigurationPrepare', selection)) as {
      evidenceId: string
      readyForParserCheck: boolean
    }
    expect(plan.readyForParserCheck).toBe(true)
    expect(
      await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
    ).toMatchObject({ status: 'passed', active: false })
    expect(JSON.parse(fixture.completeCheck.mock.calls[0][1]).tun).toMatchObject({
      enable: true,
      stack: 'mixed',
      'auto-route': true,
      'auto-detect-interface': true,
      'dns-hijack': []
    })
    await expect(invoke('relayTunPrepare', { evidenceId: plan.evidenceId })).rejects.toThrow(
      '尚未安装'
    )
    expect(fixture.editSave).not.toHaveBeenCalled()
    expect(fixture.tunOpen).not.toHaveBeenCalled()
    expect(fixture.tunInspect).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  describe('Default TUN parser profile entry', () => {
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
    const install = (profile: 'geo' | 'official') => {
      const value: TunInstallation = {
        execution: 'core-managed',
        revision: 'a'.repeat(64),
        helperSHA256: 'c586cd3ae1497630f63975c5a1b80e33bd8df1986b3eb7fcbe658936fe16e26d',
        clientSHA256: 'c586cd3ae1497630f63975c5a1b80e33bd8df1986b3eb7fcbe658936fe16e26d',
        coreSHA256: (profile === 'geo' ? geodataCoreManifest : officialCoreManifest).assets[
          architecture
        ].sha256
      }
      fixture.tunReadInstallation.mockResolvedValue(value)
      fixture.tunInspect.mockImplementation(async (installed: TunInstallation) => ({
        helper: {
          version: 1,
          source: 'native',
          observedAt: Date.now(),
          revision: installed.revision,
          state: 'ready',
          identity: 'authenticated',
          authorization: 'approved',
          rootOwned: true,
          runningAsRoot: false,
          execution: 'core-managed',
          privilegedCoreVerified: true,
          clientUID: process.getuid?.() ?? 0,
          helperSHA256: installed.helperSHA256,
          coreSHA256: installed.coreSHA256
        },
        network: {
          version: 1,
          source: 'native',
          observedAt: Date.now(),
          state: 'observed',
          revision: 'b'.repeat(64),
          routesSHA256: 'c'.repeat(64),
          dnsSHA256: 'd'.repeat(64),
          interfacesSHA256: 'e'.repeat(64),
          proxySHA256: 'f'.repeat(64),
          protectionSHA256: '1'.repeat(64),
          existingTunnel: 'none',
          recovery: 'available'
        },
        baseline: { networkSHA256: '2'.repeat(64), protectionSHA256: '3'.repeat(64) }
      }))
      return value
    }
    const prepare = async (tun = true) => {
      const read = await fixture.profileRead(),
        source = JSON.stringify({
          proxies: [{ name: 'Private node', type: 'direct' }],
          rules: ['MATCH,REJECT'],
          tun: {
            enable: tun,
            device: 'utun',
            stack: 'gvisor',
            'auto-route': false,
            'auto-detect-interface': false,
            'dns-hijack': [],
            'dns-mode': 'disabled'
          }
        })
      fixture.profileRead.mockResolvedValue({
        ...read,
        profile: { ...read.profile, sha256: profileHash(source) },
        text: source
      })
      fixture.completeCheck.mockImplementation(async (root: string, configuration: string) => ({
        status: 'passed',
        scope: 'complete-parser',
        configurationSHA256: profileHash(configuration),
        coreVersion: root.endsWith('/core-geodata-v1')
          ? geodataCoreManifest.version
          : root.endsWith('/core')
            ? officialCoreManifest.version
            : 'fixture-explicit-variant',
        active: false,
        runtimeAccepted: false,
        warnings: []
      }))
      return (await invoke('relayCompleteConfigurationPrepare', {
        profile: { id: read.profile.id, sha256: profileHash(source) },
        options: {
          globalOverrides: [],
          profileOverrides: [],
          controlled: {},
          controlDns: false,
          controlSniff: false
        },
        bindings: []
      })) as { evidenceId: string; resources: number }
    }
    it('uses installed Thin parser for a no-Geo TUN candidate through real check/take/plan without starting anything', async () => {
      install('geo')
      const plan = await prepare()
      expect(plan.resources).toBe(0)
      expect(
        await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'passed', coreVersion: geodataCoreManifest.version })
      const tun = await invoke('relayTunPrepare', { evidenceId: plan.evidenceId })
      expect(tun).toMatchObject({
        readyForConfirmation: true,
        canApply: false,
        active: false,
        issues: []
      })
      expect(fixture.completeCheck.mock.calls[0][0]).toMatch(/\/core-geodata-v1$/u)
      expect(fixture.tunReadInstallation).toHaveBeenCalledTimes(3)
      expect(fixture.tunInspect).toHaveBeenCalledOnce()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
      await expect(invoke('relayTunPrepare', { evidenceId: plan.evidenceId })).rejects.toThrow(
        '先完成'
      )
    })
    it('retains official installed Core parsing and consumes a matching official candidate only', async () => {
      install('official')
      const plan = await prepare()
      expect(
        await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'passed', coreVersion: officialCoreManifest.version })
      expect(await invoke('relayTunPrepare', { evidenceId: plan.evidenceId })).toMatchObject({
        readyForConfirmation: true,
        canApply: false
      })
      expect(fixture.completeCheck.mock.calls[0][0]).toMatch(/\/core$/u)
      expect(fixture.tunReadInstallation).toHaveBeenCalledTimes(3)
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('retains the official parser when the managed installation is absent', async () => {
      const plan = await prepare()
      expect(
        await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'passed', coreVersion: officialCoreManifest.version })
      expect(fixture.tunReadInstallation.mock.calls).toEqual([['core-managed'], ['core-managed']])
      expect(fixture.completeCheck.mock.calls[0][0]).toMatch(/\/core$/u)
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('does not probe installed TUN identity or replace default parsing for a non-TUN candidate', async () => {
      install('geo')
      const plan = await prepare(false)
      expect(
        await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'passed', coreVersion: officialCoreManifest.version })
      expect(fixture.tunReadInstallation).not.toHaveBeenCalled()
      expect(fixture.completeCheck.mock.calls[0][0]).toMatch(/\/core$/u)
    })
    it.each(['Alpha', 'Smart'])(
      'keeps an explicitly selected %s parser rather than substituting the installed Thin profile',
      async (kind) => {
        install('geo')
        const root = '/private/fixture/variants/' + kind
        fixture.selectedRoot.mockResolvedValue(root)
        const plan = await prepare()
        await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
        expect(fixture.completeCheck.mock.calls[0][0]).toBe(root)
        expect(fixture.tunReadInstallation).toHaveBeenCalledExactlyOnceWith('core-managed')
        expect(fixture.tunOpen).not.toHaveBeenCalled()
      }
    )
    it('does not fall back to an old parser when installed identity cannot be verified', async () => {
      fixture.tunReadInstallation.mockRejectedValueOnce(
        new Error('PRIVATE unsafe installed metadata')
      )
      const plan = await prepare()
      expect(
        await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'unavailable' })
      expect(fixture.completeCheck).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('rejects an installation profile change between parsing and private TUN preparation', async () => {
      install('geo')
      const plan = await prepare()
      expect(
        await invoke('relayCompleteConfigurationCheck', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'passed', coreVersion: geodataCoreManifest.version })
      install('official')
      await expect(invoke('relayTunPrepare', { evidenceId: plan.evidenceId })).rejects.toThrow(
        '固定核心解析'
      )
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
    })
  })

  it('keeps private subscription sources inert until the requested action persists the URL', async () => {
    expect(invoke('relaySourceState')).toMatchObject({ pending: false })
    expect(() => invoke('relaySourceState', {})).toThrow('不接受')
    expect(fixture.sourceList).toHaveBeenCalledOnce()
    fixture.sourceList.mockClear()
    const input = {
      name: 'Fixture',
      url: 'https://sub.invalid/PRIVATE?token=PRIVATE',
      proxyPort: 18191
    }
    let p = invoke('relaySourceRegisterPrepare', input) as { evidenceId: string }
    expect(JSON.stringify(p)).not.toContain('PRIVATE')
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(await invoke('relaySourceExecute', { evidenceId: p.evidenceId })).toMatchObject({
      status: 'saved'
    })
    expect(fixture.sourceCreate).toHaveBeenCalledWith(input)
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.subscriptionDownload).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('keeps resource setup inert until requested acquisition reports its adapter failure', async () => {
    expect(invoke('relayResourceState')).toMatchObject({ pending: false })
    expect(() => invoke('relayResourceState', {})).toThrow('不接受')
    expect(fixture.resourceList).not.toHaveBeenCalled()
    const plan = invoke('relayResourcePrepare', {
      descriptor: { name: 'Fixture', kind: 'rule-text', behavior: 'domain', selector: '' },
      source: {
        kind: 'http',
        url: 'https://resource.invalid/PRIVATE?token=PRIVATE',
        proxyPort: 18191,
        headers: {}
      },
      expectedSHA256: ''
    }) as { evidenceId: string }
    expect(JSON.stringify(plan)).not.toContain('PRIVATE')
    expect(await invoke('relayResourceAcquire', { evidenceId: plan.evidenceId })).toMatchObject({
      status: 'uncertain'
    })
    expect(fixture.resourceDownload).toHaveBeenCalledOnce()
    expect(fixture.resourceSave).toHaveBeenCalledOnce()
    expect(fixture.chooseOpen).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
  })
  it('previews only an explicitly selected rule cache without acquiring, confirming or activating', async () => {
    const bytes = Buffer.from('fixture.invalid\n'),
      info = {
        name: 'Preview',
        kind: 'rule-text',
        behavior: 'domain',
        selector: '',
        id: '00000000-0000-4000-8000-000000000001',
        sha256: profileHash(bytes.toString()),
        size: bytes.length,
        createdAt: '2026-11-02T00:00:00Z',
        integrity: 'notChecked'
      },
      selection = { id: info.id, sha256: info.sha256 }
    fixture.resourceRead.mockResolvedValue({ info, bytes, revision: 'a'.repeat(64) })
    await expect(invoke('relayResourcePreview', selection)).resolves.toMatchObject({
      resource: selection,
      text: bytes.toString(),
      converted: false,
      language: 'text'
    })
    expect(fixture.resourceRead).toHaveBeenCalledWith(selection, 2 * 1024 * 1024)
    for (const input of [{ path: '/private' }, { ...selection, path: '/private' }])
      await expect(invoke('relayResourcePreview', input)).rejects.toThrow()
    expect(fixture.resourceDownload).not.toHaveBeenCalled()
    expect(fixture.resourceSave).not.toHaveBeenCalled()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.tunOpen).not.toHaveBeenCalled()
  })
  it('keeps a hidden MRS preview pending through actual converter settlement and discards its body', async () => {
    const bytes = Buffer.from('private MRS fixture'),
      info = {
        name: 'Preview',
        kind: 'rule-mrs',
        behavior: 'domain',
        selector: '',
        id: '00000000-0000-4000-8000-000000000001',
        sha256: profileHash(bytes.toString()),
        size: bytes.length,
        createdAt: '2026-11-02T00:00:00Z',
        integrity: 'notChecked'
      },
      finish = Promise.withResolvers<{ entries: string[]; sourceRules: number }>()
    fixture.resourceRead.mockResolvedValue({ info, bytes, revision: 'a'.repeat(64) })
    fixture.mrsConvert.mockImplementationOnce(async () => finish.promise)
    const pending = invoke('relayResourcePreview', { id: info.id, sha256: info.sha256 }),
      rejected = expect(pending).rejects.toThrow('预览未确认')
    try {
      await vi.waitFor(() => expect(fixture.mrsConvert).toHaveBeenCalledOnce())
      fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
      expect(invoke('relayResourceState')).toMatchObject({ phase: 'reading', pending: true })
      expect(() => invoke('relayProfilePrepare')).toThrow()
    } finally {
      finish.resolve({ entries: ['fixture.invalid'], sourceRules: 1 })
    }
    await rejected
    expect(invoke('relayResourceState')).toMatchObject({ pending: false })
    expect(fixture.resourceSave).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('waits for a resource check before quitting and blocks competing mutations', async () => {
    const bytes = Buffer.from('fixture.invalid\n'),
      info = {
        name: 'Fixture',
        kind: 'rule-text',
        behavior: 'domain',
        selector: '',
        id: '00000000-0000-0000-0000-000000000001',
        sha256: profileHash(bytes.toString()),
        size: bytes.length,
        createdAt: '2026-10-25',
        integrity: 'notChecked'
      }
    fixture.resourceRead.mockResolvedValue({ info, bytes, revision: 'a'.repeat(64) })
    let finish!: (result: { status: string; resourceSHA256: string; warnings: string[] }) => void
    fixture.resourceCheck.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = invoke('relayResourceCheck', { id: info.id, sha256: info.sha256 })
    await vi.waitFor(() => expect(finish).toBeDefined())
    for (const channel of [
      'relaySourceList',
      'relayCodeApply',
      'relayProfilePrepare',
      'relayProviderPrepare',
      'relaySubscriptionPrepare'
    ])
      await expect(async () => invoke(channel)).rejects.toThrow()
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1],
      preventDefault = vi.fn()
    quit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(fixture.resourceClosing).toHaveBeenCalledOnce())
    expect(fixture.appQuit).not.toHaveBeenCalled()
    finish({ status: 'passed', resourceSHA256: info.sha256, warnings: ['simulated'] })
    expect(await pending).toMatchObject({ status: 'cancelled' })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalled())
    expect(fixture.resourceSave).not.toHaveBeenCalled()
  })
  it('routes provider actions through trusted IPC and a separate cache without starting a core', async () => {
    const stored = await fixture.profileRead()
    const text = JSON.stringify({
      'proxy-providers': {
        P: { type: 'http', url: 'https://provider.invalid/PRIVATE?token=PRIVATE' }
      }
    })
    fixture.profileRead.mockResolvedValue({ ...stored, text })
    expect(invoke('relayProviderState')).toMatchObject({ pending: false })
    expect(() => invoke('relayProviderState', {})).toThrow('不接受')
    const profile = { id: stored.profile.id, sha256: stored.profile.sha256 }
    const inventory = await invoke('relayProvidersInspect', profile)
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE')
    expect(fixture.providerCacheList).toHaveBeenCalledOnce()
    expect(fixture.profileList).toHaveBeenCalledOnce()
    const plan = (await invoke('relayProviderPrepare', {
      profile,
      provider: 'P',
      proxyPort: 18191
    })) as { evidenceId: string }
    expect(await invoke('relayProviderAcquire', { evidenceId: plan.evidenceId })).toMatchObject({
      status: 'failed'
    })
    const batch = (await invoke('relayProviderBatchPrepare', {
      profile,
      providers: ['P'],
      proxyPort: 18191
    })) as { evidenceId: string }
    expect(JSON.stringify(batch)).not.toContain('PRIVATE')
    expect(invoke('relayProviderState')).toMatchObject({ batchPreparedId: batch.evidenceId })
    expect(
      await invoke('relayProviderBatchAcquire', { evidenceId: batch.evidenceId })
    ).toMatchObject({
      status: 'failed',
      items: [{ provider: 'P', status: 'failed' }]
    })
    expect(fixture.providerCacheSave).not.toHaveBeenCalled()
    expect(fixture.profileSave).not.toHaveBeenCalled()
    expect(fixture.subscriptionDownload).toHaveBeenCalledTimes(2)
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it.each(['navigation', 'in-page route change', 'window hide', 'renderer exit'] as const)(
    'cancels provider batch consent after %s',
    async (change) => {
      const stored = await fixture.profileRead()
      const text = JSON.stringify({
        'proxy-providers': {
          P: { type: 'http', url: 'https://provider.invalid/first' },
          Q: { type: 'http', url: 'https://provider.invalid/second' }
        }
      })
      fixture.profileRead.mockResolvedValue({ ...stored, text })
      const batch = (await invoke('relayProviderBatchPrepare', {
        profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
        providers: ['P', 'Q'],
        proxyPort: 18191
      })) as { evidenceId: string }
      const confirm = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
      fixture.confirmRestore.mockImplementationOnce(() => confirm.promise)
      const pending = invoke('relayProviderBatchAcquire', { evidenceId: batch.evidenceId })
      expect(invoke('relayProviderState')).toMatchObject({ phase: 'confirming', pending: true })
      try {
        if (change === 'window hide') {
          for (const [name, listener] of fixture.window.on.mock.calls) {
            if (name === 'hide') listener()
          }
        } else {
          for (const [name, listener] of fixture.window.webContents.on.mock.calls) {
            if (change === 'navigation' && name === 'did-start-navigation') {
              listener({ isMainFrame: true, isSameDocument: false })
            } else if (change === 'in-page route change' && name === 'did-navigate-in-page') {
              listener({}, 'file:///fixture.html#/relay?panel=profiles', true)
            } else if (change === 'renderer exit' && name === 'render-process-gone') listener()
          }
        }
      } finally {
        confirm.resolve({ response: 1, checkboxChecked: false })
      }
      expect(await pending).toMatchObject({
        status: 'cancelled',
        items: [
          { provider: 'P', status: 'skipped' },
          { provider: 'Q', status: 'skipped' }
        ]
      })
      expect(invoke('relayProviderState')).toMatchObject({ pending: false })
      expect(fixture.subscriptionDownload).not.toHaveBeenCalled()
      expect(fixture.providerCacheSave).not.toHaveBeenCalled()
    }
  )
  it('gates competing source operations and aborts its request before waiting for quit', async () => {
    const info = {
      id: '00000000-0000-0000-0000-000000000001',
      revision: 'a'.repeat(64),
      name: 'Fixture',
      origin: 'https://sub.invalid',
      proxyPort: 18191,
      createdAt: '2026-10-25',
      versions: [],
      locked: false
    }
    fixture.sourceRead.mockResolvedValue({
      info,
      request: { name: info.name, url: 'https://sub.invalid/PRIVATE', proxyPort: info.proxyPort },
      parent: null
    })
    let signal!: AbortSignal, finish!: (text: string) => void
    fixture.subscriptionDownload.mockImplementationOnce(
      async (_url: string, _port: number, abort: AbortSignal) => {
        signal = abort
        return new Promise<string>((resolve) => {
          finish = resolve
        })
      }
    )
    const plan = (await invoke('relaySourceUpdatePrepare', {
      id: info.id,
      revision: info.revision
    })) as { evidenceId: string }
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const pending = invoke('relaySourceExecute', { evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(invoke('relaySourceState')).toMatchObject({ pending: true, phase: 'downloading' })
    expect(() => invoke('relayConfigEditSave', { document: {}, expectedRevision: '' })).toThrow(
      '订阅来源'
    )
    expect(() => invoke('relayConfigEditClear', { expectedRevision: '' })).toThrow('订阅来源')
    expect(fixture.editSave).not.toHaveBeenCalled()
    expect(fixture.editClear).not.toHaveBeenCalled()
    for (const channel of [
      'relaySourceList',
      'relayCodeApply',
      'relayProfilePrepare',
      'relayProviderPrepare',
      'relaySubscriptionPrepare'
    ])
      await expect(async () => invoke(channel)).rejects.toThrow()
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1],
      preventDefault = vi.fn()
    quit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    finish(profileRuntimeSource)
    expect(await pending).toMatchObject({ status: 'cancelled' })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalled())
    expect(fixture.sourceCommit).not.toHaveBeenCalled()
    expect(fixture.profileSave).not.toHaveBeenCalled()
  })
  it('prepares a blank inactive configuration without a file picker and saves it on the requested action', async () => {
    const first = (await invoke('relayProfileNewPrepare', { name: 'Blank' })) as {
      evidenceId: string
    }
    expect(fixture.chooseOpen).not.toHaveBeenCalled()
    expect(fixture.profileSave).not.toHaveBeenCalled()
    expect(await invoke('relayProfileSave', { evidenceId: first.evidenceId })).toMatchObject({
      status: 'saved'
    })
    expect(fixture.profileSave).toHaveBeenCalledWith('Blank.json', expect.any(String))
    const text = fixture.profileSave.mock.calls[0][1]
    expect(JSON.parse(text)).not.toHaveProperty('tun')
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.systemProxyNative).not.toHaveBeenCalled()
  })
  it('exports selected source through a save-location input while the owned core remains running', async () => {
    const ready = await localPreparation()
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: ready.evidenceId })
    const selection = {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource)
    }
    await expect(
      invoke('relayProfileExport', { ...selection, path: '/renderer-path' }) as Promise<unknown>
    ).rejects.toThrow('只接受')
    fixture.confirmRestore.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await invoke('relayProfileExport', selection)).toEqual({ status: 'cancelled' })
    expect(fixture.chooseSave).toHaveBeenCalledOnce()
    fixture.chooseSave.mockResolvedValueOnce({ canceled: false, filePath: '/fake/exported.yaml' })
    expect(await invoke('relayProfileExport', selection)).toEqual({ status: 'exported' })
    expect(fixture.write).toHaveBeenCalledWith('/fake/exported.yaml', expect.any(Buffer), {
      mode: 0o600
    })
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.coreStop).not.toHaveBeenCalled()
    expect(fixture.profileSave).not.toHaveBeenCalled()
  })
  it('reads and prepares rule-provider definitions without resource reads or runtime activation', async () => {
    const selection = {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource)
    }
    expect(await invoke('relayProfileRuleProvidersRead', selection)).toMatchObject({
      providers: {}
    })
    const prepared = (await invoke('relayProfileRuleProvidersPrepare', {
      profile: selection,
      providers: { RP: { type: 'inline', behavior: 'domain', payload: ['example.test'] } }
    })) as { evidenceId: string }
    expect(await invoke('relayProfileSave', { evidenceId: prepared.evidenceId })).toMatchObject({
      status: 'saved'
    })
    expect(fixture.resourceDownload).not.toHaveBeenCalled()
    expect(fixture.resourceRead).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('routes MRS snapshot preparation through the fixed converter and direct save', async () => {
    const stored = await fixture.profileRead()
    const source =
      profileRuntimeSource +
      '\nrule-providers:\n  Cached:\n    type: file\n    behavior: ipcidr\n    format: mrs\n    path: never-read.mrs\n'
    const selection = { id: stored.profile.id, sha256: profileHash(source) }
    fixture.profileRead.mockResolvedValue({
      ...stored,
      profile: { ...stored.profile, sha256: selection.sha256 },
      text: source
    })
    const bytes = Buffer.from('private MRS fixture'),
      info = {
        name: 'MRS fixture',
        kind: 'rule-mrs',
        behavior: 'ipcidr',
        selector: '',
        id: '00000000-0000-0000-0000-000000000002',
        sha256: profileHash(bytes.toString()),
        size: bytes.length
      }
    fixture.resourceRead.mockResolvedValue({ info, bytes, revision: 'b'.repeat(64) })
    fixture.mrsConvert.mockResolvedValue({ entries: ['127.0.0.0/8'], sourceRules: 1 })
    const prepared = (await invoke('relayProfileRuleSnapshotPrepare', {
      profile: selection,
      provider: 'Cached',
      resource: { id: info.id, sha256: info.sha256 }
    })) as { evidenceId: string }
    expect(fixture.mrsConvert).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]core$/u),
      expect.objectContaining({ descriptor: expect.objectContaining({ kind: 'rule-mrs' }), bytes })
    )
    expect(await invoke('relayProfileSave', { evidenceId: prepared.evidenceId })).toMatchObject({
      status: 'saved'
    })
    expect(fixture.profileSave).toHaveBeenCalledOnce()
    expect(fixture.resourceDownload).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('binds manual runtime Gist preparation to the live owned port and reports an unacknowledged requested upload', async () => {
    const request = { proxyPort: 18191, token: 'PRIVATE_github_token' }
    await expect(invoke('relayRuntimeGistPrepare', request) as Promise<unknown>).rejects.toThrow(
      '准备未通过'
    )
    const ready = await localPreparation()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: ready.evidenceId })
    await expect(
      invoke('relayRuntimeGistPrepare', { ...request, proxyPort: 18192 }) as Promise<unknown>
    ).rejects.toThrow('准备未通过')
    const plan = (await invoke('relayRuntimeGistPrepare', request)) as { evidenceId: string }
    expect(JSON.stringify(plan)).not.toContain('PRIVATE')
    expect(plan).toMatchObject({ action: 'create', proxyPort: 18191, containsSecrets: true })
    expect(await invoke('relayRuntimeGistExecute', { evidenceId: plan.evidenceId })).toEqual({
      status: 'uncertain'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(() => invoke('relayRuntimeGistCancel', {})).toThrow('不接受参数')
    invoke('relayRuntimeGistCancel')
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.profileSave).not.toHaveBeenCalled()
  })
  it('revokes runtime Gist proof on sleep and blocks competing writes during the requested transfer', async () => {
    const ready = await localPreparation()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: ready.evidenceId })
    const plan = (await invoke('relayRuntimeGistPrepare', {
      proxyPort: 18191,
      token: 'PRIVATE_github_token'
    })) as { evidenceId: string }
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<never>()
    fixture.runtimeGistRequest.mockImplementationOnce(async () => {
      entered.resolve()
      return finish.promise
    })
    const pending = invoke('relayRuntimeGistExecute', { evidenceId: plan.evidenceId })
    await entered.promise
    expect(() =>
      invoke('relayConfigEditSave', { globalOverrides: [], profileOverrides: [], controlled: {} })
    ).toThrow('请先结束')
    expect(() =>
      invoke('relayLocalProxyAction', {
        action: 'stop',
        instanceId: (invoke('relayLocalProxyState') as { instanceId: string }).instanceId
      })
    ).toThrow('操作尚未结束')
    const suspend = fixture.powerOn.mock.calls.find(([name]) => name === 'suspend')?.[1]
    // Both the core lifecycle and Gist cancellation listeners are registered.
    for (const [name, listener] of fixture.powerOn.mock.calls) if (name === 'suspend') listener()
    expect(suspend).toBeTypeOf('function')
    finish.reject(new Error('cancelled transfer'))
    expect(await pending).toEqual({ status: 'uncertain' })
    expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce()
    await expect(
      invoke('relayRuntimeGistExecute', { evidenceId: plan.evidenceId }) as Promise<unknown>
    ).rejects.toThrow('重新准备')
    expect(fixture.localStop).not.toHaveBeenCalled()
  })
  it('reads and prepares rule copies through owned profile handlers with direct publication', async () => {
    const selection = {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource)
    }
    expect(await invoke('relayProfileRulesRead', selection)).toMatchObject({
      rules: expect.any(Array),
      targets: expect.arrayContaining(['DIRECT'])
    })
    const prepared = (await invoke('relayProfileRulesPrepare', {
      profile: selection,
      rules: ['MATCH,DIRECT']
    })) as { evidenceId: string }
    expect(await invoke('relayProfileSave', { evidenceId: prepared.evidenceId })).toMatchObject({
      status: 'saved'
    })
    expect(fixture.profileSave).toHaveBeenCalledOnce()
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('reads and prepares proxy groups through owned profile handlers without enabling a core', async () => {
    const selection = {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource)
    }
    expect(await invoke('relayProfileGroupsRead', selection)).toMatchObject({
      groups: expect.any(Array),
      targets: expect.arrayContaining(['DIRECT'])
    })
    const prepared = (await invoke('relayProfileGroupsPrepare', {
      profile: selection,
      action: 'add',
      group: { name: 'AddedGroup', type: 'select', proxies: ['DIRECT'] }
    })) as { evidenceId: string }
    expect(await invoke('relayProfileSave', { evidenceId: prepared.evidenceId })).toMatchObject({
      status: 'saved'
    })
    expect(fixture.profileSave).toHaveBeenCalledOnce()
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('prepares a node-edited copy from the selected private profile and reuses direct save without lifecycle actions', async () => {
    const selection = {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource)
    }
    expect(await invoke('relayProfileNodesRead', selection)).toMatchObject({
      nodes: expect.any(Array)
    })
    expect(fixture.profileRead).toHaveBeenCalledWith(selection)
    const prepared = (await invoke('relayProfileNodesPrepare', {
      profile: selection,
      action: 'add',
      node: { name: 'Added', type: 'http', server: '127.0.0.1', port: 18192 }
    })) as { evidenceId: string }
    expect(fixture.profileSave).not.toHaveBeenCalled()
    expect(await invoke('relayProfileSave', { evidenceId: prepared.evidenceId })).toMatchObject({
      status: 'saved'
    })
    expect(fixture.profileSave).toHaveBeenCalledOnce()
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('binds destructive WebDAV execution to an exact file and strong tag without secondary confirmation', async () => {
    const plan = (await invoke('relayBackupRemotePrepare', {
      provider: 'webdav',
      action: 'delete',
      url: 'https://dav.example/Relay/a.json',
      username: 'fixture',
      password: 'fixture-secret',
      proxyPort: 17891,
      etag: '"version-1"'
    })) as { evidenceId: string }
    await expect(
      invoke('relayBackupRemoteExecute', { evidenceId: plan.evidenceId })
    ).rejects.toThrow('条件删除尚未接通')
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.remoteDownload).not.toHaveBeenCalled()
    expect(fixture.remoteUpload).not.toHaveBeenCalled()
    expect(fixture.backupStage).not.toHaveBeenCalled()
  })
  it('exports a new AGE identity through a save-location input while the owned core runs, without returning its secret', async () => {
    const prepared = await localPreparation()
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: prepared.evidenceId })
    expect(() => invoke('relayBackupKeyExport', { path: '/renderer-selected' })).toThrow(
      '不接受参数'
    )
    fixture.confirmRestore.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await invoke('relayBackupKeyExport')).toEqual({ status: 'cancelled' })
    expect(fixture.chooseSave).toHaveBeenCalledOnce()
    fixture.chooseSave.mockResolvedValueOnce({
      canceled: false,
      filePath: '/fake/new-identity.txt'
    })
    const result = await invoke('relayBackupKeyExport')
    expect(result).toEqual({ status: 'exported', recipient: expect.stringMatching(/^age1/) })
    expect(fixture.write).toHaveBeenCalledWith('/fake/new-identity.txt', expect.any(Buffer))
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.coreStop).not.toHaveBeenCalled()
    expect(fixture.remoteUpload).not.toHaveBeenCalled()
    expect(fixture.backupStage).not.toHaveBeenCalled()
  })
  it('does not publish an AGE identity when its renderer crashes with a save dialog open', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    fixture.chooseSave.mockImplementationOnce(async () => {
      for (const [name, handler] of fixture.window.webContents.on.mock.calls)
        if (name === 'render-process-gone') handler()
      return { canceled: false, filePath: '/fake/stale-private-export' }
    })
    expect(await invoke('relayBackupKeyExport')).toEqual({ status: 'cancelled' })
    expect(fixture.chooseSave).toHaveBeenCalledTimes(1)
    expect(fixture.write).not.toHaveBeenCalled()
  })
  it('refuses private ZIP save before and after its chooser once quit is latched', async () => {
    const save = fixture.writeBackupExport
    const quit = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1]
    if (!save || !quit) throw new Error('Missing backup export or quit adapter')
    const destination = Promise.withResolvers<{ canceled: boolean; filePath: string }>()
    fixture.chooseSave.mockReturnValueOnce(destination.promise)
    const archive = Buffer.from('fixture archive')
    const saving = save(archive, () => true)
    expect(fixture.chooseSave).toHaveBeenCalledTimes(1)
    fixture.knownNoRetainedCore = true
    try {
      quit({ preventDefault: vi.fn() })
      const refused = save(archive, () => true)
      destination.resolve({ canceled: false, filePath: '/fake/stale-private-backup.zip' })
      await expect(refused).resolves.toBe(false)
      expect(fixture.chooseSave).toHaveBeenCalledTimes(1)
      await expect(saving).resolves.toBe(false)
      expect(fixture.write).not.toHaveBeenCalled()
    } finally {
      fixture.knownNoRetainedCore = false
    }
  })
  it('reads saved-account public metadata only on an explicit argument-free request without decrypting credentials', async () => {
    expect(() => invoke('relayBackupAccountList', {})).toThrow('不接受参数')
    const result = await invoke('relayBackupAccountList')
    expect(result).toMatchObject({ accounts: [savedBackupAccount], incomplete: 0 })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(fixture.accountList).toHaveBeenCalledOnce()
    expect(fixture.accountCredential).not.toHaveBeenCalled()
    expect(fixture.safeAvailable).not.toHaveBeenCalled()
    expect(fixture.safeDecrypt).not.toHaveBeenCalled()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
  })
  it('prepares saved WebDAV credentials only in main and executes the requested transfer once', async () => {
    const plan = (await invoke('relayBackupAccountPrepareRemote', {
      id: savedBackupAccount.id,
      revision: savedBackupAccount.revision,
      action: 'download',
      filename: 'fixture.json'
    })) as { evidenceId: string; endpoint: string }
    expect(plan.endpoint).toBe('https://dav.example/Relay/fixture.json')
    expect(JSON.stringify(plan)).not.toContain('PRIVATE_SAVED_PASSWORD')
    expect(fixture.accountCredential).toHaveBeenCalledOnce()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(await invoke('relayBackupRemoteExecute', { evidenceId: plan.evidenceId })).toMatchObject(
      { status: 'prepared' }
    )
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(JSON.stringify(fixture.confirmRestore.mock.calls)).not.toContain(
      'PRIVATE_SAVED_PASSWORD'
    )
    expect(fixture.remoteDownload).toHaveBeenCalledOnce()
    expect(fixture.backupStage).toHaveBeenCalledOnce()
  })
  it('rechecks a saved account at execution and refuses changed credentials before transfer', async () => {
    const plan = (await invoke('relayBackupAccountPrepareRemote', {
      id: savedBackupAccount.id,
      revision: savedBackupAccount.revision,
      action: 'download',
      filename: 'fixture.json'
    })) as { evidenceId: string }
    fixture.accountRead.mockRejectedValue(new Error('PRIVATE-account-changed'))
    await expect(
      invoke('relayBackupRemoteExecute', { evidenceId: plan.evidenceId }) as Promise<unknown>
    ).rejects.toThrow('账号已变化')
    expect(fixture.remoteDownload).not.toHaveBeenCalled()
    expect(fixture.backupStage).not.toHaveBeenCalled()
  })
  it('invalidates prepared transfers after account CRUD and clears account trust only after explicit data restoration', async () => {
    const request = {
      provider: 'webdav',
      action: 'download',
      url: 'https://dav.example/Relay/a.json',
      username: 'fixture',
      password: 'PRIVATE-manual',
      proxyPort: 18191
    }
    const plan = (await invoke('relayBackupRemotePrepare', request)) as { evidenceId: string }
    const saved = await invoke('relayBackupAccountSave', {
      name: 'Fixture',
      provider: 'webdav',
      proxyPort: 18191,
      directoryURL: 'https://dav.example/Relay/',
      username: 'fixture',
      password: 'PRIVATE-new'
    })
    expect(saved).toMatchObject({ id: savedBackupAccount.id, hasCredential: true })
    expect(JSON.stringify(saved)).not.toContain('PRIVATE')
    await expect(
      invoke('relayBackupRemoteExecute', { evidenceId: plan.evidenceId }) as Promise<unknown>
    ).rejects.toThrow('失效')
    expect(
      await invoke('relayBackupAccountDisable', {
        id: savedBackupAccount.id,
        revision: savedBackupAccount.revision
      })
    ).toMatchObject({ state: 'disabled' })
    expect(fixture.accountClearTrust).not.toHaveBeenCalled()
    await fixture.afterBackupRestore?.()
    expect(fixture.accountClearTrust).toHaveBeenCalledOnce()
    expect(fixture.remoteDownload).not.toHaveBeenCalled()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
  })
  it('serializes account writes against other mutations and waits for an entered private write before quitting', async () => {
    const saved = Promise.withResolvers<RelayBackupAccount>()
    fixture.accountSave.mockImplementationOnce(() => saved.promise)
    const pending = invoke('relayBackupAccountSave', { name: 'fixture' })
    await vi.waitFor(() => expect(fixture.accountSave).toHaveBeenCalled())
    expect(() => invoke('relayConfigEditClear', { expectedRevision: '' })).toThrow('请先结束')
    await expect(invoke('relayBackupAccountList') as Promise<unknown>).rejects.toThrow('账号操作')
    const quit = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1]
    quit({ preventDefault: vi.fn() })
    expect(fixture.appQuit).not.toHaveBeenCalled()
    saved.resolve({ ...savedBackupAccount })
    expect(await pending).toMatchObject({ id: savedBackupAccount.id })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    expect(fixture.coreStop).not.toHaveBeenCalled()
    expect(fixture.localStop).not.toHaveBeenCalled()
  })
  it('revokes a saved-account preparation that was awaiting credential decryption when sleep began', async () => {
    const credential = Promise.withResolvers<{ account: RelayBackupAccount; secret: string }>()
    fixture.accountCredential.mockImplementationOnce(() => credential.promise)
    const pending = invoke('relayBackupAccountPrepareRemote', {
      id: savedBackupAccount.id,
      revision: savedBackupAccount.revision,
      action: 'download',
      filename: 'a.json'
    }) as Promise<unknown>
    await vi.waitFor(() => expect(fixture.accountCredential).toHaveBeenCalled())
    for (const [name, listener] of fixture.powerOn.mock.calls) if (name === 'suspend') listener()
    credential.resolve({ account: { ...savedBackupAccount }, secret: 'PRIVATE_LATE_SECRET' })
    await expect(pending).rejects.toThrow('远程准备未通过')
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.remoteDownload).not.toHaveBeenCalled()
  })
  it('prepares saved Gist runtime data through the owned proxy with no token in renderer or confirmation replies', async () => {
    const local = await localPreparation()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: local.evidenceId })
    const account = {
      ...savedBackupAccount,
      provider: 'gist' as const,
      directoryURL: undefined,
      username: undefined
    }
    fixture.accountRead.mockResolvedValue(account)
    fixture.accountCredential.mockResolvedValue({ account, secret: 'PRIVATE_SAVED_GIST_TOKEN' })
    const plan = (await invoke('relayBackupAccountPrepareRuntime', {
      id: account.id,
      revision: account.revision
    })) as { evidenceId: string }
    expect(JSON.stringify(plan)).not.toContain('PRIVATE_SAVED_GIST_TOKEN')
    fixture.confirmRestore.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    expect(await invoke('relayRuntimeGistExecute', { evidenceId: plan.evidenceId })).toEqual({
      status: 'uncertain'
    })
    expect(JSON.stringify(fixture.confirmRestore.mock.calls)).not.toContain(
      'PRIVATE_SAVED_GIST_TOKEN'
    )
    expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce()
    expect(fixture.localStop).not.toHaveBeenCalled()
  })
  const scheduleRequest = () => ({
    id: savedBackupAccount.id,
    revision: savedBackupAccount.revision,
    schedule: { kind: 'interval' as const, minutes: 1 }
  })
  const backupScheduleState = () =>
    invoke('relayBackupScheduleState') as RelayWebdavBackupSchedulerState
  describe('TUN runtime Gist source entry', () => {
    afterEach(() => {
      fixture.window.webContents.isDestroyed.mockReturnValue(false)
      vi.useRealTimers()
    })
    const sessionId = '11111111-1111-4111-8111-111111111111',
      source = { kind: 'tun-managed' as const, sessionId },
      gistId = 'abcdef0123456789'
    const request = () => ({ source, proxyPort: 18191, token: 'PRIVATE_GIST_TOKEN', gistId })
    const tun = () => {
      fixture.simulateTunRuntime = true
      fixture.tunStateOverride = {
        phase: 'active',
        pending: false,
        owned: true,
        sessionId,
        traffic: 'forwarding',
        restorationVerified: false,
        protectionVerified: false,
        warnings: []
      }
      fixture.tunCapture.mockImplementation(async (port) => ({
        status: 'captured',
        capture: {
          snapshot: {
            instanceId: sessionId,
            revision: 'a'.repeat(64),
            proxyPort: port,
            source,
            configuration:
              JSON.stringify({
                port,
                mode: 'rule',
                tun: { enable: true },
                rules: ['MATCH,REJECT']
              }) + '\n'
          },
          capturedAt: Date.now(),
          isCurrent: () =>
            fixture.tunStateOverride?.phase === 'active' && !fixture.tunStateOverride.pending,
          isOwnerLive: () => fixture.tunStateOverride?.phase === 'active',
          assertOwner: async () => {
            if (fixture.tunStateOverride?.phase !== 'active') throw new Error('owner lost')
          }
        }
      }))
    }
    const owner = async (kind: 'local' | 'tun') => {
      if (kind === 'tun') {
        tun()
        return source
      }
      const prepared = await localPreparation()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayLocalProxyAction', { action: 'start', evidenceId: prepared.evidenceId })
      return undefined
    }
    const remote = (holdPatch?: Promise<void>) => {
      let content = 'old dedicated file'
      const entered = Promise.withResolvers<void>()
      fixture.runtimeGistRequest.mockImplementation(
        async (_url: string, input: { method: string; body?: Buffer }) => {
          if (input.method === 'PATCH') {
            content = JSON.parse(input.body?.toString() ?? '{}').files['clash-party.yaml'].content
            entered.resolve()
            await holdPatch
          }
          return {
            status: 200,
            headers: {},
            bytes: Buffer.from(
              JSON.stringify({
                id: gistId,
                public: false,
                files: {
                  'clash-party.yaml': { filename: 'clash-party.yaml', truncated: false, content }
                }
              })
            )
          }
        }
      )
      return entered
    }
    it('requires an explicit matching TUN source and never falls back from an unsupported host', async () => {
      tun()
      await expect(
        invoke('relayRuntimeGistPrepare', { ...request(), source: undefined })
      ).rejects.toThrow('TUN')
      await expect(
        invoke('relayRuntimeGistPrepare', {
          ...request(),
          source: { ...source, sessionId: '22222222-2222-4222-8222-222222222222' }
        })
      ).rejects.toThrow('TUN')
      fixture.tunCapture.mockResolvedValueOnce({ status: 'unsupported' })
      await expect(invoke('relayRuntimeGistPrepare', request())).rejects.toThrow()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('binds a manual plan and direct execution to the selected TUN session and fixed port', async () => {
      tun()
      remote()
      const plan = (await invoke('relayRuntimeGistPrepare', request())) as {
        evidenceId: string
        source: unknown
        instanceId: string
      }
      expect(plan).toMatchObject({ source, instanceId: sessionId })
      expect(
        await invoke('relayRuntimeGistExecute', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'uploaded' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.tunCapture).toHaveBeenCalledWith(18191, expect.any(AbortSignal))
      expect(fixture.runtimeGistRequest.mock.calls.map(([, input]) => input.method)).toEqual([
        'GET',
        'PATCH',
        'GET'
      ])
      expect(fixture.localStop).not.toHaveBeenCalled()
    })
    it('uses the selected TUN receipt for automatic Gist capture without starting or adopting a core', async () => {
      tun()
      const account = {
        ...savedBackupAccount,
        provider: 'gist' as const,
        username: undefined,
        directoryURL: undefined
      }
      fixture.accountRead.mockResolvedValue(account)
      fixture.accountCredential.mockResolvedValue({ account, secret: 'PRIVATE_GIST_TOKEN' })
      remote()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      expect(
        await invoke('relayRuntimeGistSyncArm', {
          id: account.id,
          revision: account.revision,
          gistId,
          source
        })
      ).toMatchObject({ status: 'armed', state: { owner: { source, instanceId: sessionId } } })
      await vi.advanceTimersByTimeAsync(300)
      expect(fixture.runtimeGistRequest.mock.calls.map(([, options]) => options.method)).toEqual([
        'GET',
        'PATCH',
        'GET'
      ])
      expect(invoke('relayRuntimeGistSyncState')).toMatchObject({
        enabled: true,
        lastResult: 'uploaded'
      })
      await invoke('relayRuntimeGistSyncStop')
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
    })
    it.each(['local', 'tun'] as const)(
      'rejects an eventless renderer loss after manual %s Native approval without sending',
      async (kind) => {
        const selected = await owner(kind),
          answer = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
        const plan = (await invoke('relayRuntimeGistPrepare', {
          ...request(),
          source: selected
        })) as { evidenceId: string }
        fixture.confirmRestore.mockImplementationOnce(() => answer.promise)
        const pending = invoke('relayRuntimeGistExecute', {
          evidenceId: plan.evidenceId
        }) as Promise<unknown>
        await Promise.resolve()
        fixture.window.webContents.isDestroyed.mockReturnValue(true)
        answer.resolve({ response: 1, checkboxChecked: false })
        await expect(pending).rejects.toThrow('未确认')
        expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
        expect(fixture.localStop).not.toHaveBeenCalled()
      }
    )
    it.each(['local', 'tun'] as const)(
      'binds account %s preparation context before awaiting credential decryption',
      async (kind) => {
        const selected = await owner(kind),
          finish = Promise.withResolvers<{ account: RelayBackupAccount; secret: string }>(),
          account = {
            ...savedBackupAccount,
            provider: 'gist' as const,
            username: undefined,
            directoryURL: undefined
          }
        fixture.accountRead.mockResolvedValue(account)
        fixture.accountCredential.mockImplementationOnce(() => finish.promise)
        const pending = invoke('relayBackupAccountPrepareRuntime', {
          id: account.id,
          revision: account.revision,
          gistId,
          source: selected
        }) as Promise<unknown>
        await vi.waitFor(() => expect(fixture.accountCredential).toHaveBeenCalled())
        fixture.window.webContents.isDestroyed.mockReturnValue(true)
        finish.resolve({ account, secret: 'PRIVATE_LATE_TOKEN' })
        await expect(pending).rejects.toThrow()
        expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
        expect(JSON.stringify(fixture.confirmRestore.mock.calls)).not.toContain(
          'PRIVATE_LATE_TOKEN'
        )
      }
    )
    it.each(['local', 'tun'] as const)(
      'keeps a submitted manual %s PATCH uncertain after eventless renderer loss and never retries',
      async (kind) => {
        const selected = await owner(kind),
          finish = Promise.withResolvers<void>(),
          entered = remote(finish.promise)
        const plan = (await invoke('relayRuntimeGistPrepare', {
          ...request(),
          source: selected
        })) as { evidenceId: string }
        fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        const pending = invoke('relayRuntimeGistExecute', {
          evidenceId: plan.evidenceId
        }) as Promise<unknown>
        try {
          await entered.promise
          fixture.window.webContents.isDestroyed.mockReturnValue(true)
          finish.resolve()
          expect(await pending).toMatchObject({ status: 'uncertain' })
          expect(
            fixture.runtimeGistRequest.mock.calls.map(([, options]) => options.method)
          ).toEqual(['GET', 'PATCH'])
          await vi.advanceTimersByTimeAsync(1000)
          expect(fixture.runtimeGistRequest).toHaveBeenCalledTimes(2)
        } finally {
          finish.resolve()
        }
      }
    )
    it('rejects a newly observed same-owner mode after the account await and before manual PATCH dispatch', async () => {
      await owner('local')
      const account = {
        ...savedBackupAccount,
        provider: 'gist' as const,
        username: undefined,
        directoryURL: undefined
      }
      fixture.accountRead.mockResolvedValue(account)
      fixture.accountCredential.mockResolvedValue({ account, secret: 'PRIVATE_GIST_TOKEN' })
      remote()
      const plan = (await invoke('relayBackupAccountPrepareRuntime', {
        id: account.id,
        revision: account.revision,
        gistId
      })) as { evidenceId: string }
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      let checks = 0
      fixture.accountRead.mockImplementation(async () => {
        if (++checks === 3) {
          entered.resolve()
          await finish.promise
        }
        return account
      })
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      const pending = (
        invoke('relayRuntimeGistExecute', { evidenceId: plan.evidenceId }) as Promise<unknown>
      ).catch(() => ({ status: 'rejected' }))
      try {
        await entered.promise
        // Simulate an already-completed external core mode change, then use the
        // ordinary read-only UI observation to publish its real observed mode.
        await fixture.localPatchMode('global')
        expect(await invoke('getControledMihomoConfig')).toMatchObject({ mode: 'global' })
        finish.resolve()
        const result = await pending
        expect(fixture.runtimeGistRequest.mock.calls.map(([, input]) => input.method)).toEqual([
          'GET'
        ])
        expect(result).toMatchObject({ status: 'rejected' })
      } finally {
        finish.resolve()
      }
    })
  })
  describe('Runtime Gist automatic session sync entry', () => {
    afterEach(() => vi.useRealTimers())
    const gistId = 'abcdef0123456789'
    const syncState = () => invoke('relayRuntimeGistSyncState') as RelayRuntimeGistSyncState
    const request = () => ({
      id: savedBackupAccount.id,
      revision: savedBackupAccount.revision,
      gistId
    })
    const running = async () => {
      const prepared = await localPreparation()
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const started = (await invoke('relayLocalProxyAction', {
        action: 'start',
        evidenceId: prepared.evidenceId
      })) as { state: { instanceId: string } }
      const account: RelayBackupAccount = {
        ...savedBackupAccount,
        name: 'Saved Gist fixture',
        provider: 'gist',
        directoryURL: undefined,
        username: undefined
      }
      fixture.accountRead.mockResolvedValue(account)
      fixture.accountCredential.mockResolvedValue({
        account,
        secret: 'PRIVATE_AUTOMATIC_GIST_TOKEN'
      })
      fixture.accountSave.mockResolvedValue({ ...account, revision: 'e'.repeat(64) })
      fixture.accountDisable.mockResolvedValue({
        ...account,
        state: 'disabled',
        revision: 'e'.repeat(64)
      })
      fixture.confirmRestore.mockClear()
      return { account, instanceId: started.state.instanceId }
    }
    const response = (content: string) => ({
      status: 200,
      headers: {},
      bytes: Buffer.from(
        JSON.stringify({
          id: gistId,
          public: false,
          files: {
            'clash-party.yaml': {
              filename: 'clash-party.yaml',
              truncated: false,
              content,
              size: Buffer.byteLength(content)
            }
          }
        })
      )
    })
    const transfer = (holdFirstPatch?: Promise<void>) => {
      let remote = 'original dedicated file'
      const payloads: string[] = [],
        signals: AbortSignal[] = [],
        entered = Promise.withResolvers<void>()
      fixture.runtimeGistRequest.mockImplementation(
        async (_url: string, options: { method: string; body?: Buffer; signal: AbortSignal }) => {
          if (options.method === 'PATCH') {
            if (!options.body) throw new Error('fixture body missing')
            remote = JSON.parse(options.body.toString('utf8')).files['clash-party.yaml'].content
            payloads.push(remote)
            signals.push(options.signal)
            entered.resolve()
            if (payloads.length === 1) await holdFirstPatch
          }
          return response(remote)
        }
      )
      return { payloads, signals, entered: entered.promise }
    }
    it('keeps public state inert and binds the direct action to the exact existing target and owner', async () => {
      expect(syncState()).toMatchObject({ enabled: false, pending: false, phase: 'idle' })
      expect(() => invoke('relayRuntimeGistSyncState', {})).toThrow('不接受参数')
      expect(() => invoke('relayRuntimeGistSyncStop', {})).toThrow('不接受参数')
      expect(fixture.accountRead).not.toHaveBeenCalled()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      const { instanceId } = await running()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      const result = await invoke('relayRuntimeGistSyncArm', request())
      expect(result).toMatchObject({
        status: 'armed',
        state: { enabled: true, owner: { instanceId } }
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('PRIVATE-password')
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      await invoke('relayRuntimeGistSyncStop')
    })
    it('captures and sends through the saved private account only after authorization without using manual transfer confirmation', async () => {
      await running()
      const network = transfer()
      expect(await invoke('relayRuntimeGistSyncArm', request())).toMatchObject({ status: 'armed' })
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(301)
      expect(syncState()).toMatchObject({
        enabled: true,
        pending: false,
        dirty: false,
        lastResult: 'uploaded',
        lastUploaded: { source: { configurationSHA256: profileHash(network.payloads[0]) } }
      })
      expect(network.payloads).toHaveLength(1)
      expect(fixture.accountCredential).toHaveBeenCalledOnce()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest.mock.calls.map(([, options]) => options.method)).toEqual([
        'GET',
        'PATCH',
        'GET'
      ])
      for (const [url, options] of fixture.runtimeGistRequest.mock.calls) {
        expect(url).toBe('https://api.github.com/gists/' + gistId)
        expect(options.headers.Authorization).toBe('Bearer PRIVATE_AUTOMATIC_GIST_TOKEN')
        expect(options.proxy).toEqual({ host: '127.0.0.1', port: 18191 })
      }
      expect(JSON.stringify(syncState())).not.toContain('PRIVATE')
      expect(fixture.localStop).not.toHaveBeenCalled()
      await invoke('relayRuntimeGistSyncStop')
    })
    it('lets ordinary mode and reload commits finish while a captured PATCH is pending, then uploads the latest active body', async () => {
      const { instanceId } = await running(),
        finish = Promise.withResolvers<void>(),
        network = transfer(finish.promise)
      await invoke('relayRuntimeGistSyncArm', request())
      await vi.advanceTimersByTimeAsync(301)
      await network.entered
      expect(syncState()).toMatchObject({ pending: true, uploading: { submitted: true } })
      expect(
        await invoke('relayLocalProxyAction', { action: 'mode', instanceId, mode: 'global' })
      ).toMatchObject({ status: 'modeChanged' })
      const reload = (await invoke('relayLocalProxyReloadPrepare', {
        profile: {
          id: '00000000-0000-0000-0000-000000000001',
          sha256: profileHash(profileRuntimeSource)
        },
        httpPort: 18191
      })) as { evidenceId: string }
      expect(
        await invoke('relayLocalProxyReload', { evidenceId: reload.evidenceId })
      ).toMatchObject({ status: 'reloaded' })
      expect(network.signals[0].aborted).toBe(false)
      expect(syncState()).toMatchObject({ enabled: true, dirty: true })
      expect(JSON.parse(network.payloads[0]).mode).toBe('rule')
      finish.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(syncState()).toMatchObject({ enabled: true, lastResult: 'uploaded', dirty: true })
      await vi.advanceTimersByTimeAsync(1100)
      expect(network.payloads).toHaveLength(2)
      expect(JSON.parse(network.payloads[1]).mode).toBe('global')
      expect(syncState()).toMatchObject({ enabled: true, pending: false, dirty: false })
      expect(fixture.localStop).not.toHaveBeenCalled()
      await invoke('relayRuntimeGistSyncStop')
    })
    it('blocks competing backup/account/manual-Gist work while uploading and Stop waits without retrying an uncertain write', async () => {
      await running()
      const finish = Promise.withResolvers<void>(),
        network = transfer(finish.promise)
      await invoke('relayRuntimeGistSyncArm', request())
      expect(() => invoke('relayBackupAccountPrepareRuntime', request())).toThrow('先停止')
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(301)
      await network.entered
      await expect(invoke('relayBackupExport') as Promise<unknown>).rejects.toThrow('自动同步')
      await expect(
        invoke('relayBackupAccountSave', { provider: 'gist', name: 'Other', proxyPort: 18191 })
      ).rejects.toThrow('自动同步')
      await expect(
        invoke('relayRuntimeGistPrepare', { token: 'PRIVATE_manual', proxyPort: 18191 })
      ).rejects.toThrow('先停止')
      expect(fixture.accountSave).not.toHaveBeenCalled()
      const stopped = invoke('relayRuntimeGistSyncStop')
      expect(network.signals[0].aborted).toBe(true)
      expect(syncState()).toMatchObject({ enabled: false, pending: true })
      finish.resolve()
      expect(await stopped).toMatchObject({
        enabled: false,
        pending: false,
        lastResult: 'uncertain'
      })
      const requests = fixture.runtimeGistRequest.mock.calls.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(fixture.runtimeGistRequest).toHaveBeenCalledTimes(requests)
    })
    it.each(['save', 'disable'] as const)(
      'allows an idle enabled account %s then revokes the matching automatic grant',
      async (operation) => {
        const { account } = await running()
        await invoke('relayRuntimeGistSyncArm', request())
        expect(syncState()).toMatchObject({ enabled: true, pending: false })
        await invoke(
          operation === 'save' ? 'relayBackupAccountSave' : 'relayBackupAccountDisable',
          {
            id: account.id,
            revision: account.revision,
            ...(operation === 'save'
              ? { name: account.name, provider: 'gist', proxyPort: account.proxyPort }
              : {})
          }
        )
        expect(syncState()).toMatchObject({ enabled: false, stopReason: 'accountChanged' })
        await vi.advanceTimersByTimeAsync(1000)
        expect(fixture.accountCredential).not.toHaveBeenCalled()
        expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      }
    )
    it('rejects a saved credential returned after the account revision changed without sending a request', async () => {
      const { account } = await running(),
        entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<{ account: RelayBackupAccount; secret: string }>()
      fixture.accountCredential.mockImplementationOnce(async () => {
        entered.resolve()
        return finish.promise
      })
      await invoke('relayRuntimeGistSyncArm', request())
      await vi.advanceTimersByTimeAsync(301)
      await entered.promise
      fixture.accountRead.mockResolvedValue({ ...account, revision: 'e'.repeat(64) })
      finish.resolve({ account, secret: 'PRIVATE_STALE_TOKEN' })
      await vi.advanceTimersByTimeAsync(0)
      expect(syncState()).toMatchObject({
        enabled: false,
        pending: false,
        stopReason: 'credentials'
      })
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      expect(JSON.stringify(syncState())).not.toContain('PRIVATE_STALE_TOKEN')
    })
    it.each([
      'directHide',
      'trayClose',
      'suspend',
      'navigation',
      'destroyedContents',
      'destroyedHide',
      'throwingFrame'
    ])(
      'revokes on %s without sending, automatically resuming or stopping the core',
      async (boundary) => {
        await running()
        await invoke('relayRuntimeGistSyncArm', request())
        const descriptor = Object.getOwnPropertyDescriptor(fixture.window.webContents, 'mainFrame')
        if (!descriptor) throw new Error('fixture frame missing')
        try {
          if (boundary === 'directHide')
            fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
          else if (boundary === 'trayClose') {
            fixture.shellShouldHide.mockReturnValue(true)
            fixture.window.on.mock.calls.find(([name]) => name === 'close')?.[1]({
              preventDefault: vi.fn()
            })
          } else if (boundary === 'suspend') {
            for (const [name, listener] of fixture.powerOn.mock.calls)
              if (name === 'suspend') listener()
          } else if (boundary === 'navigation') {
            for (const [name, listener] of fixture.window.webContents.on.mock.calls)
              if (name === 'did-start-navigation')
                listener({ isMainFrame: true, isSameDocument: false })
          } else if (boundary === 'destroyedContents')
            fixture.window.webContents.isDestroyed.mockReturnValue(true)
          else if (boundary === 'destroyedHide') {
            fixture.window.webContents.isDestroyed.mockReturnValue(true)
            expect(() =>
              fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
            ).not.toThrow()
            expect(fixture.window.webContents.send).not.toHaveBeenCalledWith(
              'relayBackupPreparationsInvalidated'
            )
          } else
            Object.defineProperty(fixture.window.webContents, 'mainFrame', {
              configurable: true,
              get: () => {
                throw new Error('PRIVATE destroyed frame getter')
              }
            })
          await vi.advanceTimersByTimeAsync(1000)
        } finally {
          Object.defineProperty(fixture.window.webContents, 'mainFrame', descriptor)
          fixture.window.webContents.isDestroyed.mockReturnValue(false)
        }
        expect(syncState()).toMatchObject({ enabled: false, pending: false })
        if (boundary === 'directHide' || boundary === 'trayClose')
          expect(fixture.window.webContents.send).toHaveBeenCalledWith(
            'relayBackupPreparationsInvalidated'
          )
        for (const [name, listener] of fixture.powerOn.mock.calls) if (name === 'resume') listener()
        await vi.advanceTimersByTimeAsync(5000)
        expect(fixture.accountCredential).not.toHaveBeenCalled()
        expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
        expect(fixture.localStop).not.toHaveBeenCalled()
      }
    )
    it('rejects a late account lookup after a direct hide and clears the renderer view without cancellation RPC', async () => {
      await running()
      const entered = Promise.withResolvers<void>(),
        answer = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
      fixture.accountRead.mockImplementationOnce(async () => {
        entered.resolve()
        return answer.promise
      })
      const arming = invoke('relayRuntimeGistSyncArm', request())
      await entered.promise
      fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
      expect(fixture.window.webContents.send).toHaveBeenCalledWith(
        'relayBackupPreparationsInvalidated'
      )
      answer.resolve({
        ...savedBackupAccount,
        provider: 'gist',
        username: undefined,
        directoryURL: undefined
      })
      await expect(arming).rejects.toThrow()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
    it('stops the owned proxy without waiting for the aborted remote write, and drains it before a prepared restore enters', async () => {
      fixture.chooseOpen.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/private/relay.zip']
      })
      const restore = (await invoke('relayBackupImportPrepare')) as { plan: { id: string } }
      const { instanceId } = await running(),
        finish = Promise.withResolvers<void>(),
        network = transfer(finish.promise)
      await invoke('relayRuntimeGistSyncArm', request())
      await vi.advanceTimersByTimeAsync(301)
      await network.entered
      expect(await invoke('relayLocalProxyAction', { action: 'stop', instanceId })).toMatchObject({
        status: 'stopped'
      })
      expect(fixture.localStop).toHaveBeenCalledOnce()
      expect(network.signals[0].aborted).toBe(true)
      const restoring = invoke('relayBackupRestore', { id: restore.plan.id })
      expect(fixture.backupCommit).not.toHaveBeenCalled()
      finish.resolve()
      expect(await restoring).toMatchObject({ status: 'restored' })
      expect(fixture.backupCommit).toHaveBeenCalledOnce()
      expect(syncState()).toMatchObject({ enabled: false, pending: false })
    })
  })
  describe('Explicit WebDAV directory entry', () => {
    const selection = () => ({ id: savedBackupAccount.id, revision: savedBackupAccount.revision })
    const prepare = () =>
      invoke('relayBackupDirectoryPrepare', selection()) as Promise<RelayWebdavDirectoryPlan>
    const collection = (url: string) =>
      Buffer.from(
        `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
      )
    const transport = (hold?: { method: string; done: Promise<void> }) => {
      const entered = Promise.withResolvers<AbortSignal>(),
        requests: { url: string; method: string; body?: Buffer }[] = []
      let held = false
      fixture.runtimeGistRequest.mockImplementation(
        async (url: string, options: { method: string; body?: Buffer; signal: AbortSignal }) => {
          requests.push({ url, method: options.method, body: options.body })
          if (!held && options.method === hold?.method) {
            held = true
            entered.resolve(options.signal)
            await hold.done
          }
          return {
            status: options.method === 'MKCOL' ? 201 : 207,
            headers: {},
            bytes: options.method === 'MKCOL' ? Buffer.alloc(0) : collection(url)
          }
        }
      )
      return { entered: entered.promise, requests }
    }
    it('prepares only safe saved-account metadata and executes the requested creation without a second prompt', async () => {
      await expect(
        invoke('relayBackupDirectoryPrepare', { ...selection(), directoryURL: 'https://other/' })
      ).rejects.toThrow()
      expect(() => invoke('relayBackupDirectoryCancel')).toThrow('凭据')
      const plan = await prepare()
      expect(plan).toMatchObject({
        ...selection(),
        directoryURL: 'https://dav.example/Relay/',
        parentURL: 'https://dav.example/',
        recursive: false,
        overwrite: false
      })
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      expect(JSON.stringify(plan)).not.toContain('PRIVATE')
      const network = transport()
      expect(
        await invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'created' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.accountCredential).toHaveBeenCalledOnce()
      expect(network.requests.map(({ method }) => method)).toEqual([
        'PROPFIND',
        'MKCOL',
        'PROPFIND'
      ])
    })
    it('uses the same private account for parent validation, one bodyless MKCOL and exact target verification', async () => {
      const plan = await prepare(),
        network = transport()
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      expect(
        await invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId })
      ).toMatchObject({
        status: 'created',
        directoryURL: plan.directoryURL,
        verifiedAt: expect.any(Number)
      })
      expect(network.requests.map(({ url, method }) => [method, url])).toEqual([
        ['PROPFIND', plan.parentURL],
        ['MKCOL', plan.directoryURL],
        ['PROPFIND', plan.directoryURL]
      ])
      expect(network.requests[1].body).toBeUndefined()
      expect(fixture.accountCredential).toHaveBeenCalledExactlyOnceWith(selection())
      for (const [, options] of fixture.runtimeGistRequest.mock.calls)
        expect(options.proxy).toEqual({ host: '127.0.0.1', port: 18191 })
      await expect(
        invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId }) as Promise<unknown>
      ).rejects.toThrow('失效')
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
    })
    it.each(['destroyedContents', 'changedFrame', 'throwingFrame'])(
      'revokes directory context during credential await on %s without relying on a window event',
      async (boundary) => {
        const plan = await prepare(),
          entered = Promise.withResolvers<void>(),
          finish = Promise.withResolvers<{ account: RelayBackupAccount; secret: string }>(),
          descriptor = Object.getOwnPropertyDescriptor(fixture.window.webContents, 'mainFrame')
        if (!descriptor) throw new Error('fixture frame missing')
        fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
        fixture.accountCredential.mockImplementationOnce(async () => {
          entered.resolve()
          return finish.promise
        })
        transport()
        const executing = invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId })
        await entered.promise
        try {
          if (boundary === 'destroyedContents')
            fixture.window.webContents.isDestroyed.mockReturnValue(true)
          else if (boundary === 'changedFrame')
            Object.defineProperty(fixture.window.webContents, 'mainFrame', {
              configurable: true,
              value: {}
            })
          else
            Object.defineProperty(fixture.window.webContents, 'mainFrame', {
              configurable: true,
              get: () => {
                throw new Error('PRIVATE destroyed frame')
              }
            })
          finish.resolve({ account: { ...savedBackupAccount }, secret: 'PRIVATE_late_directory' })
          expect(await executing).toMatchObject({ status: 'rejected', reason: 'unverified' })
          expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
        } finally {
          Object.defineProperty(fixture.window.webContents, 'mainFrame', descriptor)
          fixture.window.webContents.isDestroyed.mockReturnValue(false)
        }
      }
    )
    it('keeps a submitted directory request pending until its reply and preserves uncertainty on eventless context loss', async () => {
      const plan = await prepare(),
        finish = Promise.withResolvers<void>(),
        network = transport({ method: 'MKCOL', done: finish.promise })
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      let settled = false
      const executing = Promise.resolve(
        invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId })
      ).then((result) => {
        settled = true
        return result
      })
      await network.entered
      fixture.window.webContents.isDestroyed.mockReturnValue(true)
      try {
        await Promise.resolve()
        expect(settled).toBe(false)
        finish.resolve()
        expect(await executing).toMatchObject({ status: 'uncertain' })
        expect(network.requests.map(({ method }) => method)).toEqual(['PROPFIND', 'MKCOL'])
      } finally {
        fixture.window.webContents.isDestroyed.mockReturnValue(false)
      }
    })
    it('ignores an old Cancel evidence while waiting for only the matching consumed operation', async () => {
      const old = await prepare(),
        plan = await prepare(),
        finish = Promise.withResolvers<void>(),
        network = transport({ method: 'PROPFIND', done: finish.promise })
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const executing = invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId }),
        signal = await network.entered
      expect(invoke('relayBackupDirectoryCancel', { evidenceId: old.evidenceId })).toBeUndefined()
      expect(signal.aborted).toBe(false)
      let cancelled = false
      const cancellation = Promise.resolve(
        invoke('relayBackupDirectoryCancel', { evidenceId: plan.evidenceId })
      ).then(() => (cancelled = true))
      expect(signal.aborted).toBe(true)
      await Promise.resolve()
      expect(cancelled).toBe(false)
      finish.resolve()
      expect(await executing).toEqual({ status: 'cancelled', submitted: false })
      await cancellation
      expect(network.requests.map(({ method }) => method)).toEqual(['PROPFIND'])
    })
    it('preserves uncertainty after a submitted MKCOL is cancelled and never resends the consumed proof', async () => {
      const plan = await prepare(),
        finish = Promise.withResolvers<void>(),
        network = transport({ method: 'MKCOL', done: finish.promise })
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const executing = invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId }),
        signal = await network.entered,
        cancelling = invoke('relayBackupDirectoryCancel', { evidenceId: plan.evidenceId })
      expect(signal.aborted).toBe(true)
      finish.resolve()
      expect(await executing).toMatchObject({
        status: 'uncertain',
        directoryURL: plan.directoryURL
      })
      await cancelling
      await expect(
        invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId }) as Promise<unknown>
      ).rejects.toThrow('失效')
      expect(network.requests.map(({ method }) => method)).toEqual(['PROPFIND', 'MKCOL'])
    })
    it('holds competing backup and account work but allows the owned proxy mode to commit during credential lookup', async () => {
      const local = await localPreparation()
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const started = (await invoke('relayLocalProxyAction', {
        action: 'start',
        evidenceId: local.evidenceId
      })) as { state: { instanceId: string } }
      const plan = await prepare(),
        entered = Promise.withResolvers<void>(),
        answer = Promise.withResolvers<{ account: RelayBackupAccount; secret: string }>()
      fixture.accountCredential.mockImplementationOnce(async () => {
        entered.resolve()
        return answer.promise
      })
      transport()
      const executing = invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId })
      await entered.promise
      await expect(invoke('relayBackupExport') as Promise<unknown>).rejects.toThrow('目录操作')
      await expect(
        invoke('relayBackupAccountSave', { provider: 'gist', name: 'Other', proxyPort: 18191 })
      ).rejects.toThrow('目录操作')
      expect(
        await invoke('relayLocalProxyAction', {
          action: 'mode',
          instanceId: started.state.instanceId,
          mode: 'global'
        })
      ).toMatchObject({ status: 'modeChanged' })
      answer.resolve({ account: { ...savedBackupAccount }, secret: 'PRIVATE_SAVED_PASSWORD' })
      expect(await executing).toMatchObject({ status: 'created' })
      expect(fixture.localStop).not.toHaveBeenCalled()
    })
    it('allows metadata and requested directory creation while a stable owned TUN forwards without stopping it', async () => {
      fixture.tunStateOverride = {
        phase: 'active',
        pending: false,
        owned: true,
        sessionId: '00000000-0000-4000-8000-000000000030',
        traffic: 'forwarding',
        restorationVerified: false,
        protectionVerified: false,
        warnings: []
      }
      expect(await invoke('relayBackupAccountList')).toMatchObject({
        accounts: [savedBackupAccount]
      })
      const plan = await prepare()
      transport()
      expect(
        await invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId })
      ).toMatchObject({ status: 'created' })
      expect(fixture.accountCredential).toHaveBeenCalledOnce()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it.each(['hide', 'suspend', 'navigation'])(
      'revokes a late credential response on %s before network access',
      async (boundary) => {
        const plan = await prepare(),
          entered = Promise.withResolvers<void>(),
          answer = Promise.withResolvers<{ account: RelayBackupAccount; secret: string }>()
        fixture.accountCredential.mockImplementationOnce(async () => {
          entered.resolve()
          return answer.promise
        })
        const executing = invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId })
        await entered.promise
        if (boundary === 'hide')
          fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
        else if (boundary === 'suspend') {
          for (const [name, listener] of fixture.powerOn.mock.calls)
            if (name === 'suspend') listener()
        } else
          for (const [name, listener] of fixture.window.webContents.on.mock.calls)
            if (name === 'did-start-navigation')
              listener({ isMainFrame: true, isSameDocument: false })
        answer.resolve({ account: { ...savedBackupAccount }, secret: 'PRIVATE_SAVED_PASSWORD' })
        expect(await executing).toEqual({ status: 'cancelled', submitted: false })
        expect(fixture.accountCredential).toHaveBeenCalledOnce()
        expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      }
    )
    it('waits for an entered credential lookup on quit without accepting its late credentials', async () => {
      const plan = await prepare(),
        entered = Promise.withResolvers<void>(),
        answer = Promise.withResolvers<{ account: RelayBackupAccount; secret: string }>()
      fixture.accountCredential.mockImplementationOnce(async () => {
        entered.resolve()
        return answer.promise
      })
      const executing = invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId })
      await entered.promise
      const close = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1],
        preventDefault = vi.fn()
      if (!close) throw new Error('fixture close missing')
      close({ preventDefault })
      expect(preventDefault).toHaveBeenCalled()
      expect(fixture.appQuit).not.toHaveBeenCalled()
      answer.resolve({ account: { ...savedBackupAccount }, secret: 'PRIVATE_SAVED_PASSWORD' })
      expect(await executing).toMatchObject({ status: 'rejected', reason: 'unverified' })
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
      expect(fixture.accountCredential).toHaveBeenCalledOnce()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
    it('drains a submitted directory operation before entering a previously prepared restore transaction', async () => {
      fixture.chooseOpen.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/private/relay.zip']
      })
      const restore = (await invoke('relayBackupImportPrepare')) as { plan: { id: string } },
        plan = await prepare(),
        finish = Promise.withResolvers<void>(),
        network = transport({ method: 'MKCOL', done: finish.promise })
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const executing = invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId }),
        signal = await network.entered,
        restoring = invoke('relayBackupRestore', { id: restore.plan.id })
      expect(signal.aborted).toBe(true)
      expect(fixture.backupCommit).not.toHaveBeenCalled()
      finish.resolve()
      expect(await executing).toMatchObject({ status: 'uncertain' })
      expect(await restoring).toMatchObject({ status: 'restored' })
      expect(fixture.backupCommit).toHaveBeenCalledOnce()
    })
    it('revokes an idle directory proof after a saved account change before any Native or network action', async () => {
      const plan = await prepare()
      await invoke('relayBackupAccountSave', {
        ...selection(),
        name: savedBackupAccount.name,
        provider: 'webdav',
        proxyPort: savedBackupAccount.proxyPort,
        directoryURL: savedBackupAccount.directoryURL,
        username: savedBackupAccount.username
      })
      await expect(
        invoke('relayBackupDirectoryExecute', { evidenceId: plan.evidenceId }) as Promise<unknown>
      ).rejects.toThrow('失效')
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
  })
  describe('WebDAV session-owned retention entry', () => {
    afterEach(async () => {
      fixture.window.webContents.isDestroyed.mockReturnValue(false)
      await invoke('relayBackupScheduleStop', { id: savedBackupAccount.id })
      vi.useRealTimers()
    })
    const retentionRequest = () => ({
      ...scheduleRequest(),
      retention: { kind: 'session-owned' as const, keepCount: 1 }
    })
    const recordedRequest = () => ({
      ...scheduleRequest(),
      retention: { kind: 'recorded-owned' as const, keepCount: 1 }
    })
    it('binds cross-session retention scope to main-only ledger history without granting renderer-supplied facts', async () => {
      let opened = false
      fixture.receiptInspect.mockImplementation(async (binding) => ({
        binding,
        scopeSHA256: profileHash(JSON.stringify(binding)),
        headSHA256: opened ? 'a'.repeat(64) : null,
        sequence: opened ? 0 : -1,
        owned: [],
        uncertain: []
      }))
      fixture.receiptOpen.mockImplementation(async (binding) => {
        opened = true
        return fixture.receiptInspect(binding)
      })
      await expect(
        invoke('relayBackupScheduleArm', {
          ...recordedRequest(),
          history: {
            scopeSHA256: 'a'.repeat(64),
            headSHA256: null,
            ownedCount: 999,
            uncertainCount: 0
          }
        })
      ).rejects.toThrow()
      expect(fixture.receiptInspect).not.toHaveBeenCalled()
      expect(await invoke('relayBackupScheduleArm', recordedRequest())).toMatchObject({
        status: 'armed'
      })
      expect(fixture.receiptInspect).toHaveBeenCalledWith({
        accountId: savedBackupAccount.id,
        directoryURL: savedBackupAccount.directoryURL,
        username: savedBackupAccount.username
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(backupScheduleState().entries[0].retention).toMatchObject({
        kind: 'recorded-owned',
        keepCount: 1
      })
      expect(fixture.receiptOpen).toHaveBeenCalledOnce()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.backupArchive).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
    it('keeps the original renderer frame bound while a recorded history read is pending before Native consent', async () => {
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>(),
        original = fixture.receiptInspect.getMockImplementation()
      if (!original) throw new Error('receipt fixture missing')
      fixture.receiptInspect.mockImplementationOnce(async (binding) => {
        entered.resolve()
        await finish.promise
        return original(binding)
      })
      const pending = invoke('relayBackupScheduleArm', recordedRequest()) as Promise<unknown>
      try {
        await entered.promise
        fixture.window.webContents.isDestroyed.mockReturnValue(true)
        finish.resolve()
        await expect(pending).rejects.toThrow('界面授权已失效')
        expect(fixture.confirmRestore).not.toHaveBeenCalled()
        expect(fixture.receiptOpen).not.toHaveBeenCalled()
        expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      } finally {
        finish.resolve()
      }
    })
    // Run the production upload/readback/conditional-delete transport against
    // a private in-memory endpoint. Only its verified GET can create a receipt.
    const webdav = (options: { strongGetTag?: boolean; failUpload?: number } = {}) => {
      type Request = Parameters<typeof import('../resolve/plugin/http-client').requestOnce>[1]
      const server = {
        files: new Map<string, { bytes: Buffer; etag: string }>(),
        calls: [] as { url: string; method: Request['method'] }[],
        uploaded: [] as string[],
        beforeReply: undefined as
          ((url: string, method: Request['method']) => Promise<void>) | undefined
      }
      fixture.runtimeGistRequest.mockImplementation(async (url: string, input: Request) => {
        expect(url).toMatch(/^https:\/\/dav\.example\/Relay\/[^/]+\.json$/u)
        expect(input.proxy).toEqual({ host: '127.0.0.1', port: 18191 })
        expect(input.headers?.Authorization).toBe(
          `Basic ${Buffer.from('fixture-user:PRIVATE_SAVED_PASSWORD').toString('base64')}`
        )
        server.calls.push({ url, method: input.method })
        await server.beforeReply?.(url, input.method)
        const file = server.files.get(url)
        const response = (status: number, bytes = Buffer.alloc(0), etag?: string) => ({
          status,
          headers: etag ? { etag } : {},
          bytes,
          body: bytes.toString('utf8')
        })
        if (input.method === 'PUT') {
          expect(input.headers?.['If-None-Match']).toBe('*')
          expect(file).toBeUndefined()
          if (options.failUpload === server.uploaded.length + 1) return response(500)
          const bytes = Buffer.from(input.body ?? ''),
            etag = `"fixture-${server.uploaded.length + 1}"`
          server.files.set(url, { bytes, etag })
          server.uploaded.push(url)
          return response(201, Buffer.alloc(0), etag)
        }
        if (input.method === 'HEAD') return response(file ? 200 : 404)
        if (!file) return response(404)
        if (input.method === 'GET') {
          if (input.headers?.['If-Match']) expect(input.headers['If-Match']).toBe(file.etag)
          return response(
            200,
            Buffer.from(file.bytes),
            options.strongGetTag === false ? undefined : file.etag
          )
        }
        if (input.method === 'PROPFIND') {
          expect(input.headers?.Depth).toBe('0')
          return response(
            207,
            Buffer.from(
              `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${file.bytes.length}</d:getcontentlength><d:getetag>${file.etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
            )
          )
        }
        if (input.method === 'DELETE') {
          expect(input.headers?.['If-Match']).toBe(file.etag)
          server.files.delete(url)
          return response(204)
        }
        throw new Error(`Unexpected fixture method ${input.method}`)
      })
      return server
    }
    it('requires explicit valid retention policy and binds deletion to that requested scope without a second prompt', async () => {
      for (const retention of [
        { kind: 'session-owned', keepCount: 0 },
        { kind: 'session-owned', keepCount: 101 },
        { kind: 'session-owned', keepCount: '1' }
      ])
        await expect(
          invoke('relayBackupScheduleArm', { ...scheduleRequest(), retention })
        ).rejects.toThrow()
      await expect(
        invoke('relayBackupScheduleArm', { ...scheduleRequest(), delete: true })
      ).rejects.toThrow()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(await invoke('relayBackupScheduleArm', retentionRequest())).toMatchObject({
        status: 'armed'
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(backupScheduleState().entries[0].retention).toMatchObject({
        kind: 'session-owned',
        keepCount: 1
      })
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.backupArchive).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
    it('keeps an omitted retention policy non-destructive across successful scheduled uploads', async () => {
      const server = webdav()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', scheduleRequest())
      await vi.advanceTimersByTimeAsync(120000)
      expect(server.uploaded).toHaveLength(2)
      expect(server.calls.map(({ method }) => method)).toEqual(['PUT', 'GET', 'PUT', 'GET'])
      expect(server.files.size).toBe(2)
      expect(backupScheduleState().entries[0]).toMatchObject({
        enabled: true,
        lastResult: 'uploaded'
      })
      expect(backupScheduleState().entries[0].retention).toBeUndefined()
      expect(fixture.receiptInspect).not.toHaveBeenCalled()
      expect(fixture.receiptOpen).not.toHaveBeenCalled()
    })
    it('protects the newest backup and deletes only an older receipt from this explicit authorization', async () => {
      const server = webdav(),
        foreign = 'https://dav.example/Relay/previous-session.json'
      server.files.set(foreign, { bytes: Buffer.from('foreign-private-file'), etag: '"foreign"' })
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', scheduleRequest())
      await vi.advanceTimersByTimeAsync(60000)
      const previousGrant = server.uploaded[0]
      await invoke('relayBackupScheduleStop', { id: savedBackupAccount.id })
      await invoke('relayBackupScheduleArm', retentionRequest())
      await vi.advanceTimersByTimeAsync(60000)
      const firstOwned = server.uploaded[1]
      expect(backupScheduleState().entries[0].retention).toMatchObject({
        keepCount: 1,
        ownedCount: 1,
        protectedCount: 1,
        deletedCount: 0,
        lastResult: 'notNeeded'
      })
      await vi.advanceTimersByTimeAsync(60000)
      const newest = server.uploaded[2]
      expect(server.calls.slice(-6)).toEqual([
        { url: newest, method: 'PUT' },
        { url: newest, method: 'GET' },
        { url: firstOwned, method: 'GET' },
        { url: firstOwned, method: 'PROPFIND' },
        { url: firstOwned, method: 'DELETE' },
        { url: firstOwned, method: 'HEAD' }
      ])
      expect([...server.files.keys()].sort()).toEqual([foreign, previousGrant, newest].sort())
      expect(backupScheduleState().entries[0]).toMatchObject({
        enabled: true,
        lastStatus: 'uploaded',
        lastResult: 'uploaded',
        retention: {
          ownedCount: 1,
          protectedCount: 1,
          deletedCount: 1,
          lastResult: 'pruned',
          lastDeletedFilename: new URL(firstOwned).pathname.split('/').at(-1)
        }
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it('does not borrow the PUT ETag when the verified GET has no strong ETag', async () => {
      const server = webdav({ strongGetTag: false })
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', retentionRequest())
      await vi.advanceTimersByTimeAsync(60000)
      expect(server.calls.map(({ method }) => method)).toEqual(['PUT', 'GET'])
      expect(server.files.size).toBe(1)
      expect(backupScheduleState().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'retentionUnsupported',
        lastResult: 'uploaded',
        retention: { deletedCount: 0, lastResult: 'unsupported' }
      })
    })
    it('never prunes an earlier successful backup when the new upload is unconfirmed', async () => {
      const server = webdav({ failUpload: 2 })
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', retentionRequest())
      await vi.advanceTimersByTimeAsync(120000)
      expect(server.calls.map(({ method }) => method)).toEqual(['PUT', 'GET', 'PUT'])
      expect(server.files.has(server.uploaded[0])).toBe(true)
      expect(backupScheduleState().entries[0]).toMatchObject({
        enabled: false,
        lastResult: 'uncertain',
        retention: { deletedCount: 0 }
      })
    })
    it('rechecks private renderer authority after a held owned-file read and before any DELETE', async () => {
      const server = webdav(),
        entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', retentionRequest())
      await vi.advanceTimersByTimeAsync(60000)
      const firstOwned = server.uploaded[0]
      server.beforeReply = async (url, method) => {
        if (url === firstOwned && method === 'GET') {
          entered.resolve()
          await finish.promise
        }
      }
      try {
        await vi.advanceTimersByTimeAsync(60000)
        await entered.promise
        expect(backupScheduleState().entries[0].lastResult).toBe('uploaded')
        fixture.window.webContents.isDestroyed.mockReturnValue(true)
        finish.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(server.calls.filter(({ method }) => method === 'DELETE')).toEqual([])
        expect(server.files.size).toBe(2)
        expect(backupScheduleState().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'uploaded',
          retention: { deletedCount: 0, lastResult: 'failed' }
        })
      } finally {
        finish.resolve()
      }
    })
    it('keeps a submitted retention DELETE uncertain after eventless context loss without erasing upload success', async () => {
      const server = webdav(),
        entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', retentionRequest())
      await vi.advanceTimersByTimeAsync(60000)
      const firstOwned = server.uploaded[0]
      server.beforeReply = async (_url, method) => {
        if (method === 'DELETE') {
          entered.resolve()
          await finish.promise
        }
      }
      try {
        await vi.advanceTimersByTimeAsync(60000)
        await entered.promise
        expect(backupScheduleState()).toMatchObject({
          pending: true,
          entries: [{ lastResult: 'uploaded', retention: { phase: 'deleting' } }]
        })
        fixture.window.webContents.isDestroyed.mockReturnValue(true)
        expect(backupScheduleState().pending).toBe(true)
        finish.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(server.files.has(firstOwned)).toBe(false)
        expect(server.calls.at(-1)).toEqual({ url: firstOwned, method: 'DELETE' })
        expect(backupScheduleState()).toMatchObject({
          pending: false,
          entries: [
            {
              enabled: false,
              lastResult: 'uploaded',
              lastStatus: 'retentionUncertain',
              retention: { deletedCount: 0, lastResult: 'uncertain' }
            }
          ]
        })
        await vi.advanceTimersByTimeAsync(60000)
        expect(server.calls.filter(({ method }) => method === 'DELETE')).toHaveLength(1)
      } finally {
        finish.resolve()
      }
    })
  })
  describe('WebDAV session backup scheduler entry', () => {
    afterEach(() => vi.useRealTimers())
    it.each(['archive', 'credential'] as const)(
      'rejects eventless destroyed renderer context while scheduled %s work is awaiting',
      async (stage) => {
        const entered = Promise.withResolvers<void>(),
          finish = Promise.withResolvers<void>(),
          archive = fixture.backupArchive.getMockImplementation()
        if (!archive) throw new Error('fixture archive missing')
        if (stage === 'archive')
          fixture.backupArchive.mockImplementationOnce(async () => {
            entered.resolve()
            await finish.promise
            return archive()
          })
        else
          fixture.accountCredential.mockImplementationOnce(async () => {
            entered.resolve()
            await finish.promise
            return { account: { ...savedBackupAccount }, secret: 'PRIVATE_SAVED_PASSWORD' }
          })
        fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        await invoke('relayBackupScheduleArm', scheduleRequest())
        await vi.advanceTimersByTimeAsync(60000)
        await entered.promise
        fixture.window.webContents.isDestroyed.mockReturnValue(true)
        try {
          finish.resolve()
          await vi.advanceTimersByTimeAsync(0)
          expect(fixture.remoteUpload.mock.calls.length).toBe(0)
          expect(backupScheduleState().entries[0].enabled).toBe(false)
          if (stage === 'archive') expect(fixture.accountCredential).not.toHaveBeenCalled()
        } finally {
          finish.resolve()
          fixture.window.webContents.isDestroyed.mockReturnValue(false)
          await invoke('relayBackupScheduleStop', { id: savedBackupAccount.id })
        }
      }
    )
    it.each(['destroyedContents', 'changedFrame', 'throwingFrame', 'hiddenView'])(
      'rejects a late scheduler account recheck after %s without relying on lifecycle events',
      async (boundary) => {
        const entered = Promise.withResolvers<void>(),
          answer = Promise.withResolvers<RelayBackupAccount>(),
          descriptor = Object.getOwnPropertyDescriptor(fixture.window.webContents, 'mainFrame')
        if (!descriptor) throw new Error('fixture frame missing')
        fixture.accountRead
          .mockResolvedValueOnce({ ...savedBackupAccount })
          .mockImplementationOnce(async () => {
            entered.resolve()
            return answer.promise
          })
        const arming = invoke('relayBackupScheduleArm', scheduleRequest())
        await entered.promise
        try {
          if (boundary === 'destroyedContents')
            fixture.window.webContents.isDestroyed.mockReturnValue(true)
          else if (boundary === 'hiddenView') fixture.window.isVisible.mockReturnValue(false)
          else if (boundary === 'changedFrame')
            Object.defineProperty(fixture.window.webContents, 'mainFrame', {
              configurable: true,
              value: {}
            })
          else
            Object.defineProperty(fixture.window.webContents, 'mainFrame', {
              configurable: true,
              get: () => {
                throw new Error('PRIVATE destroyed scheduler frame')
              }
            })
          answer.resolve({ ...savedBackupAccount })
          expect(await arming).toMatchObject({ status: 'cancelled', state: { entries: [] } })
          expect(fixture.accountCredential).not.toHaveBeenCalled()
          expect(fixture.backupArchive).not.toHaveBeenCalled()
          expect(fixture.remoteUpload).not.toHaveBeenCalled()
        } finally {
          Object.defineProperty(fixture.window.webContents, 'mainFrame', descriptor)
          fixture.window.webContents.isDestroyed.mockReturnValue(false)
          fixture.window.isVisible.mockReturnValue(true)
          await invoke('relayBackupScheduleStop', { id: savedBackupAccount.id })
        }
      }
    )
    it('checks scheduler context synchronously after the asynchronous transfer guard before marking a write submitted', async () => {
      let captured: RemoteBackupUploadGuards | undefined,
        dispatched = 0
      fixture.remoteUpload.mockImplementationOnce(
        async (
          _request: unknown,
          _envelope: Buffer,
          _signal: AbortSignal,
          recheck: () => Promise<void>,
          guards?: RemoteBackupUploadGuards
        ) => {
          captured = guards
          await recheck()
          fixture.window.webContents.isDestroyed.mockReturnValue(true)
          guards?.assertLive?.()
          ++dispatched
          guards?.submitted?.()
          return { status: 'uploaded' }
        }
      )
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', scheduleRequest())
      try {
        await vi.advanceTimersByTimeAsync(60000)
        expect(captured?.assertLive).toBeTypeOf('function')
        expect(captured?.submitted).toBeTypeOf('function')
        expect(dispatched).toBe(0)
        expect(backupScheduleState().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'scopeChanged'
        })
      } finally {
        fixture.window.webContents.isDestroyed.mockReturnValue(false)
        await invoke('relayBackupScheduleStop', { id: savedBackupAccount.id })
      }
    })
    it('retains uncertainty and its pending barrier after eventless context loss follows a submitted scheduled write', async () => {
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      let dispatched = 0
      fixture.remoteUpload.mockImplementationOnce(
        async (
          _request: unknown,
          _envelope: Buffer,
          _signal: AbortSignal,
          recheck: () => Promise<void>,
          guards?: RemoteBackupUploadGuards
        ) => {
          await recheck()
          guards?.assertLive?.()
          ++dispatched
          guards?.submitted?.()
          entered.resolve()
          await finish.promise
          await recheck()
          guards?.assertLive?.()
          return { status: 'uploaded' }
        }
      )
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', scheduleRequest())
      await vi.advanceTimersByTimeAsync(60000)
      await entered.promise
      fixture.window.webContents.isDestroyed.mockReturnValue(true)
      try {
        expect(backupScheduleState().pending).toBe(true)
        await Promise.resolve()
        expect(backupScheduleState().pending).toBe(true)
        finish.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(backupScheduleState().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'uncertain'
        })
        await vi.advanceTimersByTimeAsync(120000)
        expect(dispatched).toBe(1)
        expect(fixture.remoteUpload).toHaveBeenCalledOnce()
      } finally {
        finish.resolve()
        fixture.window.webContents.isDestroyed.mockReturnValue(false)
        await invoke('relayBackupScheduleStop', { id: savedBackupAccount.id })
      }
    })
    it('keeps schedule reads inert and arms the complete session scope directly on request', async () => {
      expect(() => invoke('relayBackupScheduleState', {})).toThrow('不接受参数')
      expect(backupScheduleState()).toEqual({ pending: false, suspended: false, entries: [] })
      expect(fixture.accountRead).not.toHaveBeenCalled()
      expect(await invoke('relayBackupScheduleArm', scheduleRequest())).toMatchObject({
        status: 'armed',
        state: {
          entries: [
            {
              id: savedBackupAccount.id,
              revision: savedBackupAccount.revision,
              enabled: true,
              schedule: { kind: 'interval', minutes: 1 }
            }
          ]
        }
      })
      expect(fixture.accountRead).toHaveBeenCalledTimes(2)
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.backupArchive).not.toHaveBeenCalled()
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
    })
    it('waits for the first deadline then uses the private account permit without pretending each tick has new native consent', async () => {
      try {
        fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        const armed = (await invoke('relayBackupScheduleArm', scheduleRequest())) as {
          status: string
          state: RelayWebdavBackupSchedulerState
        }
        expect(armed.status).toBe('armed')
        expect(armed.state.entries[0]).toMatchObject({
          enabled: true,
          encrypted: false,
          schedule: { kind: 'interval', minutes: 1 }
        })
        expect(JSON.stringify(armed)).not.toContain('PRIVATE')
        expect(fixture.accountCredential).not.toHaveBeenCalled()
        expect(fixture.backupArchive).not.toHaveBeenCalled()
        expect(fixture.remoteUpload).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(60000)
        expect(fixture.remoteUpload).toHaveBeenCalledOnce()
        expect(fixture.accountCredential).toHaveBeenCalledOnce()
        expect(fixture.backupArchive).toHaveBeenCalledOnce()
        expect(fixture.confirmRestore).not.toHaveBeenCalled()
        expect(fixture.remoteUpload.mock.calls[0][0]).toMatchObject({
          provider: 'webdav',
          action: 'upload',
          username: 'fixture-user',
          password: 'PRIVATE_SAVED_PASSWORD',
          proxyPort: 18191,
          url: expect.stringMatching(
            /^https:\/\/dav\.example\/Relay\/relay-[a-f0-9-]+-[a-f0-9-]+\.json$/u
          )
        })
        expect(fixture.remoteUpload.mock.calls[0][3]).toBeTypeOf('function')
        expect(backupScheduleState().entries[0].lastResult).toBe('uploaded')
        await invoke('relayBackupScheduleStop', { id: savedBackupAccount.id })
        await vi.advanceTimersByTimeAsync(60000)
        expect(fixture.remoteUpload).toHaveBeenCalledOnce()
        expect(fixture.localStop).not.toHaveBeenCalled()
        expect(fixture.coreStop).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
    it('blocks competing mutations during a scheduled write while keeping state and stop available and waiting for settlement', async () => {
      const response = Promise.withResolvers<{ status: 'uploaded' }>()
      let signal: AbortSignal | undefined
      try {
        fixture.remoteUpload.mockImplementationOnce(
          async (
            _request,
            _envelope,
            abort: AbortSignal,
            recheck: () => Promise<void>,
            guards?: RemoteBackupUploadGuards
          ) => {
            await recheck()
            guards?.assertLive?.()
            guards?.submitted?.()
            signal = abort
            return response.promise
          }
        )
        fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        await invoke('relayBackupScheduleArm', scheduleRequest())
        await vi.advanceTimersByTimeAsync(60000)
        expect(signal).toBeDefined()
        expect(backupScheduleState().pending).toBe(true)
        expect(() => invoke('relayConfigEditClear', { expectedRevision: '' })).toThrow('请先结束')
        await expect(invoke('relayBackupAccountSave', {}) as Promise<unknown>).rejects.toThrow(
          '定时备份'
        )
        await expect(invoke('relayBackupAccountList') as Promise<unknown>).rejects.toThrow(
          '定时备份'
        )
        let settled = false
        const stopped = (
          invoke('relayBackupScheduleStop', { id: savedBackupAccount.id }) as Promise<unknown>
        ).then(() => {
          settled = true
        })
        expect(signal?.aborted).toBe(true)
        expect(settled).toBe(false)
        response.resolve({ status: 'uploaded' })
        await stopped
        expect(backupScheduleState().entries[0]).toMatchObject({
          enabled: false,
          lastResult: 'uncertain'
        })
        await vi.advanceTimersByTimeAsync(60000)
        expect(fixture.remoteUpload).toHaveBeenCalledOnce()
      } finally {
        response.resolve({ status: 'uploaded' })
        await invoke('relayBackupScheduleStop', { id: savedBackupAccount.id })
        vi.useRealTimers()
      }
    })
    it('revokes only the changed account schedule after a successful local account update', async () => {
      const second = {
        ...savedBackupAccount,
        id: '00000000-0000-4000-8000-000000000038',
        name: 'Second WebDAV'
      }
      fixture.accountRead.mockImplementation(async (selection: { id: string }) => ({
        ...(selection.id === second.id ? second : savedBackupAccount)
      }))
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      try {
        await invoke('relayBackupScheduleArm', scheduleRequest())
        await invoke('relayBackupScheduleArm', { ...scheduleRequest(), id: second.id })
        await invoke('relayBackupAccountSave', { name: 'fixture' })
        expect(backupScheduleState().entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: savedBackupAccount.id,
              enabled: false,
              lastStatus: 'accountChanged'
            }),
            expect.objectContaining({ id: second.id, enabled: true })
          ])
        )
        expect(fixture.accountCredential).not.toHaveBeenCalled()
        expect(fixture.remoteUpload).not.toHaveBeenCalled()
      } finally {
        await invoke('relayBackupScheduleStop', { id: second.id })
      }
    })
    it('revokes session scheduling on sleep and does not rearm or upload merely because the app resumes', async () => {
      try {
        fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        await invoke('relayBackupScheduleArm', scheduleRequest())
        for (const [name, listener] of fixture.powerOn.mock.calls)
          if (name === 'suspend') listener()
        await vi.advanceTimersByTimeAsync(0)
        expect(backupScheduleState()).toMatchObject({
          suspended: true,
          entries: [expect.objectContaining({ enabled: false, lastStatus: 'suspended' })]
        })
        for (const [name, listener] of fixture.powerOn.mock.calls) if (name === 'resume') listener()
        await vi.advanceTimersByTimeAsync(120000)
        expect(backupScheduleState()).toMatchObject({
          suspended: false,
          entries: [expect.objectContaining({ enabled: false })]
        })
        expect(fixture.confirmRestore).not.toHaveBeenCalled()
        expect(fixture.accountCredential).not.toHaveBeenCalled()
        expect(fixture.remoteUpload).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
    it('revokes the session schedule before hiding a close-to-tray window and never resumes it just because the window is shown', async () => {
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayBackupScheduleArm', scheduleRequest())
      fixture.shellShouldHide.mockReturnValue(true)
      const close = fixture.window.on.mock.calls.find(([name]) => name === 'close')?.[1],
        preventDefault = vi.fn()
      close({ preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(fixture.window.hide).toHaveBeenCalledOnce()
      fixture.shellShowWindow()
      await vi.advanceTimersByTimeAsync(120000)
      expect(backupScheduleState().entries[0]).toMatchObject({
        enabled: false,
        lastStatus: 'stopped'
      })
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.appQuit).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it('revokes local and remote backup proofs and notifies the hidden renderer without pretending the data was restored', async () => {
      fixture.chooseOpen.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/private/backup.zip']
      })
      const local = (await invoke('relayBackupImportPrepare')) as { plan: { id: string } },
        remote = (await invoke('relayBackupRemotePrepare', {
          provider: 'webdav',
          action: 'download',
          url: 'https://dav.example/Relay/a.json',
          username: 'fixture',
          password: 'PRIVATE',
          proxyPort: 18191
        })) as { evidenceId: string }
      fixture.shellShouldHide.mockReturnValue(true)
      const close = fixture.window.on.mock.calls.find(([name]) => name === 'close')?.[1]
      close({ preventDefault: vi.fn() })
      expect(fixture.window.webContents.send).toHaveBeenCalledWith(
        'relayBackupPreparationsInvalidated'
      )
      expect(fixture.window.webContents.send).not.toHaveBeenCalledWith('relayDataRestored')
      await expect(
        invoke('relayBackupRestore', { id: local.plan.id }) as Promise<unknown>
      ).rejects.toThrow('失效')
      await expect(
        invoke('relayBackupRemoteExecute', { evidenceId: remote.evidenceId }) as Promise<unknown>
      ).rejects.toThrow('失效')
      expect(fixture.backupCommit).not.toHaveBeenCalled()
      expect(fixture.remoteDownload).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
    })
    it('lets an entered local restore finish its root checks after a close-to-tray invalidation', async () => {
      fixture.chooseOpen.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/private/backup.zip']
      })
      const local = (await invoke('relayBackupImportPrepare')) as { plan: { id: string } },
        entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.backupCommit.mockImplementationOnce(
        async (_id: string, _baseline: string, assertIdle: () => void) => {
          assertIdle()
          entered.resolve()
          await finish.promise
          assertIdle()
          return 'restored'
        }
      )
      const restoring = invoke('relayBackupRestore', { id: local.plan.id })
      await entered.promise
      fixture.shellShouldHide.mockReturnValue(true)
      const close = fixture.window.on.mock.calls.find(([name]) => name === 'close')?.[1]
      close({ preventDefault: vi.fn() })
      finish.resolve()
      expect(await restoring).toMatchObject({ status: 'restored' })
      expect(fixture.window.hide).toHaveBeenCalledOnce()
      expect(fixture.appQuit).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
    })
    it('discards a late account recheck after main-document replacement and waits before quit', async () => {
      const approval = Promise.withResolvers<RelayBackupAccount>()
      fixture.accountRead
        .mockResolvedValueOnce({ ...savedBackupAccount })
        .mockImplementationOnce(() => approval.promise)
      const pending = invoke('relayBackupScheduleArm', scheduleRequest())
      await vi.waitFor(() => expect(fixture.accountRead).toHaveBeenCalledTimes(2))
      for (const [name, listener] of fixture.window.webContents.on.mock.calls)
        if (name === 'did-start-navigation') listener({ isMainFrame: true, isSameDocument: false })
      const quit = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1]
      quit({ preventDefault: vi.fn() })
      expect(fixture.appQuit).not.toHaveBeenCalled()
      approval.resolve({ ...savedBackupAccount })
      expect(await pending).toMatchObject({ status: 'cancelled' })
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
      expect(backupScheduleState().entries).toEqual([])
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
    })
    it('keeps a stable owned HTTP core running while enabling scheduled backups', async () => {
      const local = await localPreparation()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relayLocalProxyAction', { action: 'start', evidenceId: local.evidenceId })
      expect(await invoke('relayBackupScheduleArm', scheduleRequest())).toMatchObject({
        status: 'armed'
      })
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
    })
    it('allows read-only schedule account selection and direct scheduling during a stable owned TUN session without stopping it', async () => {
      fixture.tunStateOverride = {
        phase: 'active',
        pending: false,
        owned: true,
        sessionId: '00000000-0000-4000-8000-000000000030',
        traffic: 'forwarding',
        restorationVerified: false,
        protectionVerified: false,
        warnings: []
      }
      expect(await invoke('relayBackupAccountList')).toMatchObject({
        accounts: [savedBackupAccount]
      })
      expect(await invoke('relayBackupScheduleArm', scheduleRequest())).toMatchObject({
        status: 'armed'
      })
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
    })
  })
  it('lists recovery metadata while an owned core runs but refuses preparation without interrupting it', async () => {
    const prepared = await localPreparation()
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: prepared.evidenceId })
    expect(() => invoke('relayBackupRecoveryList', { path: '/renderer/record' })).toThrow('不接受')
    expect(await invoke('relayBackupRecoveryList')).toMatchObject([{ version: 2 }])
    expect(fixture.backupRecoveryList).toHaveBeenCalledOnce()
    await expect(
      invoke('relayBackupRecoveryPrepare', {
        id: '00000000-0000-0000-0000-000000000037',
        action: 'resume'
      }) as Promise<unknown>
    ).rejects.toThrow('核心')
    expect(fixture.backupRecoveryPrepare).not.toHaveBeenCalled()
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.coreStop).not.toHaveBeenCalled()
  })
  it('requires fresh recovery evidence and directly executes the prepared rollback', async () => {
    const prepared = (await invoke('relayBackupRecoveryPrepare', {
      id: '00000000-0000-0000-0000-000000000037',
      action: 'rollback'
    })) as { plan: RelayBackupRecoveryPlan }
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(
      await invoke('relayBackupRecoveryCommit', { evidenceId: prepared.plan.evidenceId })
    ).toEqual({
      status: 'restored'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.backupRecoveryCommit).toHaveBeenCalledWith(
      prepared.plan.evidenceId,
      expect.any(Function)
    )
    expect(fixture.backupRecoveryDiscard).toHaveBeenCalledWith(prepared.plan.evidenceId)
    await expect(
      invoke('relayBackupRecoveryCommit', {
        evidenceId: prepared.plan.evidenceId
      }) as Promise<unknown>
    ).rejects.toThrow('失效')
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('revokes a pending recovery admission across sleep before any data move', async () => {
    const prepared = (await invoke('relayBackupRecoveryPrepare', {
      id: '00000000-0000-0000-0000-000000000037',
      action: 'resume'
    })) as { plan: RelayBackupRecoveryPlan }
    const pending = invoke('relayBackupRecoveryCommit', { evidenceId: prepared.plan.evidenceId })
    expect(() => invoke('relayConfigEditClear')).toThrow('尚未结束')
    for (const [name, listener] of fixture.powerOn.mock.calls) if (name === 'suspend') listener()
    await expect(pending as Promise<unknown>).rejects.toThrow('失效')
    expect(fixture.backupRecoveryCommit).not.toHaveBeenCalled()
    expect(fixture.window.webContents.send).not.toHaveBeenCalledWith('relayDataRestored')
    await expect(
      invoke('relayBackupRecoveryCommit', {
        evidenceId: prepared.plan.evidenceId
      }) as Promise<unknown>
    ).rejects.toThrow('失效')
  })
  it('waits for a confirmed recovery transaction across quit without invalidating its root rechecks', async () => {
    const prepared = (await invoke('relayBackupRecoveryPrepare', {
      id: '00000000-0000-0000-0000-000000000037',
      action: 'rollback'
    })) as { plan: RelayBackupRecoveryPlan }
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>()
    fixture.backupRecoveryCommit.mockImplementationOnce(
      async (_id: string, assertIdle: () => void) => {
        assertIdle()
        entered.resolve()
        await finish.promise
        assertIdle()
        return 'rolled-back'
      }
    )
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const pending = invoke('relayBackupRecoveryCommit', { evidenceId: prepared.plan.evidenceId })
    await entered.promise
    const quit = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1]
    quit({ preventDefault: vi.fn() })
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(() => invoke('relayProfilePrepare')).toThrow('退出恢复')
    finish.resolve()
    expect(await pending).toEqual({ status: 'rolled-back' })
    expect(fixture.window.webContents.send).toHaveBeenCalledWith('relayDataRestored')
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
  })
  it.each(['window', 'contents'] as const)(
    'does not restore a prepared archive after eventless %s destruction',
    async (target) => {
      fixture.chooseOpen.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/private/relay.zip']
      })
      const prepared = (await invoke('relayBackupImportPrepare')) as { plan: { id: string } }
      if (target === 'window') fixture.window.isDestroyed.mockReturnValue(true)
      else fixture.window.webContents.isDestroyed.mockReturnValue(true)
      expect(await invoke('relayBackupRestore', { id: prepared.plan.id })).toEqual({
        status: 'cancelled'
      })
      expect(fixture.backupCommit).not.toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
    }
  )
  it('uses only a native-selected legacy ZIP and directly restores the merged migration', async () => {
    await expect(
      invoke('relayBackupLegacyPrepare', { sourcePath: '/renderer/backup.zip' }) as Promise<unknown>
    ).rejects.toThrow('可选本地代理端口')
    expect(fixture.chooseOpen).not.toHaveBeenCalled()
    fixture.chooseOpen.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/private/legacy.zip']
    })
    fixture.binaryRead.mockResolvedValueOnce(Buffer.from('legacy source ZIP'))
    const prepared = (await invoke('relayBackupLegacyPrepare', { proxyPort: 17891 })) as {
      plan: { id: string }
    }
    expect(fixture.chooseOpen).toHaveBeenCalledWith(
      fixture.window,
      expect.objectContaining({ title: '选择旧版Clash Party ZIP（仅检查迁移）' })
    )
    expect(fixture.legacyPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        stateRoot: '/fake/home/Library/Application Support/Relay-Preview'
      }),
      Buffer.from('legacy source ZIP'),
      { directories: [], entries: [] },
      17891,
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(fixture.backupStage).toHaveBeenCalledWith(
      Buffer.from('merged legacy fixture archive'),
      'a'.repeat(64)
    )
    expect(fixture.legacyRecordPlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: prepared.plan.id })
    )
    expect(await invoke('relayBackupRestore', { id: prepared.plan.id })).toEqual({
      status: 'restored'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.backupCommit).toHaveBeenCalledWith(
      prepared.plan.id,
      'a'.repeat(64),
      expect.any(Function)
    )
    expect(fixture.remoteDownload).not.toHaveBeenCalled()
    expect(fixture.subscriptionDownload).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('restores a prepared inactive theme-only migration without a second prompt', async () => {
    fixture.chooseOpen.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/private/legacy.zip']
    })
    fixture.binaryRead.mockResolvedValueOnce(Buffer.from('legacy theme ZIP'))
    fixture.legacyPrepare.mockResolvedValueOnce({
      migrationId: '00000000-0000-0000-0000-000000000038',
      archiveBytes: Buffer.from('theme-only candidate'),
      expectedBaselineSHA256: 'a'.repeat(64),
      report: {
        format: 'clash-party-legacy-zip',
        archiveSHA256: 'e'.repeat(64),
        containsSecrets: true,
        files: [
          {
            path: 'themes/imported.css',
            bytes: 6,
            sha256: 'f'.repeat(64),
            disposition: 'applied',
            reason: 'theme-added-to-library-not-enabled'
          }
        ],
        profiles: [],
        counts: {
          profiles: 0,
          sources: 0,
          overrides: 0,
          rulePatches: 0,
          applied: 1,
          retained: 0,
          'decision-required': 0
        }
      },
      recordPlan: fixture.legacyRecordPlan
    })
    const prepared = (await invoke('relayBackupLegacyPrepare')) as { plan: { id: string } }
    expect(await invoke('relayBackupRestore', { id: prepared.plan.id })).toEqual({
      status: 'restored'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.backupCommit).toHaveBeenCalledWith(
      prepared.plan.id,
      'a'.repeat(64),
      expect.any(Function)
    )
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('restores a partial Sub-Store-only migration as inactive definitions', async () => {
    fixture.chooseOpen.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/private/legacy.zip']
    })
    fixture.binaryRead.mockResolvedValueOnce(Buffer.from('legacy Sub-Store ZIP'))
    fixture.legacyPrepare.mockResolvedValueOnce({
      migrationId: '00000000-0000-0000-0000-000000000038',
      archiveBytes: Buffer.from('Sub-Store-only candidate'),
      expectedBaselineSHA256: 'a'.repeat(64),
      report: {
        format: 'clash-party-legacy-zip',
        archiveSHA256: 'e'.repeat(64),
        containsSecrets: true,
        files: [],
        profiles: [],
        substore: {
          schema: '2.0',
          subscriptions: 1,
          collections: 1,
          items: [
            {
              kind: 'section',
              oldName: 'artifacts',
              disposition: 'retained',
              reason: '旧任务保留原件'
            }
          ]
        },
        counts: {
          profiles: 0,
          sources: 0,
          overrides: 0,
          rulePatches: 0,
          applied: 0,
          retained: 1,
          'decision-required': 1
        }
      },
      recordPlan: fixture.legacyRecordPlan
    })
    const prepared = (await invoke('relayBackupLegacyPrepare')) as { plan: { id: string } }
    expect(await invoke('relayBackupRestore', { id: prepared.plan.id })).toEqual({
      status: 'restored'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.backupCommit).toHaveBeenCalledWith(
      prepared.plan.id,
      'a'.repeat(64),
      expect.any(Function)
    )
    expect(fixture.remoteDownload).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('requires a fixed old Relay source and reads records only on an explicit inspection request', async () => {
    await expect(
      invoke('relayBackupLegacyRelayInspect', {
        origin: 'Relay-Preview',
        path: '/injected'
      }) as Promise<unknown>
    ).rejects.toThrow('固定来源')
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(
      await invoke('relayBackupLegacyRelayInspect', { origin: 'Relay-Preview' })
    ).toMatchObject({
      status: 'inspected'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.legacyRelayFactory).toHaveBeenCalledWith({ home: '/fake/home' })
    expect(fixture.legacyRelayInspect).toHaveBeenCalledWith(
      { origin: 'Relay-Preview' },
      expect.any(AbortSignal)
    )
    expect(fixture.legacyRelayRecord).not.toHaveBeenCalled()
    expect(fixture.backupStage).not.toHaveBeenCalled()
  })
  it('keeps old Relay inspection, subset preparation and final copy request separate', async () => {
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const inspected = (await invoke('relayBackupLegacyRelayInspect', {
      origin: 'Relay-Preview'
    })) as { inspection: LegacyRelayInspection }
    expect(fixture.legacyRelayInspect).toHaveBeenCalledWith(
      { origin: 'Relay-Preview' },
      expect.any(AbortSignal)
    )
    expect(fixture.legacyRelayRecord).not.toHaveBeenCalled()
    const selected = inspected.inspection.profiles[0],
      request = {
        inspectionId: inspected.inspection.inspectionId,
        profiles: [{ id: selected.id, sha256: selected.sha256, revision: selected.revision }]
      }
    const prepared = (await invoke('relayBackupLegacyRelayPrepare', request)) as {
      plan: { id: string }
    }
    expect(fixture.legacyRelayRecord).toHaveBeenCalledWith(
      { home: '/fake/home', stateRoot: '/fake/home/Library/Application Support/Relay-Preview' },
      { directories: [], entries: [] },
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function)
    )
    expect(fixture.backupCommit).not.toHaveBeenCalled()
    expect(await invoke('relayBackupRestore', { id: prepared.plan.id })).toEqual({
      status: 'restored'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.backupCommit).toHaveBeenCalledWith(
      prepared.plan.id,
      'a'.repeat(64),
      expect.any(Function)
    )
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(fixture.remoteDownload).not.toHaveBeenCalled()
  })
  it('does not read old Relay source data if the private owner silently disappears before inspection', async () => {
    fixture.window.isVisible.mockReturnValue(false)
    expect(await invoke('relayBackupLegacyRelayInspect', { origin: 'Relay' })).toEqual({
      status: 'cancelled'
    })
    expect(fixture.legacyRelayInspect).not.toHaveBeenCalled()
    expect(fixture.legacyRelayRecord).not.toHaveBeenCalled()
    expect(fixture.backupStage).not.toHaveBeenCalled()
  })
  it('does not publish late old Relay inspection after the owner silently disappears during source reads', async () => {
    const read = Promise.withResolvers<LegacyRelayInspection>()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    fixture.legacyRelayInspect.mockReturnValueOnce(read.promise)
    const pending = invoke('relayBackupLegacyRelayInspect', { origin: 'Relay-Preview' })
    await vi.waitFor(() => expect(fixture.legacyRelayInspect).toHaveBeenCalledOnce())
    fixture.window.isVisible.mockReturnValue(false)
    read.resolve(legacyRelayInspectionFixture())
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(fixture.legacyRelayRecord).not.toHaveBeenCalled()
    expect(fixture.backupStage).not.toHaveBeenCalled()
  })
  it('does not publish a late old Relay candidate when its original inspection owner is silently lost', async () => {
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const inspected = (await invoke('relayBackupLegacyRelayInspect', {
        origin: 'Relay-Preview'
      })) as { inspection: LegacyRelayInspection },
      selected = inspected.inspection.profiles[0],
      publication = Promise.withResolvers<ReturnType<typeof legacyRelayRecordFixture>>()
    fixture.legacyRelayRecord.mockReturnValueOnce(publication.promise)
    const pending = invoke('relayBackupLegacyRelayPrepare', {
      inspectionId: inspected.inspection.inspectionId,
      profiles: [{ id: selected.id, sha256: selected.sha256, revision: selected.revision }]
    })
    await vi.waitFor(() => expect(fixture.legacyRelayRecord).toHaveBeenCalledOnce())
    fixture.window.isVisible.mockReturnValue(false)
    publication.resolve(legacyRelayRecordFixture())
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(fixture.backupStage).not.toHaveBeenCalled()
    expect(fixture.backupCommit).not.toHaveBeenCalled()
  })
  it('does not commit old Relay copies if the private owner disappears before the final copy request', async () => {
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const inspected = (await invoke('relayBackupLegacyRelayInspect', {
        origin: 'Relay-Preview'
      })) as { inspection: LegacyRelayInspection },
      selected = inspected.inspection.profiles[0],
      prepared = (await invoke('relayBackupLegacyRelayPrepare', {
        inspectionId: inspected.inspection.inspectionId,
        profiles: [{ id: selected.id, sha256: selected.sha256, revision: selected.revision }]
      })) as { plan: { id: string } }
    fixture.window.isVisible.mockReturnValue(false)
    expect(await invoke('relayBackupRestore', { id: prepared.plan.id })).toEqual({
      status: 'cancelled'
    })
    expect(fixture.backupCommit).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('rechecks old Relay copy ownership after the action admission yields and before entering the file transaction', async () => {
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const inspected = (await invoke('relayBackupLegacyRelayInspect', {
        origin: 'Relay-Preview'
      })) as { inspection: LegacyRelayInspection },
      selected = inspected.inspection.profiles[0],
      prepared = (await invoke('relayBackupLegacyRelayPrepare', {
        inspectionId: inspected.inspection.inspectionId,
        profiles: [{ id: selected.id, sha256: selected.sha256, revision: selected.revision }]
      })) as { plan: { id: string } }
    const pending = invoke('relayBackupRestore', { id: prepared.plan.id })
    fixture.window.isVisible.mockReturnValue(false)
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(fixture.backupCommit).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('allows only old Relay metadata inspection during stable TUN forwarding while keeping copy preparation blocked', async () => {
    fixture.tunStateOverride = {
      phase: 'active',
      pending: false,
      owned: true,
      sessionId: '00000000-0000-4000-8000-000000000030',
      traffic: 'forwarding',
      restorationVerified: false,
      protectionVerified: false,
      warnings: []
    }
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const inspected = (await invoke('relayBackupLegacyRelayInspect', {
        origin: 'Relay-Preview'
      })) as { inspection: LegacyRelayInspection },
      selected = inspected.inspection.profiles[0]
    expect(fixture.legacyRelayInspect).toHaveBeenCalledOnce()
    await expect(
      invoke('relayBackupLegacyRelayPrepare', {
        inspectionId: inspected.inspection.inspectionId,
        profiles: [{ id: selected.id, sha256: selected.sha256, revision: selected.revision }]
      }) as Promise<unknown>
    ).rejects.toThrow('TUN')
    expect(fixture.legacyRelayRecord).not.toHaveBeenCalled()
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.coreStop).not.toHaveBeenCalled()
  })
  it('keeps old Relay metadata inspection blocked while an owned TUN transition is pending', async () => {
    fixture.tunStateOverride = {
      phase: 'active',
      pending: true,
      owned: true,
      sessionId: '00000000-0000-4000-8000-000000000030',
      traffic: 'forwarding',
      restorationVerified: false,
      protectionVerified: false,
      warnings: []
    }
    await expect(
      invoke('relayBackupLegacyRelayInspect', { origin: 'Relay-Preview' }) as Promise<unknown>
    ).rejects.toThrow('TUN')
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.legacyRelayInspect).not.toHaveBeenCalled()
    expect(fixture.localStop).not.toHaveBeenCalled()
    expect(fixture.coreStop).not.toHaveBeenCalled()
  })
  it('cancels legacy preparation on quit and waits for its cleanup before leaving', async () => {
    fixture.chooseOpen.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/private/legacy.zip']
    })
    const entered = Promise.withResolvers<AbortSignal>(),
      finish = Promise.withResolvers<void>()
    const prepared = fixture.legacyPrepare.getMockImplementation()
    if (!prepared) throw new Error('Missing legacy fixture')
    fixture.legacyPrepare.mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve(args[4] as AbortSignal)
      await finish.promise
      return prepared(...args)
    })
    const pending = invoke('relayBackupLegacyPrepare')
    const signal = await entered.promise
    const quit = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1]
    quit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(fixture.appQuit).not.toHaveBeenCalled()
    finish.resolve()
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(fixture.backupStage).not.toHaveBeenCalled()
    expect(fixture.legacyRecordPlan).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
  })
  it('revokes a local backup proof when the main renderer document is replaced', async () => {
    fixture.chooseOpen.mockResolvedValueOnce({ canceled: false, filePaths: ['/private/relay.zip'] })
    const prepared = (await invoke('relayBackupImportPrepare')) as { plan: { id: string } }
    for (const [name, listener] of fixture.window.webContents.on.mock.calls)
      if (name === 'did-start-navigation') listener({ isMainFrame: true, isSameDocument: false })
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await expect(
      invoke('relayBackupRestore', { id: prepared.plan.id }) as Promise<unknown>
    ).rejects.toThrow('失效')
    expect(fixture.backupCommit).not.toHaveBeenCalled()
    expect(fixture.backupDiscard).toHaveBeenCalledWith(prepared.plan.id)
  })
  describe('Override library entry', () => {
    afterEach(() => vi.useRealTimers())
    const prepare = async (): Promise<OverrideLibraryFetchPlan> => {
      const record = libraryRecordFixture()
      return (await invoke('relayOverrideLibraryFetchPrepare', {
        id: record.item.id,
        expectedLibraryRevision: record.revision,
        expectedMetadataRevision: record.item.metadataRevision,
        expectedBodyRevision: record.item.bodyRevision
      })) as OverrideLibraryFetchPlan
    }
    const execute = async (plan: OverrideLibraryFetchPlan): Promise<OverrideLibraryFetchResult> =>
      (await invoke('relayOverrideLibraryFetchExecute', {
        evidenceId: plan.evidenceId
      })) as OverrideLibraryFetchResult
    const response = () => ({
      status: 200,
      headers: {},
      body: '',
      bytes: Buffer.from('log-level: warning\n')
    })
    it('lists safe library summaries only on explicit invocation without reading content, executing or requesting', async () => {
      expect(() => invoke('relayOverrideLibraryList', {})).toThrow('不接受参数')
      const result = await invoke('relayOverrideLibraryList')
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https:|content/u)
      expect(fixture.libraryList).toHaveBeenCalledOnce()
      expect(fixture.libraryRead).not.toHaveBeenCalled()
      expect(fixture.runtimeScript).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
    it('bootstraps the real private profile revision from only inventory id and SHA, then rejects an incomplete mutation target', async () => {
      const target = {
          id: '00000000-0000-0000-0000-000000000001',
          sha256: profileHash(profileRuntimeSource)
        },
        bindings = (await invoke('relayOverrideLibraryBindingsRead', {
          target
        })) as OverrideLibraryBindings
      expect(bindings.target).toEqual({ ...target, revision: 'a'.repeat(64) })
      expect(fixture.profileRead).toHaveBeenCalledWith(target)
      await expect(
        invoke('relayOverrideLibraryBind', {
          expectedEditRevision: bindings.editRevision,
          target,
          refs: []
        }) as Promise<unknown>
      ).rejects.toThrow('修订')
      expect(fixture.editSave).not.toHaveBeenCalled()
    })
    it('preserves ordinary inline edits and old snapshots across a cache head update until explicit reference refresh', async () => {
      const record = libraryRecordFixture(),
        ordinary = { id: 'existing-inline', kind: 'yaml', content: 'mode: rule\n' }
      fixture.editRead.mockResolvedValue({
        document: { globalOverrides: [ordinary], profileOverrides: [], controlled: {} },
        revision: '',
        exists: false
      })
      const first = (await invoke('relayOverrideLibraryBind', {
        expectedEditRevision: '',
        refs: [{ id: record.item.id, bodyRevision: record.item.bodyRevision }]
      })) as OverrideLibraryBindings
      expect(first.globalRefs).toEqual([
        { id: record.item.id, bodyRevision: record.item.bodyRevision }
      ])
      const next = {
        ...record,
        revision: '6'.repeat(64),
        item: {
          ...record.item,
          content: 'log-level: debug\n',
          bodyRevision: profileHash('log-level: debug\n')
        }
      }
      fixture.libraryRead.mockResolvedValue(next)
      const same = (await invoke('relayOverrideLibraryBind', {
        expectedEditRevision: first.editRevision,
        refs: first.globalRefs
      })) as OverrideLibraryBindings
      expect(same.globalRefs).toEqual(first.globalRefs)
      expect(fixture.editSave.mock.lastCall?.[0].globalOverrides).toContainEqual(ordinary)
      expect(fixture.editSave.mock.lastCall?.[0].globalOverrides).toContainEqual({
        id: `relay-override-library:${record.item.id}`,
        kind: 'yaml',
        content: record.item.content
      })
      const refreshed = (await invoke('relayOverrideLibraryRefresh', {
        expectedEditRevision: same.editRevision,
        refs: [
          {
            id: record.item.id,
            expectedOldBodyRevision: record.item.bodyRevision,
            bodyRevision: next.item.bodyRevision
          }
        ]
      })) as OverrideLibraryBindings
      expect(refreshed.globalRefs).toEqual([
        { id: record.item.id, bodyRevision: next.item.bodyRevision }
      ])
      expect(fixture.editSave.mock.lastCall?.[0].globalOverrides).toContainEqual(ordinary)
      expect(fixture.runtimeScript).not.toHaveBeenCalled()
      expect(fixture.localReload).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
    })
    it('prepares a redacted saved-source fetch and fetches only on the explicit execute action', async () => {
      const plan = await prepare()
      expect(plan).toMatchObject({
        action: 'fetchOverride',
        endpoint: 'https://overrides.example',
        proxyPort: 18191
      })
      expect(JSON.stringify(plan)).not.toContain('PRIVATE')
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      fixture.runtimeGistRequest.mockResolvedValueOnce(response())
      expect(await execute(plan)).toMatchObject({ status: 'updated' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(JSON.stringify(fixture.confirmRestore.mock.calls)).not.toContain('PRIVATE')
      expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce()
      expect(fixture.libraryFetched).toHaveBeenCalledOnce()
      expect(fixture.editSave).not.toHaveBeenCalled()
    })
    it('rejects a missing library reference in an inactive profile through the real manual JSON save entry before persisting', async () => {
      const missing = 'relay-override-library:00000000-0000-4000-8000-000000000099'
      fixture.libraryAssertBindings.mockRejectedValueOnce(new Error('覆写库引用缺失或类型已变化。'))
      await expect(
        invoke('relayConfigEditSave', {
          expectedRevision: '',
          document: {
            globalOverrides: [],
            profileOverrides: [],
            controlled: {},
            profileOverrideSets: [
              {
                profileId: '00000000-0000-0000-0000-000000000001',
                overrides: [{ id: missing, kind: 'yaml', content: '{}' }]
              }
            ]
          }
        }) as Promise<unknown>
      ).rejects.toThrow('覆写库引用')
      expect(fixture.libraryAssertBindings).toHaveBeenCalledWith([{ id: missing, kind: 'yaml' }])
      expect(fixture.editSave).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
    })
    it('fetches one exact saved URL through the fixed proxy and publishes only a cache summary without applying it', async () => {
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockResolvedValueOnce(response())
      const result = await execute(await prepare())
      expect(result).toMatchObject({ status: 'updated', item: { bodyState: 'current' } })
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https:|content/u)
      expect(fixture.runtimeGistRequest).toHaveBeenCalledExactlyOnceWith(
        libraryRecordFixture().item.remote?.url,
        expect.objectContaining({
          method: 'GET',
          maxBytes: 128 * 1024,
          proxy: { host: '127.0.0.1', port: 18191 },
          signal: expect.any(AbortSignal)
        })
      )
      expect(fixture.libraryFetched).toHaveBeenCalledOnce()
      expect(fixture.editSave).not.toHaveBeenCalled()
      expect(fixture.runtimeScript).not.toHaveBeenCalled()
      expect(fixture.localReload).not.toHaveBeenCalled()
    })
    it('captures the private renderer before the saved-definition await and rejects a lost owner before a request', async () => {
      const read = Promise.withResolvers<OverrideLibraryRecord>()
      fixture.libraryRead.mockReturnValueOnce(read.promise)
      const pending = prepare()
      fixture.window.isVisible.mockReturnValue(false)
      read.resolve(libraryRecordFixture())
      await expect(pending).rejects.toThrow()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      expect(fixture.libraryFetched).not.toHaveBeenCalled()
    })
    it('keeps cancel and reciprocal edit gates until the held GET actually settles', async () => {
      const plan = await prepare(),
        network = Promise.withResolvers<ReturnType<typeof response>>()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockReturnValueOnce(network.promise)
      const pending = execute(plan)
      await vi.waitFor(() => expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce())
      let idle = false
      const cancelling = (
        invoke('relayOverrideLibraryFetchCancel', {
          evidenceId: plan.evidenceId
        }) as Promise<void>
      ).then(() => {
        idle = true
      })
      try {
        await Promise.resolve()
        expect(idle).toBe(false)
        expect(() => invoke('relayConfigEditClear')).toThrow('覆写库')
      } finally {
        network.resolve(response())
      }
      expect(await pending).toEqual({ status: 'cancelled' })
      await cancelling
      expect(fixture.libraryFetched).not.toHaveBeenCalled()
      expect(fixture.editClear).not.toHaveBeenCalled()
    })
    it('returns the real cache-write outcome after admission even if the owner hides during that local write', async () => {
      const write = Promise.withResolvers<OverrideLibraryRecord>()
      fixture.libraryFetched.mockReturnValueOnce(write.promise)
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockResolvedValueOnce(response())
      const pending = execute(await prepare())
      await vi.waitFor(() => expect(fixture.libraryFetched).toHaveBeenCalledOnce())
      for (const [name, listener] of fixture.window.on.mock.calls) if (name === 'hide') listener()
      expect(() => invoke('relayConfigEditClear')).toThrow('覆写库')
      write.resolve(libraryRecordFixture())
      expect(await pending).toMatchObject({ status: 'updated' })
      expect(fixture.editSave).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it('allows inert library management during stable owned TUN forwarding without capture, stop or hot reload', async () => {
      fixture.tunStateOverride = {
        phase: 'active',
        pending: false,
        owned: true,
        sessionId: '00000000-0000-4000-8000-000000000030',
        traffic: 'forwarding',
        restorationVerified: false,
        protectionVerified: false,
        warnings: []
      }
      expect(await invoke('relayOverrideLibraryList')).toMatchObject({ exists: true })
      const record = libraryRecordFixture()
      expect(
        await invoke('relayOverrideLibraryBind', {
          expectedEditRevision: '',
          refs: [{ id: record.item.id, bodyRevision: record.item.bodyRevision }]
        })
      ).toMatchObject({ globalRefs: [{ id: record.item.id }] })
      expect(fixture.tunCapture).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
      expect(fixture.localReload).not.toHaveBeenCalled()
    })
    it('waits for a held local library operation before quitting', async () => {
      const list = Promise.withResolvers<{ revision: string; exists: boolean; items: [] }>()
      fixture.libraryList.mockReturnValueOnce(list.promise)
      const pending = invoke('relayOverrideLibraryList')
      await vi.waitFor(() => expect(fixture.libraryList).toHaveBeenCalledOnce())
      const quit = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1]
      quit({ preventDefault: vi.fn() })
      expect(fixture.appQuit).not.toHaveBeenCalled()
      list.resolve({ revision: '', exists: false, items: [] })
      expect(await pending).toMatchObject({ items: [] })
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    })
  })
  describe('Runtime Gist candidate discovery entry', () => {
    afterEach(() => vi.useRealTimers())
    const account: RelayBackupAccount = {
      id: savedBackupAccount.id,
      revision: savedBackupAccount.revision,
      name: 'Saved Gist fixture',
      provider: 'gist',
      proxyPort: 18191,
      state: 'active',
      hasCredential: true,
      createdAt: 1,
      updatedAt: 1
    }
    const metadata = (id: string) => ({
      id,
      description: 'Auto Synced Clash Party Runtime Config',
      public: false,
      updated_at: '2026-11-01T00:00:00Z',
      files: {
        'clash-party.yaml': {
          filename: 'clash-party.yaml',
          size: 42,
          raw_url: 'https://do-not-read.invalid/PRIVATE',
          content: 'PRIVATE accidental response field'
        }
      }
    })
    const response = () => ({
      status: 200,
      headers: { link: '<https://do-not-follow.invalid/>; rel="next"' },
      body: '',
      bytes: Buffer.from(JSON.stringify([metadata('abcde'), metadata('abcdf')]))
    })
    const prepare = async (page = 1): Promise<RelayRuntimeGistDiscoveryPlan> => {
      fixture.accountRead.mockResolvedValue({ ...account })
      fixture.accountCredential.mockResolvedValue({
        account,
        secret: 'PRIVATE_GIST_DISCOVERY_TOKEN'
      })
      return (await invoke('relayRuntimeGistDiscoveryPrepare', {
        id: account.id,
        revision: account.revision,
        page
      })) as RelayRuntimeGistDiscoveryPlan
    }
    const execute = async (
      plan: RelayRuntimeGistDiscoveryPlan
    ): Promise<RelayRuntimeGistDiscoveryResult> =>
      (await invoke('relayRuntimeGistDiscoveryExecute', {
        evidenceId: plan.evidenceId
      })) as RelayRuntimeGistDiscoveryResult
    it('prepares only saved public metadata without decrypting, reading runtime or requesting a list', async () => {
      const plan = await prepare(2)
      expect(plan).toMatchObject({
        action: 'listRuntimeCandidates',
        endpoint: 'https://api.github.com/gists?per_page=100&page=2',
        filename: 'clash-party.yaml',
        perPage: 100
      })
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.tunCapture).not.toHaveBeenCalled()
    })
    it('reads credentials and metadata only on the explicit execute action', async () => {
      const plan = await prepare()
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
      fixture.runtimeGistRequest.mockResolvedValueOnce(response())
      expect(await execute(plan)).toMatchObject({ status: 'listed' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(JSON.stringify(fixture.confirmRestore.mock.calls)).not.toContain('PRIVATE')
      expect(fixture.accountCredential).toHaveBeenCalledOnce()
      expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce()
    })
    it('lists all matching metadata candidates through one fixed GET without capturing or writing runtime content', async () => {
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockResolvedValueOnce(response())
      const result = await execute(await prepare())
      expect(result).toMatchObject({
        status: 'listed',
        page: 1,
        scanned: 2,
        nextPage: 2,
        entries: [
          { id: 'abcde', verified: false },
          { id: 'abcdf', verified: false }
        ]
      })
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|raw_url|content/u)
      expect(fixture.runtimeGistRequest).toHaveBeenCalledExactlyOnceWith(
        'https://api.github.com/gists?per_page=100&page=1',
        expect.objectContaining({
          method: 'GET',
          proxy: { host: '127.0.0.1', port: 18191 },
          maxBytes: 2 * 1024 * 1024,
          headers: expect.objectContaining({ Authorization: 'Bearer PRIVATE_GIST_DISCOVERY_TOKEN' })
        })
      )
      expect(fixture.tunCapture).not.toHaveBeenCalled()
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
      expect(fixture.backupCommit).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
    })
    it('binds private renderer ownership before the first metadata read and refuses a replaced owner', async () => {
      const read = Promise.withResolvers<RelayBackupAccount>()
      fixture.accountRead.mockReturnValueOnce(read.promise)
      const pending = invoke('relayRuntimeGistDiscoveryPrepare', {
        id: account.id,
        revision: account.revision
      })
      fixture.window.isVisible.mockReturnValue(false)
      read.resolve(account)
      await expect(pending as Promise<unknown>).rejects.toThrow('候选准备未通过')
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
    it('revokes consent when the window disappears before execution before decrypting a Token', async () => {
      const plan = await prepare()
      fixture.window.isVisible.mockReturnValue(false)
      expect(await execute(plan)).toEqual({ status: 'cancelled' })
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
    it('checks renderer ownership again after credential await before starting the list GET', async () => {
      const plan = await prepare()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.accountCredential.mockImplementationOnce(async () => {
        queueMicrotask(() => fixture.window.isVisible.mockReturnValue(false))
        return { account, secret: 'PRIVATE_GIST_DISCOVERY_TOKEN' }
      })
      expect(await execute(plan)).toEqual({ status: 'cancelled' })
      expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
    })
    it('holds the global mutation gate and matching cancel waiter until an aborted list request actually settles', async () => {
      const plan = await prepare(),
        network = Promise.withResolvers<ReturnType<typeof response>>()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockReturnValueOnce(network.promise)
      const pending = execute(plan)
      await vi.waitFor(() => expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce())
      expect(() => invoke('relayConfigEditClear')).toThrow('候选查找')
      let cancelled = false
      const cancelling = (
        invoke('relayRuntimeGistDiscoveryCancel', {
          evidenceId: plan.evidenceId
        }) as Promise<void>
      ).then(() => {
        cancelled = true
      })
      await Promise.resolve()
      expect(cancelled).toBe(false)
      expect(() => invoke('relayConfigEditClear')).toThrow('候选查找')
      network.resolve(response())
      expect(await pending).toEqual({ status: 'cancelled' })
      await cancelling
      expect(cancelled).toBe(true)
      expect(fixture.editClear).not.toHaveBeenCalled()
    })
    it('allows only metadata discovery during stable owned TUN forwarding without reading its runtime body', async () => {
      fixture.tunStateOverride = {
        phase: 'active',
        pending: false,
        owned: true,
        sessionId: '00000000-0000-4000-8000-000000000030',
        traffic: 'forwarding',
        restorationVerified: false,
        protectionVerified: false,
        warnings: []
      }
      const plan = await prepare()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockResolvedValueOnce(response())
      expect(await execute(plan)).toMatchObject({ status: 'listed' })
      expect(fixture.tunCapture).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it('revokes an in-flight list across sleep and never publishes its late result', async () => {
      const plan = await prepare(),
        network = Promise.withResolvers<ReturnType<typeof response>>()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockReturnValueOnce(network.promise)
      const pending = execute(plan)
      await vi.waitFor(() => expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce())
      for (const [name, listener] of fixture.powerOn.mock.calls) if (name === 'suspend') listener()
      network.resolve(response())
      expect(await pending).toEqual({ status: 'cancelled' })
      expect(fixture.remoteUpload).not.toHaveBeenCalled()
    })
    it('waits for its held list request to settle before leaving on quit', async () => {
      const plan = await prepare(),
        network = Promise.withResolvers<ReturnType<typeof response>>()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockReturnValueOnce(network.promise)
      const pending = execute(plan)
      await vi.waitFor(() => expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce())
      const quit = fixture.appOn.mock.calls.find(([name]) => name === 'before-quit')?.[1],
        preventDefault = vi.fn()
      quit({ preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(fixture.appQuit).not.toHaveBeenCalled()
      expect(() => invoke('relayProfilePrepare')).toThrow('退出恢复')
      network.resolve(response())
      expect(await pending).toEqual({ status: 'cancelled' })
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    })
    it('revokes and drains an in-flight discovery before executing a previously prepared local restore', async () => {
      fixture.chooseOpen.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/private/relay.zip']
      })
      const local = (await invoke('relayBackupImportPrepare')) as { plan: { id: string } },
        plan = await prepare(),
        network = Promise.withResolvers<ReturnType<typeof response>>()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.runtimeGistRequest.mockReturnValueOnce(network.promise)
      const pending = execute(plan)
      await vi.waitFor(() => expect(fixture.runtimeGistRequest).toHaveBeenCalledOnce())
      const restoring = invoke('relayBackupRestore', { id: local.plan.id })
      await Promise.resolve()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.backupCommit).not.toHaveBeenCalled()
      network.resolve(response())
      expect(await pending).toEqual({ status: 'cancelled' })
      expect(await restoring).toEqual({ status: 'restored' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.backupCommit).toHaveBeenCalledOnce()
    })
  })
  describe('Legacy WebDAV ZIP entry', () => {
    afterEach(() => vi.useRealTimers())
    const request = {
      provider: 'webdav',
      action: 'download',
      archiveFormat: 'legacy-zip',
      url: 'https://dav.example/Relay/old-clash.zip',
      username: 'fixture',
      password: 'PRIVATE-manual-password',
      proxyPort: 18191
    }
    const prepare = async (): Promise<RelayRemoteBackupPlan> =>
      (await invoke('relayBackupRemotePrepare', request)) as RelayRemoteBackupPlan
    const execute = async (plan: RelayRemoteBackupPlan): Promise<RelayRemoteBackupResult> =>
      (await invoke('relayBackupRemoteExecute', {
        evidenceId: plan.evidenceId
      })) as RelayRemoteBackupResult
    const prepareSaved = async (): Promise<RelayRemoteBackupPlan> =>
      (await invoke('relayBackupAccountPrepareRemote', {
        id: savedBackupAccount.id,
        revision: savedBackupAccount.revision,
        action: 'download',
        filename: 'old-clash.zip',
        archiveFormat: 'legacy-zip'
      })) as RelayRemoteBackupPlan
    const localId = (result: RelayRemoteBackupResult): string => {
      if (result.status !== 'prepared' || !result.plan || !result.report || !result.migrationId)
        throw new Error('Expected a separate local migration plan and retained report')
      return result.plan.id
    }
    it('binds an explicit ZIP download to its endpoint without applying the local migration', async () => {
      const plan = await prepare()
      expect(plan).toMatchObject({ archiveFormat: 'legacy-zip', encrypted: false })
      expect(await execute(plan)).toMatchObject({ status: 'prepared' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(JSON.stringify(fixture.confirmRestore.mock.calls)).not.toContain(request.password)
      expect(fixture.remoteDownload).toHaveBeenCalledOnce()
      expect(fixture.legacyPrepare).toHaveBeenCalledOnce()
      expect(fixture.backupCommit).not.toHaveBeenCalled()
    })
    it('hands raw bytes to the existing private migration record and applies it only on an explicit local restore request', async () => {
      const plan = await prepare()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      const result = await execute(plan),
        id = localId(result)
      expect(fixture.remoteDownload).toHaveBeenCalledWith(
        expect.objectContaining({ archiveFormat: 'legacy-zip' }),
        expect.any(AbortSignal),
        expect.any(Function),
        expect.objectContaining({ assertLive: expect.any(Function) })
      )
      expect(fixture.legacyPrepare).toHaveBeenCalledWith(
        expect.objectContaining({
          stateRoot: '/fake/home/Library/Application Support/Relay-Preview'
        }),
        Buffer.from('validated fixture archive'),
        { directories: [], entries: [] },
        18191,
        expect.any(AbortSignal),
        expect.any(Function)
      )
      expect(fixture.chooseOpen).not.toHaveBeenCalled()
      expect(fixture.legacyRecordPlan).toHaveBeenCalledOnce()
      expect(fixture.backupCommit).not.toHaveBeenCalled()
      expect(await invoke('relayBackupRestore', { id })).toEqual({ status: 'restored' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.backupCommit).toHaveBeenCalledWith(id, 'a'.repeat(64), expect.any(Function))
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
    })
    it('keeps a retained-only migration report without publishing an executable local plan', async () => {
      const implementation = fixture.legacyPrepare.getMockImplementation()
      if (!implementation) throw new Error('Missing legacy record fixture')
      fixture.legacyPrepare.mockImplementationOnce(async (...args: unknown[]) => ({
        ...(await implementation(...args)),
        archiveBytes: undefined
      }))
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      expect(await execute(await prepare())).toMatchObject({
        status: 'inspected',
        report: { format: 'clash-party-legacy-zip' },
        migrationId: expect.any(String)
      })
      expect(fixture.backupStage).not.toHaveBeenCalled()
      expect(fixture.legacyRecordPlan).not.toHaveBeenCalled()
      expect(fixture.backupCommit).not.toHaveBeenCalled()
    })
    it('revokes a manual download when the private window disappears before transfer execution', async () => {
      const plan = await prepare()
      fixture.window.isVisible.mockReturnValue(false)
      await expect(execute(plan)).rejects.toThrow('界面授权')
      expect(fixture.remoteDownload).not.toHaveBeenCalled()
      expect(fixture.legacyPrepare).not.toHaveBeenCalled()
    })
    it('captures the saved-account owner before asynchronous metadata reads and never decrypts after it disappears', async () => {
      const metadata = Promise.withResolvers<RelayBackupAccount>()
      fixture.accountRead.mockReturnValueOnce(metadata.promise)
      const pending = prepareSaved()
      fixture.window.isVisible.mockReturnValue(false)
      metadata.resolve({ ...savedBackupAccount })
      await expect(pending).rejects.toThrow('远程准备未通过')
      expect(fixture.accountCredential).not.toHaveBeenCalled()
      expect(fixture.remoteDownload).not.toHaveBeenCalled()
      expect(fixture.legacyPrepare).not.toHaveBeenCalled()
    })
    it('cancels the staged local candidate if ownership is lost while its private record plan is being published', async () => {
      const publication = Promise.withResolvers<void>()
      fixture.legacyRecordPlan.mockReturnValueOnce(publication.promise)
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      const pending = execute(await prepare())
      await vi.waitFor(() => expect(fixture.legacyRecordPlan).toHaveBeenCalledOnce())
      fixture.window.isVisible.mockReturnValue(false)
      publication.resolve()
      expect(await pending).toEqual({ status: 'cancelled' })
      expect(fixture.backupDiscard).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000037')
      expect(fixture.backupCommit).not.toHaveBeenCalled()
    })
    it('gives the local plan its own TTL while retaining saved-account revision checks beyond transfer expiry', async () => {
      const plan = await prepareSaved()
      await vi.advanceTimersByTimeAsync(40000)
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const id = localId(await execute(plan))
      await vi.advanceTimersByTimeAsync(25000)
      expect(Date.now()).toBeGreaterThan(plan.expiresAt)
      expect(await invoke('relayBackupRestore', { id })).toEqual({ status: 'restored' })
      expect(fixture.backupCommit).toHaveBeenCalledOnce()
    })
    it('refuses the local restore if the saved account changes after the raw ZIP handoff', async () => {
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const id = localId(await execute(await prepareSaved()))
      fixture.accountRead.mockRejectedValue(new Error('PRIVATE account revision changed'))
      expect(await invoke('relayBackupRestore', { id })).toEqual({ status: 'cancelled' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.backupCommit).not.toHaveBeenCalled()
    })
    it('rechecks ownership after the asynchronous restore admission before entering the local file transaction', async () => {
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      const id = localId(await execute(await prepare()))
      const pending = invoke('relayBackupRestore', { id })
      fixture.window.isVisible.mockReturnValue(false)
      expect(await pending).toEqual({ status: 'cancelled' })
      expect(fixture.backupCommit).not.toHaveBeenCalled()
    })
    it('finishes an admitted file transaction if ownership disappears after it has entered', async () => {
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const id = localId(await execute(await prepare()))
      fixture.backupCommit.mockImplementationOnce(
        async (_id: string, _baseline: string, assertIdle: () => void) => {
          assertIdle()
          fixture.window.isVisible.mockReturnValue(false)
          await Promise.resolve()
          assertIdle()
          return 'restored'
        }
      )
      expect(await invoke('relayBackupRestore', { id })).toEqual({ status: 'restored' })
      expect(fixture.backupCommit).toHaveBeenCalledOnce()
      expect(fixture.window.webContents.send).toHaveBeenCalledWith('relayDataRestored')
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
  })
  it('stages a remote backup through the owned running HTTP proxy while keeping restore behind a separate idle gate', async () => {
    const prepared = await localPreparation()
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const started = await invoke('relayLocalProxyAction', {
      action: 'start',
      evidenceId: prepared.evidenceId
    })
    expect(started).toMatchObject({ status: 'started' })
    const plan = (await invoke('relayBackupRemotePrepare', {
      provider: 'webdav',
      action: 'download',
      url: 'https://dav.example/Relay/fixture.json',
      username: 'fixture',
      password: 'fixture',
      proxyPort: 18191
    })) as { evidenceId: string }
    expect(fixture.remoteDownload).not.toHaveBeenCalled()
    let finish!: (bytes: Buffer) => void
    fixture.remoteDownload.mockImplementationOnce(
      () =>
        new Promise<Buffer>((resolve) => {
          finish = resolve
        })
    )
    const pending = invoke('relayBackupRemoteExecute', { evidenceId: plan.evidenceId }) as Promise<{
      status: string
      plan: { id: string }
    }>
    await vi.waitFor(() => expect(fixture.remoteDownload).toHaveBeenCalled())
    expect(() => invoke('relayConfigEditClear')).toThrow('远程备份')
    expect(() =>
      invoke('relayLocalProxyAction', {
        action: 'stop',
        instanceId: (invoke('relayLocalProxyState') as { instanceId: string }).instanceId
      })
    ).toThrow('备份')
    finish(Buffer.from('validated fixture archive'))
    const result = await pending
    expect(result.status).toBe('prepared')
    expect(fixture.backupStage).toHaveBeenCalledOnce()
    await expect(
      invoke('relayBackupRestore', { id: result.plan.id }) as Promise<unknown>
    ).rejects.toThrow('核心')
    expect(fixture.localStop).not.toHaveBeenCalled()
    invoke('relayBackupCancel')
  })
  it('flushes changed window bounds only after exit is allowed and waits before final quit', async () => {
    fixture.window.getNormalBounds.mockReturnValue({ x: 300, y: 100, width: 1100, height: 700 })
    let finish!: () => void
    fixture.geometrySave.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve('b'.repeat(64))
        })
    )
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    quit({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fixture.geometrySave).toHaveBeenCalled())
    expect(fixture.geometrySave).toHaveBeenCalledWith(
      expect.objectContaining({ normalBounds: { x: 300, y: 100, width: 1100, height: 700 } }),
      'a'.repeat(64)
    )
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(() => invoke('relayProfilePrepare')).toThrow('Simple发布尚未收尾')
    finish()
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
  })
  it('keeps restored geometry on disk instead of overwriting it from the open window', async () => {
    await fixture.afterBackupRestore?.()
    fixture.window.getNormalBounds.mockReturnValue({ x: 300, y: 100, width: 1100, height: 700 })
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    close({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    expect(fixture.geometrySave).not.toHaveBeenCalled()
  })
  it('waits for an owned backup commit to finish across quit without interrupting later root rechecks', async () => {
    const prepared = (await invoke('relayBackupRemotePrepare', {
      provider: 'webdav',
      action: 'download',
      url: 'https://dav.example/Relay/fixture.json',
      username: 'fixture',
      password: 'fixture',
      proxyPort: 18191
    })) as { evidenceId: string }
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const imported = (await invoke('relayBackupRemoteExecute', {
      evidenceId: prepared.evidenceId
    })) as { plan: { id: string } }
    let finish!: () => void
    fixture.backupCommit.mockImplementationOnce(
      async (_id: string, _baseline: string, assertIdle: () => void) => {
        assertIdle()
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        assertIdle()
        return 'restored'
      }
    )
    const restoring = invoke('relayBackupRestore', { id: imported.plan.id }) as Promise<unknown>
    await vi.waitFor(() => expect(fixture.backupCommit).toHaveBeenCalled())
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    quit({ preventDefault: vi.fn() })
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(() => invoke('relayProfilePrepare')).toThrow('退出恢复')
    finish()
    await expect(restoring).resolves.toMatchObject({ status: 'restored' })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
  })
  it('invalidates pre-restore import and downloaded-subscription proofs before any later save', async () => {
    fixture.chooseOpen.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/fixture/chosen.yaml']
    })
    const imported = (await invoke('relayProfilePrepare')) as { evidenceId: string }
    const plan = subscriptionPreparation()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const downloaded = (await invoke('relaySubscriptionDownload', {
      evidenceId: plan.evidenceId
    })) as { profile: { evidenceId: string } }
    expect(fixture.afterBackupRestore).toBeDefined()
    await fixture.afterBackupRestore?.()
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await expect(
      invoke('relayProfileSave', { evidenceId: imported.evidenceId }) as Promise<unknown>
    ).rejects.toThrow()
    await expect(
      invoke('relaySubscriptionSave', {
        evidenceId: downloaded.profile.evidenceId
      }) as Promise<unknown>
    ).rejects.toThrow()
    expect(fixture.profileSave).not.toHaveBeenCalled()
  })
  it('keeps subscription setup inert and downloads then saves only on exact explicit actions', async () => {
    expect(invoke('relaySubscriptionState')).toMatchObject({ pending: false, phase: 'idle' })
    expect(() => invoke('relaySubscriptionState', { path: '/PRIVATE' })).toThrow('不接受')
    const plan = subscriptionPreparation()
    expect(JSON.stringify(plan)).not.toContain('PRIVATE')
    expect(fixture.subscriptionDownload).not.toHaveBeenCalled()
    const result = (await invoke('relaySubscriptionDownload', { evidenceId: plan.evidenceId })) as {
      profile: { evidenceId: string }
    }
    expect(fixture.subscriptionDownload).toHaveBeenCalledWith(
      'https://subscription.invalid/PRIVATE?token=PRIVATE',
      18191,
      expect.any(AbortSignal)
    )
    expect(fixture.profileSave).not.toHaveBeenCalled()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(
      await invoke('relaySubscriptionSave', { evidenceId: result.profile.evidenceId })
    ).toMatchObject({ status: 'saved' })
    expect(fixture.profileSave).toHaveBeenCalledWith('Subscription fixture', profileRuntimeSource)
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('aborts an in-flight subscription before quit and waits for request completion without writing', async () => {
    let signal!: AbortSignal, finish!: (value: string) => void
    fixture.subscriptionDownload.mockImplementationOnce(
      async (_url: string, _port: number, value: AbortSignal) => {
        signal = value
        return new Promise<string>((resolve) => {
          finish = resolve
        })
      }
    )
    const plan = subscriptionPreparation()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const request = invoke('relaySubscriptionDownload', { evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(fixture.subscriptionDownload).toHaveBeenCalled())
    for (const channel of [
      'relayCodeApply',
      'relayRecoveryRestore',
      'relayDesktopAction',
      'relayEdgeProfileOpen',
      'relayProfilePrepare',
      'relayProfileSave',
      'relayArtifactAction'
    ])
      expect(() => invoke(channel)).toThrow('订阅')
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1],
      preventDefault = vi.fn()
    quit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(fixture.appQuit).not.toHaveBeenCalled()
    finish(profileRuntimeSource)
    expect(await request).toMatchObject({ status: 'cancelled' })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    expect(fixture.profileSave).not.toHaveBeenCalled()
  })
  it('waits for an already started subscription snapshot write before explicit app quit', async () => {
    const plan = subscriptionPreparation()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const downloaded = (await invoke('relaySubscriptionDownload', {
      evidenceId: plan.evidenceId
    })) as { profile: { evidenceId: string } }
    let finish!: (value: RelayStoredProfile) => void
    const stored = await fixture.profileSave()
    fixture.profileSave.mockClear().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const saving = invoke('relaySubscriptionSave', { evidenceId: downloaded.profile.evidenceId })
    await vi.waitFor(() => expect(fixture.profileSave).toHaveBeenCalled())
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1],
      preventDefault = vi.fn()
    close({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(
      invoke('relaySubscriptionCancel', { evidenceId: downloaded.profile.evidenceId })
    ).toMatchObject({ status: 'busy' })
    finish(stored)
    expect(await saving).toMatchObject({ status: 'saved' })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
  })
  describe('Geo origin and dedicated TUN resource entry', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111',
      id = '22222222-2222-4222-8222-222222222222',
      definition = {
        descriptor: {
          name: 'Geo fixture',
          kind: 'country-mmdb' as const,
          behavior: null,
          selector: 'cn'
        },
        source: {
          kind: 'http' as const,
          url: 'https://geo.invalid/PRIVATE/path?token=PRIVATE',
          proxyPort: 18191,
          headers: { authorization: 'Bearer PRIVATE' }
        },
        expectedSHA256: '',
        autoIntent: { requested: false, schedule: { kind: 'manual' as const } }
      },
      selected = { id, revision: 'a'.repeat(64) },
      record = (): GeoOriginRecord => ({
        info: {
          ...selected,
          originRevision: 'b'.repeat(64),
          descriptor: structuredClone(definition.descriptor),
          origin: 'https://geo.invalid',
          proxyPort: 18191,
          hasPrivateHeaders: true,
          expectedSHA256: '',
          autoIntent: structuredClone(definition.autoIntent),
          createdAt: '2026-11-02T00:00:00Z',
          updatedAt: '2026-11-02T00:00:00Z'
        },
        definition: structuredClone(definition)
      }),
      snapshot = {
        sessionId,
        configurationRevision: 'c'.repeat(64),
        generationSHA256: 'd'.repeat(64),
        resources: [
          { kind: 'country-mmdb' as const, sha256: 'e'.repeat(64), bytes: 16, active: true }
        ]
      },
      replace = {
        sessionId,
        configurationRevision: snapshot.configurationRevision,
        expectedGenerationSHA256: snapshot.generationSHA256,
        origin: selected
      }
    const active = () => {
      fixture.simulateTunResources = true
      fixture.tunStateOverride = {
        phase: 'active',
        pending: false,
        owned: true,
        sessionId,
        traffic: 'forwarding',
        restorationVerified: false,
        protectionVerified: false,
        warnings: []
      }
      fixture.tunResourcesRead.mockImplementation(async (_raw, guard) => {
        guard()
        return { status: 'snapshot', sessionId, snapshot: structuredClone(snapshot) }
      })
    }
    beforeEach(() => {
      fixture.originRead.mockImplementation(async () => record())
      fixture.originSave.mockImplementation(async () => record())
    })
    const readyFetch = () => {
      const bytes = Buffer.from('synthetic database'),
        info = {
          ...definition.descriptor,
          id: '33333333-3333-4333-8333-333333333333',
          sha256: profileHash(bytes.toString()),
          size: bytes.length,
          createdAt: '2026-11-02T00:00:00Z',
          integrity: 'notChecked'
        }
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      fixture.resourceDownload.mockResolvedValue(bytes)
      fixture.resourceSave.mockResolvedValue(info)
      fixture.resourceRead.mockResolvedValue({ info, bytes, revision: 'f'.repeat(64) })
      fixture.resourceCheck.mockImplementation(async (_root, job) => ({
        status: 'passed',
        resourceSHA256: job.sha256,
        warnings: []
      }))
      fixture.originCommitHead.mockResolvedValue(record())
    }
    const autoRecord = (): GeoOriginRecord => {
      const value = record()
      value.definition.autoIntent = { requested: true, schedule: { kind: 'interval', minutes: 1 } }
      value.info.autoIntent = structuredClone(value.definition.autoIntent)
      return value
    }
    it('does not restore Geo grants from persisted intent and arms only on explicit request', async () => {
      fixture.originRead.mockImplementation(async () => autoRecord())
      expect(invoke('relayGeoScheduleState')).toEqual({ pending: false, entries: [] })
      expect(() => invoke('relayGeoScheduleState', {})).toThrow('不接受')
      expect(
        await invoke('relayGeoScheduleArm', { origin: selected, target: { kind: 'cache' } })
      ).toMatchObject({
        status: 'armed',
        state: { entries: [{ id, enabled: true, target: { kind: 'cache' } }] }
      })
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
      expect(fixture.resourceCheck).not.toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
    })
    it('arms cache-only permission through the private coordinator without starting an immediate download', async () => {
      fixture.originRead.mockImplementation(async () => autoRecord())
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const result = await invoke('relayGeoScheduleArm', {
        origin: selected,
        target: { kind: 'cache' }
      })
      expect(result).toMatchObject({
        status: 'armed',
        state: { pending: false, entries: [{ id, enabled: true, target: { kind: 'cache' } }] }
      })
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
      expect(await invoke('relayGeoScheduleDisarm', { id })).toMatchObject({
        pending: false,
        entries: [{ enabled: false }]
      })
      expect(fixture.tunResourceScheduled).not.toHaveBeenCalled()
    })
    it('does not silently downgrade unavailable active scope to cache-only scheduling', async () => {
      fixture.originRead.mockImplementation(async () => autoRecord())
      active()
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      expect(
        await invoke('relayGeoScheduleArm', {
          origin: selected,
          target: { kind: 'tun', sessionId }
        })
      ).toMatchObject({ status: 'unsupported', state: { entries: [] } })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
    })
    it('validates a positive same-owner active resource scope before issuing a period grant', async () => {
      fixture.originRead.mockImplementation(async () => autoRecord())
      active()
      const owner: GeoAutomaticOwner = {
        sessionId,
        configurationRevision: snapshot.configurationRevision,
        assertCurrent: vi.fn()
      }
      fixture.tunAutomaticOwner.mockReturnValue(owner)
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      expect(
        await invoke('relayGeoScheduleArm', {
          origin: selected,
          target: { kind: 'tun', sessionId }
        })
      ).toMatchObject({
        status: 'armed',
        state: { entries: [{ enabled: true, target: { kind: 'tun', sessionId } }] }
      })
      expect(fixture.tunResourcesRead).toHaveBeenCalledOnce()
      expect(owner.assertCurrent).toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
      await invoke('relayGeoScheduleDisarm', { id })
    })
    it('keeps granted background intent visible through a renderer hide instead of stopping it', async () => {
      fixture.originRead.mockImplementation(async () => autoRecord())
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      await invoke('relayGeoScheduleArm', { origin: selected, target: { kind: 'cache' } })
      fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
      expect(invoke('relayGeoScheduleState')).toMatchObject({
        entries: [{ enabled: true, target: { kind: 'cache' } }]
      })
      await invoke('relayGeoScheduleDisarm', { id })
    })
    it('does not issue a period grant after silent renderer loss during origin metadata reading', async () => {
      fixture.originRead.mockImplementation(async () => {
        queueMicrotask(() => fixture.window.isVisible.mockReturnValue(false))
        return autoRecord()
      })
      expect(
        await invoke('relayGeoScheduleArm', { origin: selected, target: { kind: 'cache' } })
      ).toMatchObject({ status: 'cancelled', state: { entries: [] } })
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
    })
    it('starts with zero origin IO and validates no-input/status/cancel contracts', async () => {
      expect(fixture.originList).not.toHaveBeenCalled()
      expect(fixture.originRead).not.toHaveBeenCalled()
      expect(invoke('relayGeoOriginState')).toEqual({ pending: false, phase: 'idle' })
      expect(() => invoke('relayGeoOriginState', {})).toThrow('不接受')
      expect(() => invoke('relayGeoOriginList', {})).toThrow('不接受')
      for (const bad of [
        undefined,
        {},
        { operationId: id, path: '/private' },
        { operationId: 'wrong' }
      ])
        await expect(invoke('relayGeoOriginCancel', bad)).rejects.toThrow('operationId')
      expect(await invoke('relayGeoOriginCancel', { operationId: id })).toBeUndefined()
    })
    it('lists only safe metadata while explicit selected read returns private details', async () => {
      fixture.originList.mockResolvedValue({
        origins: [record().info],
        incomplete: 0,
        warnings: []
      })
      const listed = await invoke('relayGeoOriginList')
      expect(JSON.stringify(listed)).not.toContain('PRIVATE')
      expect(fixture.originRead).not.toHaveBeenCalled()
      expect(await invoke('relayGeoOriginRead', selected)).toEqual(record())
      expect(fixture.originRead).toHaveBeenCalledWith(selected)
    })
    it('saves and fetches only on independent explicit actions without enabling automatic updates', async () => {
      expect(await invoke('relayGeoOriginSave', { origin: null, definition })).toMatchObject({
        status: 'saved'
      })
      expect(fixture.originSave).toHaveBeenCalledOnce()
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
      readyFetch()
      expect(await invoke('relayGeoOriginFetch', selected)).toMatchObject({ status: 'updated' })
      expect(fixture.resourceDownload).toHaveBeenCalledOnce()
      expect(fixture.resourceCheck).toHaveBeenCalledOnce()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(invoke('relayGeoScheduleState')).toMatchObject({ entries: [] })
    })
    it('saves requested auto intent as a definition only and returns no private source', async () => {
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const auto = {
        ...definition,
        autoIntent: { requested: true, schedule: { kind: 'interval', minutes: 30 } }
      }
      const result = await invoke('relayGeoOriginSave', { origin: null, definition: auto })
      expect(result).toMatchObject({ status: 'saved' })
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
      expect(fixture.originSave).toHaveBeenCalledOnce()
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('allows stable own forwarding TUN metadata/fetch setup without a port and refuses pending or unknown TUN', async () => {
      active()
      readyFetch()
      expect(await invoke('relayGeoOriginList')).toMatchObject({ origins: [] })
      expect(await invoke('relayGeoOriginFetch', selected)).toMatchObject({ status: 'updated' })
      const current = fixture.tunStateOverride
      if (!current) throw new Error('Missing fixture TUN state')
      fixture.tunStateOverride = { ...current, pending: true }
      expect(() => invoke('relayGeoOriginList')).toThrow('在途')
      fixture.tunStateOverride = {
        ...current,
        pending: false,
        phase: 'uncertain'
      }
      expect(() => invoke('relayGeoOriginSave', { origin: null, definition })).toThrow('在途')
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('blocks reciprocal mutations and keeps exact cancellation busy until held download actually settles', async () => {
      readyFetch()
      const gate = Promise.withResolvers<Buffer>(),
        entered = Promise.withResolvers<void>()
      fixture.resourceDownload.mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      const pending = invoke('relayGeoOriginFetch', selected)
      await entered.promise
      const state = invoke('relayGeoOriginState') as { operationId: string }
      expect(state.operationId).toBeTruthy()
      for (const ch of [
        'relayConfigEditSave',
        'relaySubscriptionPrepare',
        'relayResourcePrepare',
        'relayBackupRecoveryList'
      ])
        expect(() => invoke(ch)).toThrow()
      expect(await invoke('relayGeoOriginCancel', { operationId: id })).toBeUndefined()
      expect(invoke('relayGeoOriginState')).toMatchObject({ pending: true })
      let cancelled = false
      const cancel = Promise.resolve(
        invoke('relayGeoOriginCancel', { operationId: state.operationId })
      ).then(() => {
        cancelled = true
      })
      await Promise.resolve()
      expect(cancelled).toBe(false)
      expect(invoke('relayGeoOriginState')).toMatchObject({ pending: true })
      gate.resolve(Buffer.from('synthetic database'))
      expect(await pending).toMatchObject({ status: 'cancelled' })
      await cancel
      expect(cancelled).toBe(true)
      expect(fixture.resourceSave).not.toHaveBeenCalled()
      expect(fixture.originCommitHead).not.toHaveBeenCalled()
    })
    it('checks fetched bytes through the guarded fixed-core adapter before committing a safe cache head', async () => {
      readyFetch()
      const result = await invoke('relayGeoOriginFetch', selected)
      expect(result).toMatchObject({
        status: 'updated',
        origin: { id: selected.id },
        check: { status: 'passed' }
      })
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
      expect(fixture.resourceCheck).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ bytes: Buffer.from('synthetic database') }),
        expect.any(Function)
      )
      expect(fixture.originCommitHead).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: selected,
          originRevision: record().info.originRevision,
          resourceRevision: 'f'.repeat(64)
        })
      )
      expect(fixture.tunResourceReplace).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('drains the actual held fetch before entering a restore lane rather than relying on afterRestore', async () => {
      readyFetch()
      const gate = Promise.withResolvers<Buffer>(),
        entered = Promise.withResolvers<void>()
      fixture.resourceDownload.mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      const fetch = invoke('relayGeoOriginFetch', selected)
      await entered.promise
      let settled = false
      const restore = Promise.resolve(invoke('relayBackupRestore', { evidenceId: id })).then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(invoke('relayGeoOriginState')).toMatchObject({ pending: true })
      expect(fixture.backupCommit).not.toHaveBeenCalled()
      gate.resolve(Buffer.from('synthetic database'))
      expect(await fetch).toMatchObject({ status: 'cancelled' })
      await restore
      expect(settled).toBe(true)
      expect(fixture.backupCommit).not.toHaveBeenCalled()
    })
    it('keeps quit pending until its held origin fetch settles, without admitting a cache write', async () => {
      readyFetch()
      const gate = Promise.withResolvers<Buffer>(),
        entered = Promise.withResolvers<void>()
      fixture.resourceDownload.mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      const fetch = invoke('relayGeoOriginFetch', selected)
      await entered.promise
      const quit = fixture.appOn.mock.calls.find((c) => c[0] === 'before-quit')?.[1],
        preventDefault = vi.fn()
      quit({ preventDefault })
      expect(preventDefault).toHaveBeenCalled()
      expect(fixture.appQuit).not.toHaveBeenCalled()
      expect(invoke('relayGeoOriginState')).toMatchObject({ pending: true })
      gate.resolve(Buffer.from('synthetic database'))
      expect(await fetch).toMatchObject({ status: 'cancelled' })
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
      expect(fixture.resourceSave).not.toHaveBeenCalled()
      expect(fixture.originCommitHead).not.toHaveBeenCalled()
    })
    it('rechecks the captured renderer after asynchronous save admission without relying on a lifecycle event', async () => {
      const pending = invoke('relayGeoOriginSave', { origin: null, definition })
      fixture.window.webContents.isDestroyed.mockReturnValue(true)
      expect(await pending).toMatchObject({ status: 'cancelled' })
      expect(fixture.originSave).not.toHaveBeenCalled()
    })
    it('cannot enter resource checking after selected-core lookup loses eventless renderer ownership', async () => {
      readyFetch()
      const gate = Promise.withResolvers<string>(),
        entered = Promise.withResolvers<void>()
      fixture.selectedRoot.mockImplementationOnce(async () => {
        entered.resolve()
        return gate.promise
      })
      const pending = invoke('relayGeoOriginFetch', selected)
      await entered.promise
      fixture.window.webContents.isDestroyed.mockReturnValue(true)
      gate.resolve('/fixture')
      expect(await pending).toMatchObject({ status: 'uncertain' })
      expect(fixture.resourceCheck).not.toHaveBeenCalled()
      expect(fixture.originCommitHead).not.toHaveBeenCalled()
    })
    it.each(['hide', 'navigation', 'suspend'])(
      'revokes origin operation and resource authority on %s without stopping Core',
      async (reason) => {
        const pending = invoke('relayGeoOriginSave', { origin: null, definition })
        if (reason === 'hide') fixture.window.on.mock.calls.find((c) => c[0] === 'hide')?.[1]()
        else if (reason === 'navigation') {
          for (const [name, listener] of fixture.window.webContents.on.mock.calls)
            if (name === 'did-start-navigation')
              listener({ isMainFrame: true, isSameDocument: false })
        } else
          for (const [, fn] of fixture.powerOn.mock.calls.filter((c) => c[0] === 'suspend')) fn()
        expect(invoke('relayGeoOriginState')).toMatchObject({ pending: true })
        expect(
          reason === 'suspend'
            ? fixture.tunInvalidateResources
            : fixture.tunInvalidateInteractiveResources
        ).toHaveBeenCalled()
        expect(await pending).toMatchObject({ status: 'cancelled' })
        expect(fixture.originSave).not.toHaveBeenCalled()
        expect(fixture.coreStop).not.toHaveBeenCalled()
        expect(fixture.localStop).not.toHaveBeenCalled()
      }
    )
    it('reads the dedicated TUN resource snapshot with no local-proxy fallback or HTTP port', async () => {
      active()
      expect(await invoke('relayTunResourcesRead', { sessionId })).toEqual({
        status: 'snapshot',
        sessionId,
        snapshot
      })
      expect(fixture.tunResourcesRead).toHaveBeenCalledWith({ sessionId }, expect.any(Function))
      expect(fixture.localRulesRead).not.toHaveBeenCalled()
      expect(fixture.tunCapture).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('rejects invalid fields and foreign frames before either TUN resource service call', () => {
      active()
      for (const [name, input] of [
        ['relayTunResourcesRead', { sessionId, path: '/private' }],
        ['relayTunResourceReplace', { ...replace, blobId: id }]
      ] as const)
        expect(() => invoke(name, input)).toThrow()
      for (const name of ['relayTunResourcesRead', 'relayTunResourceReplace'])
        expect(() =>
          fixture.handlers.get(name)?.(
            { sender: fixture.window.webContents, senderFrame: {} },
            name === 'relayTunResourcesRead' ? { sessionId } : replace
          )
        ).toThrow()
      expect(fixture.tunResourcesRead).not.toHaveBeenCalled()
      expect(fixture.tunResourceReplace).not.toHaveBeenCalled()
    })
    it('forwards only current-session provider metadata and an exact private-cache selection', async () => {
      active()
      fixture.simulateTunProviders = true
      fixture.tunProvidersRead.mockImplementation(async (_raw, guard) => {
        guard()
        return {
          status: 'snapshot',
          sessionId,
          snapshot: {
            sessionId,
            configurationRevision: 'c'.repeat(64),
            generationSHA256: 'd'.repeat(64),
            providers: [],
            groups: []
          }
        }
      })
      expect(await invoke('relayTunRuleProvidersRead', { sessionId })).toMatchObject({
        status: 'snapshot',
        snapshot: { providers: [], groups: [] }
      })
      expect(fixture.tunProvidersRead).toHaveBeenCalledWith({ sessionId }, expect.any(Function))
      for (const channel of ['relayTunRuleProvidersRead', 'relayTunRuleProviderReplace']) {
        const request =
          channel === 'relayTunRuleProvidersRead'
            ? { sessionId }
            : {
                sessionId,
                configurationRevision: 'c'.repeat(64),
                expectedGenerationSHA256: 'd'.repeat(64),
                provider: 'local',
                resource: { id, sha256: 'f'.repeat(64) }
              }
        expect(() => invoke(channel, { ...request, path: '/private' })).toThrow()
        expect(() =>
          fixture.handlers.get(channel)?.(
            { sender: fixture.window.webContents, senderFrame: {} },
            request
          )
        ).toThrow()
      }
      expect(fixture.tunProviderReplace).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.localRulesRead).not.toHaveBeenCalled()
    })
    it('admits the complete provider alias group directly with exact generation and source', async () => {
      active()
      fixture.simulateTunProviders = true
      fixture.tunProviderReplace.mockImplementation(async (_raw, guard) => {
        guard()
        const accepted = await fixture.tunProviderConfirm?.({
          sessionId,
          configurationRevision: 'c'.repeat(64),
          expectedGenerationSHA256: 'd'.repeat(64),
          provider: 'local',
          linkedProviders: ['local', 'shared alias'],
          kind: 'rule-yaml',
          behavior: 'domain',
          oldSHA256: 'e'.repeat(64),
          newSHA256: 'f'.repeat(64),
          bytes: 42
        })
        guard()
        return { status: accepted ? 'unavailable' : 'cancelled', sessionId }
      })
      const request = {
        sessionId,
        configurationRevision: 'c'.repeat(64),
        expectedGenerationSHA256: 'd'.repeat(64),
        provider: 'local',
        resource: { id, sha256: 'f'.repeat(64) }
      }
      expect(await invoke('relayTunRuleProviderReplace', request)).toEqual({
        status: 'unavailable',
        sessionId
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.tunProviderReplace).toHaveBeenCalledWith(request, expect.any(Function))
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it('invalidates provider authority while its resource service waits after window hide', async () => {
      active()
      fixture.simulateTunProviders = true
      const entered = Promise.withResolvers<void>(),
        reply = Promise.withResolvers<void>()
      fixture.tunProviderReplace.mockImplementation(async (_raw, guard) => {
        guard()
        entered.resolve()
        await reply.promise
        guard()
        await fixture.tunProviderConfirm?.({
          sessionId,
          configurationRevision: 'c'.repeat(64),
          expectedGenerationSHA256: 'd'.repeat(64),
          provider: 'local',
          linkedProviders: ['local'],
          kind: 'rule-yaml',
          behavior: 'domain',
          oldSHA256: 'e'.repeat(64),
          newSHA256: 'f'.repeat(64),
          bytes: 42
        })
        guard()
        return { status: 'unavailable', sessionId }
      })
      const work = invoke('relayTunRuleProviderReplace', {
        sessionId,
        configurationRevision: 'c'.repeat(64),
        expectedGenerationSHA256: 'd'.repeat(64),
        provider: 'local',
        resource: { id, sha256: 'f'.repeat(64) }
      })
      await entered.promise
      fixture.window.on.mock.calls.find((call) => call[0] === 'hide')?.[1]()
      reply.resolve()
      await expect(work).rejects.toThrow()
      expect(fixture.tunInvalidateInteractiveResources).toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it('uses exact generation and source for the explicit active resource replacement', async () => {
      active()
      fixture.tunResourceReplace.mockImplementation(async (_raw, guard) => {
        guard()
        const accepted = await fixture.tunResourceConfirm?.({
          sessionId,
          configurationRevision: snapshot.configurationRevision,
          expectedGenerationSHA256: snapshot.generationSHA256,
          origin: record().info,
          kind: 'country-mmdb',
          oldSHA256: 'e'.repeat(64),
          newSHA256: 'f'.repeat(64),
          bytes: 42,
          selector: 'cn'
        })
        guard()
        return accepted
          ? { status: 'unchanged', sessionId, snapshot: structuredClone(snapshot) }
          : { status: 'cancelled', sessionId }
      })
      expect(await invoke('relayTunResourceReplace', replace)).toEqual({
        status: 'unchanged',
        sessionId,
        snapshot
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.tunResourceReplace).toHaveBeenCalledWith(replace, expect.any(Function))
      expect(fixture.resourceDownload).not.toHaveBeenCalled()
    })
  })
  describe('TUN runtime rule entry', () => {
    let originalFrame = fixture.window.webContents.mainFrame
    beforeEach(() => {
      originalFrame = fixture.window.webContents.mainFrame
    })
    afterEach(() => {
      fixture.window.webContents.mainFrame = originalFrame
    })
    const sessionId = '11111111-1111-4111-8111-111111111111',
      snapshot = {
        sessionId,
        configurationRevision: 'a'.repeat(64),
        rulesSHA256: 'b'.repeat(64),
        rules: [
          { index: 0, type: 'Domain', payload: 'example.invalid', proxy: 'REJECT', disabled: false }
        ]
      },
      selection = {
        sessionId,
        configurationRevision: snapshot.configurationRevision,
        rulesSHA256: snapshot.rulesSHA256,
        index: 0,
        disabled: true
      }
    // These cases exercise the real Main handlers and direct action adapter
    // against a controlled service boundary. The real service/pipe protocol is
    // verified separately; this fixture never starts a privileged host.
    const active = () => {
      fixture.simulateTunRules = true
      fixture.tunStateOverride = {
        phase: 'active',
        pending: false,
        owned: true,
        sessionId,
        traffic: 'forwarding',
        restorationVerified: false,
        protectionVerified: false,
        warnings: []
      }
      fixture.tunRulesRead.mockImplementation(async (_raw, guard) => {
        guard()
        return { status: 'snapshot', sessionId, snapshot: structuredClone(snapshot) }
      })
    }
    it('reads a matching active TUN with no HTTP port or runtime-capture request', async () => {
      active()
      expect(await invoke('relayTunRulesRead', { sessionId })).toEqual({
        status: 'snapshot',
        sessionId,
        snapshot
      })
      expect(fixture.tunRulesRead).toHaveBeenCalledWith({ sessionId }, expect.any(Function))
      expect(fixture.tunCapture).not.toHaveBeenCalled()
      expect(fixture.localRulesRead).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
    })
    it('rejects foreign frames and transport authority before dispatching either rule operation', () => {
      active()
      for (const channel of ['relayTunRulesRead', 'relayTunRuleChange']) {
        const handler = fixture.handlers.get(channel)
        if (!handler) throw new Error('Missing dedicated rules handler')
        const raw = channel === 'relayTunRulesRead' ? { sessionId } : selection
        expect(() => handler({ ...event(), senderFrame: {} }, raw)).toThrow()
        for (const extra of [
          { pid: 1 },
          { path: '/rules/disable' },
          { nonce: 'foreign' },
          { proxyPort: 1 }
        ])
          expect(() => invoke(channel, { ...raw, ...extra })).toThrow()
      }
      expect(() => invoke('relayTunRuleChange', { ...selection, disabled: 'false' })).toThrow()
      expect(fixture.tunRulesRead).not.toHaveBeenCalled()
      expect(fixture.tunRuleChange).not.toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
    })
    it('refuses mismatched or recovering TUN states without falling back to the local proxy', () => {
      active()
      const base = fixture.tunStateOverride
      if (!base) throw new Error('Missing active TUN fixture')
      for (const changed of [
        { sessionId: '22222222-2222-4222-8222-222222222222' },
        { pending: true },
        { phase: 'uncertain' as const },
        { traffic: 'unconfirmed' as const }
      ]) {
        fixture.tunStateOverride = { ...base, ...changed }
        expect(() => invoke('relayTunRulesRead', { sessionId })).toThrow('TUN')
      }
      expect(fixture.tunRulesRead).not.toHaveBeenCalled()
      expect(fixture.localRulesRead).not.toHaveBeenCalled()
    })
    it('returns stale from the real inactive service without opening a host or adopting a PID', async () => {
      expect(await invoke('relayTunRulesRead', { sessionId })).toEqual({
        status: 'stale',
        sessionId
      })
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.localRulesRead).not.toHaveBeenCalled()
    })
    it('executes the temporary TUN rule action directly and preserves its source identity', async () => {
      active()
      fixture.tunRuleChange.mockImplementation(async (_raw, guard) => {
        guard()
        const accepted = await fixture.tunRuleConfirm?.({
          sessionId,
          configurationRevision: snapshot.configurationRevision,
          rulesSHA256: snapshot.rulesSHA256,
          rule: snapshot.rules[0],
          disabled: true
        })
        guard()
        return { status: accepted ? 'uncertain' : 'cancelled', sessionId }
      })
      expect(await invoke('relayTunRuleChange', selection)).toEqual({
        status: 'uncertain',
        sessionId
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.tunRuleChange).toHaveBeenCalledWith(selection, expect.any(Function))
      expect(fixture.localPatchRule).not.toHaveBeenCalled()
      expect(fixture.profileSave).not.toHaveBeenCalled()
      expect(fixture.editSave).not.toHaveBeenCalled()
    })
    it('preserves a false selection and the returned uncertainty without retrying or replacing TUN state', async () => {
      active()
      const state = fixture.tunStateOverride
      fixture.tunRuleChange.mockResolvedValue({ status: 'uncertain', sessionId })
      expect(await invoke('relayTunRuleChange', { ...selection, disabled: false })).toEqual({
        status: 'uncertain',
        sessionId
      })
      expect(fixture.tunRuleChange).toHaveBeenCalledExactlyOnceWith(
        { ...selection, disabled: false },
        expect.any(Function)
      )
      expect(fixture.tunStateOverride).toBe(state)
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it.each(['hide', 'navigation', 'suspend', 'visibility', 'frame'] as const)(
      'revokes the captured UI guard on %s without turning a rules cancellation into TUN shutdown',
      async (kind) => {
        active()
        const state = fixture.tunStateOverride,
          entered = Promise.withResolvers<void>(),
          finish = Promise.withResolvers<void>()
        fixture.tunRulesRead.mockImplementation(async (_raw, guard) => {
          guard()
          entered.resolve()
          await finish.promise
          expect(guard).toThrow('界面授权')
          return { status: 'cancelled', sessionId }
        })
        const pending = invoke('relayTunRulesRead', { sessionId })
        await entered.promise
        if (kind === 'hide') fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
        if (kind === 'navigation')
          for (const [name, listener] of fixture.window.webContents.on.mock.calls)
            if (name === 'did-start-navigation')
              listener({ isMainFrame: true, isSameDocument: false })
        if (kind === 'suspend')
          for (const [name, listener] of fixture.powerOn.mock.calls)
            if (name === 'suspend') listener()
        if (kind === 'visibility') fixture.window.isVisible.mockReturnValue(false)
        if (kind === 'frame') fixture.window.webContents.mainFrame = {}
        if (kind === 'hide' || kind === 'navigation' || kind === 'suspend')
          expect(fixture.tunInvalidateRules).toHaveBeenCalled()
        finish.resolve()
        expect(await pending).toEqual({ status: 'cancelled', sessionId })
        expect(fixture.tunStateOverride).toBe(state)
        expect(fixture.tunOpen).not.toHaveBeenCalled()
        expect(fixture.localStop).not.toHaveBeenCalled()
        expect(fixture.coreStop).not.toHaveBeenCalled()
      }
    )
  })

  describe('owned runtime rule controls', () => {
    const startRules = async (): Promise<LocalProxyRulesSnapshot> => {
      fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
      const prepared = await localPreparation()
      const started = (await invoke('relayLocalProxyAction', {
        action: 'start',
        evidenceId: prepared.evidenceId
      })) as { state: { instanceId: string } }
      const result = (await invoke('relayLocalProxyAction', {
        action: 'rules',
        instanceId: started.state.instanceId
      })) as { rules?: LocalProxyRulesSnapshot }
      if (!result.rules) throw new Error('Missing owned rule snapshot')
      fixture.confirmRestore.mockClear().mockResolvedValue({ response: 0, checkboxChecked: false })
      fixture.localRulesRead.mockClear()
      return result.rules
    }
    const change = (snapshot: LocalProxyRulesSnapshot, disabled = true) => ({
      action: 'rule',
      instanceId: snapshot.instanceId,
      configurationRevision: snapshot.configurationRevision,
      rulesSHA256: snapshot.rulesSHA256,
      index: 0,
      disabled
    })

    it('reads an owned rules snapshot and rejects foreign frames and extra transport fields before API access', async () => {
      const snapshot = await startRules()
      expect(snapshot).toMatchObject({ rules: [{ index: 0, disabled: false }] })
      expect(snapshot.configurationRevision).toMatch(/^[a-f0-9]{64}$/u)
      expect(snapshot.rulesSHA256).toMatch(/^[a-f0-9]{64}$/u)
      const handler = fixture.handlers.get('relayLocalProxyAction')
      if (!handler) throw new Error('Missing action handler')
      expect(() =>
        handler(
          { ...event(), senderFrame: {} },
          { action: 'rules', instanceId: snapshot.instanceId }
        )
      ).toThrow()
      for (const extra of [
        { path: '/rules/disable' },
        { pid: 4567 },
        { socket: '/private/foreign' }
      ])
        expect(() => invoke('relayLocalProxyAction', { ...change(snapshot), ...extra })).toThrow()
      expect(() =>
        invoke('relayLocalProxyAction', { ...change(snapshot), disabled: 'false' })
      ).toThrow()
      expect(fixture.localRulesRead).not.toHaveBeenCalled()
      expect(fixture.localPatchRule).not.toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
    })

    it('executes the runtime rule action without changing stored profiles', async () => {
      const snapshot = await startRules()
      expect(await invoke('relayLocalProxyAction', change(snapshot))).toMatchObject({
        status: 'ruleChanged'
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.localPatchRule).toHaveBeenCalledExactlyOnceWith(
        0,
        true,
        expect.objectContaining({
          assertLive: expect.any(Function),
          submitted: expect.any(Function)
        })
      )
      expect(fixture.profileSave).not.toHaveBeenCalled()
      expect(fixture.editSave).not.toHaveBeenCalled()
      expect(fixture.localReload).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
    })

    it('passes a private live guard to the held session and reports only the verified changed rule', async () => {
      const snapshot = await startRules()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      expect(await invoke('relayLocalProxyAction', change(snapshot))).toMatchObject({
        status: 'ruleChanged',
        rules: { instanceId: snapshot.instanceId, rules: [{ index: 0, disabled: true }] }
      })
      expect(fixture.localPatchRule).toHaveBeenCalledExactlyOnceWith(
        0,
        true,
        expect.objectContaining({
          assertLive: expect.any(Function),
          submitted: expect.any(Function)
        })
      )
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.localReload).not.toHaveBeenCalled()
      expect(fixture.profileSave).not.toHaveBeenCalled()
      expect(fixture.editSave).not.toHaveBeenCalled()
    })

    it('rejects eventless renderer loss during the initial rule read before the rule PATCH', async () => {
      const snapshot = await startRules()
      const read = fixture.localRulesRead.getMockImplementation()
      if (!read) throw new Error('Missing fixture read')
      fixture.localRulesRead.mockImplementationOnce(async () => {
        const result = await read()
        fixture.window.isVisible.mockReturnValue(false)
        return result
      })
      expect(await invoke('relayLocalProxyAction', change(snapshot))).not.toMatchObject({
        status: 'ruleChanged'
      })
      expect(fixture.localPatchRule).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
    })

    it('rechecks the renderer after the pre-write rule recheck instead of relying on a hide event', async () => {
      const snapshot = await startRules(),
        read = fixture.localRulesRead.getMockImplementation()
      if (!read) throw new Error('Missing fixture read')
      let reads = 0
      fixture.localRulesRead.mockImplementation(async () => {
        const value = await read()
        if (++reads === 2) queueMicrotask(() => fixture.window.isVisible.mockReturnValue(false))
        return value
      })
      expect(await invoke('relayLocalProxyAction', change(snapshot))).not.toMatchObject({
        status: 'ruleChanged'
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.localRulesRead).toHaveBeenCalledTimes(2)
      expect(fixture.localPatchRule).not.toHaveBeenCalled()
    })

    it('holds an invalidated read through actual settlement while preserving independent inert editing', async () => {
      const snapshot = await startRules(),
        value = await fixture.localRulesRead()
      fixture.localRulesRead.mockClear()
      let finish!: (value: Record<string, unknown>) => void
      fixture.localRulesRead.mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve))
      )
      const pending = invoke('relayLocalProxyAction', {
        action: 'rules',
        instanceId: snapshot.instanceId
      })
      await vi.waitFor(() => expect(finish).toBeDefined())
      expect(invoke('relayLocalProxyState')).toMatchObject({ pending: true })
      await Promise.resolve()
        .then(() =>
          invoke('relayLocalProxyAction', { action: 'rules', instanceId: snapshot.instanceId })
        )
        .catch(() => undefined)
      expect(fixture.localRulesRead).toHaveBeenCalledOnce()
      // Saved inert edits do not replace the currently loaded rule table. The
      // established editor contract permits them while an owned core is live.
      await invoke('relayConfigEditSave', {
        document: { globalOverrides: [], profileOverrides: [], controlled: {} },
        expectedRevision: ''
      })
      expect(fixture.editSave).toHaveBeenCalledOnce()
      fixture.window.isVisible.mockReturnValue(false)
      expect(invoke('relayLocalProxyState')).toMatchObject({ pending: true })
      finish(value)
      await pending
      expect(invoke('relayLocalProxyState')).toMatchObject({ pending: false })
      expect(fixture.localPatchRule).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
    })

    it('reports an admitted rule write with lost readback as unconfirmed and reconciles only on an explicit read', async () => {
      const snapshot = await startRules(),
        patch = fixture.localPatchRule.getMockImplementation()
      if (!patch) throw new Error('Missing fixture patch')
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      fixture.localPatchRule.mockImplementationOnce(async (...args) => {
        await patch(...args)
        fixture.localRulesRead.mockRejectedValueOnce(new Error('Synthetic lost readback'))
      })
      expect(await invoke('relayLocalProxyAction', change(snapshot))).toMatchObject({
        status: 'unconfirmed'
      })
      expect(fixture.localPatchRule).toHaveBeenCalledOnce()
      expect(
        await invoke('relayLocalProxyAction', { action: 'rules', instanceId: snapshot.instanceId })
      ).toMatchObject({ rules: { rules: [{ index: 0, disabled: true }] } })
      expect(fixture.localPatchRule).toHaveBeenCalledOnce()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.localReload).not.toHaveBeenCalled()
    })
  })
  it('keeps local-proxy startup/state inert and starts a validated path-free launch directly', async () => {
    expect(invoke('relayLocalProxyState')).toMatchObject({
      phase: 'unknown',
      traffic: 'inactive',
      liveGuardEnabled: false
    })
    expect(fixture.localPort).not.toHaveBeenCalled()
    expect(fixture.profileRead).not.toHaveBeenCalled()
    expect(() => invoke('relayLocalProxyState', { pid: 4567 })).toThrow('不接受')
    await expect(
      invoke('relayLocalProxyPrepare', { path: '/injected', httpPort: 18191 })
    ).rejects.toThrow('只接受')
    const plan = await localPreparation()
    expect(fixture.localPort).toHaveBeenCalledWith(18191)
    expect(fixture.localStart).not.toHaveBeenCalled()
    expect(
      await invoke('relayLocalProxyAction', { action: 'start', evidenceId: plan.evidenceId })
    ).toMatchObject({ status: 'started' })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.coreAcquire).toHaveBeenCalledOnce()
    expect(fixture.localStart).toHaveBeenCalledOnce()
  })
  it('routes only owned group selection and explicit quit drains only the active local proxy', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const plan = await localPreparation()
    const running = (await invoke('relayLocalProxyAction', {
      action: 'start',
      evidenceId: plan.evidenceId
    })) as { state: { instanceId: string } }
    expect(fixture.localStart).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/core'),
      profileRuntimeSource,
      18191,
      expect.any(Function),
      'off',
      undefined,
      expect.objectContaining({
        profileUUID: expect.any(String),
        assertOwner: expect.any(Function)
      }),
      undefined,
      undefined,
      { http: 18191, socks: 0, mixed: 0, redir: 0 },
      undefined
    )
    expect(invoke('relayStatus')).toMatchObject({
      coreRunning: true,
      normalBackendReady: false,
      networkChangesAllowed: false,
      guardEnabled: false
    })
    expect(
      await invoke('relayLocalProxyAction', {
        action: 'select',
        instanceId: running.state.instanceId,
        group: 'Group',
        member: 'DIRECT'
      })
    ).toMatchObject({ status: 'selected', state: { groups: [{ now: 'DIRECT', confirmed: true }] } })
    expect(fixture.localSelect).toHaveBeenCalledWith('Group', 'DIRECT')
    expect(() =>
      invoke('relayCoreAction', { action: 'start', evidenceId: plan.evidenceId })
    ).toThrow('结束')
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    close({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(fixture.localStop).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.desktopRequest).not.toHaveBeenCalled()
  })
  it('carries explicit profile DNS mode through trusted IPC and preserves its scope without another confirmation', async () => {
    const stored = await fixture.profileRead()
    const source = profileRuntimeSource.replace(
      /dns:.*\n/u,
      'dns: {enable: true, nameserver: [127.0.0.1:5353], use-system-hosts: false}\n'
    )
    const sha256 = profileHash(source)
    fixture.profileRead.mockResolvedValue({
      ...stored,
      profile: { ...stored.profile, sha256 },
      text: source
    })
    const plan = (await invoke('relayLocalProxyPrepare', {
      profile: { id: stored.profile.id, sha256 },
      httpPort: 18191,
      resolverMode: 'profile'
    })) as { evidenceId: string; resolution: { enabled: boolean } }
    expect(plan.resolution.enabled).toBe(true)
    expect(fixture.localStart).not.toHaveBeenCalled()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const result = (await invoke('relayLocalProxyAction', {
      action: 'start',
      evidenceId: plan.evidenceId
    })) as { state: { instanceId: string } }
    expect(fixture.localStart).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/core'),
      source,
      18191,
      expect.any(Function),
      'profile',
      undefined,
      expect.objectContaining({
        profileUUID: expect.any(String),
        assertOwner: expect.any(Function)
      }),
      undefined,
      undefined,
      { http: 18191, socks: 0, mixed: 0, redir: 0 },
      undefined
    )
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    expect(
      await invoke('relayLocalProxyAction', { action: 'stop', instanceId: result.state.instanceId })
    ).toMatchObject({ status: 'stopped' })
  })
  it('waits for one consented proxy shutdown across both window/app quit events before exiting', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const plan = await localPreparation()
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: plan.evidenceId })
    let finish!: () => void
    fixture.localStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const close = fixture.window.on.mock.calls.find((call) => call[0] === 'close')?.[1],
      quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    close({ preventDefault })
    quit({ preventDefault })
    await vi.waitFor(() => expect(fixture.localStop).toHaveBeenCalledTimes(1))
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(fixture.coreRelease).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(1))
    expect(fixture.coreRelease).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })
  it('keeps the window/ownership when polite shutdown is unconfirmed and retries only that instance', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const plan = await localPreparation(),
      started = (await invoke('relayLocalProxyAction', {
        action: 'start',
        evidenceId: plan.evidenceId
      })) as { state: { instanceId: string } }
    fixture.localStop.mockRejectedValueOnce(new Error('PRIVATE shutdown error'))
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    close({ preventDefault: vi.fn() })
    await vi.waitFor(() =>
      expect(fixture.confirmRestore).toHaveBeenCalledWith(
        fixture.window,
        expect.objectContaining({ title: '本地代理退出尚未确认' })
      )
    )
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(invoke('relayLocalProxyState')).toMatchObject({ owned: true, uncertain: true })
    expect(invoke('relayStatus')).toMatchObject({ coreRunning: null, guardEnabled: false })
    expect(JSON.stringify(invoke('relayLocalProxyState'))).not.toContain('PRIVATE')
    expect(
      await invoke('relayLocalProxyAction', {
        action: 'stop',
        instanceId: started.state.instanceId
      })
    ).toMatchObject({ status: 'stopped' })
    expect(fixture.localStop).toHaveBeenCalledTimes(2)
  })
  it('prepares declarations without execution, rejects injected paths and routes checks to fixed resources', async () => {
    expect(fixture.profileRead).not.toHaveBeenCalled()
    expect(fixture.profileCheck).not.toHaveBeenCalled()
    const selection = {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource)
    }
    await expect(
      invoke('relayProfileRuntimePrepare', { ...selection, path: '/injected' })
    ).rejects.toThrow('只接受')
    const plan = (await invoke('relayProfileRuntimePrepare', selection)) as {
      evidenceId: string
      canValidate: boolean
    }
    expect(plan.canValidate).toBe(true)
    expect(JSON.stringify(plan)).not.toContain('PRIVATE')
    expect(fixture.profileRead).toHaveBeenCalledWith(selection)
    expect(fixture.profileCheck).not.toHaveBeenCalled()
    expect(await invoke('relayProfileRuntimeCheck', { evidenceId: plan.evidenceId })).toMatchObject(
      { status: 'passed', active: false, fullSourceVerified: false }
    )
    expect(fixture.profileCheck).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/core'),
      profileRuntimeSource
    )
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.profileSave).not.toHaveBeenCalled()
  })
  it('holds app quit until an isolated config-check invocation finishes', async () => {
    const selection = {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(profileRuntimeSource)
    }
    const plan = (await invoke('relayProfileRuntimePrepare', selection)) as { evidenceId: string }
    let finish!: (value: RelayRuntimeCheckResult) => void
    fixture.profileCheck.mockImplementationOnce(
      () =>
        new Promise<RelayRuntimeCheckResult>((resolve) => {
          finish = resolve
        })
    )
    const checking = invoke('relayProfileRuntimeCheck', { evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(fixture.profileCheck).toHaveBeenCalled())
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    close({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(fixture.appQuit).not.toHaveBeenCalled()
    finish({
      status: 'rejected',
      scope: 'isolated-projection',
      fullSourceVerified: false,
      active: false,
      runtimeSHA256: profileHash(compileProfileRuntime(profileRuntimeSource).configuration ?? ''),
      warnings: ['Rejected fixture']
    })
    expect(await checking).toMatchObject({ status: 'rejected' })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(1))
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('uses the native picker only on request and saves the chosen profile without starting a core', async () => {
    expect(fixture.profileList).toHaveBeenCalledOnce()
    expect(fixture.chooseOpen).not.toHaveBeenCalled()
    await expect(invoke('relayProfilePrepare', { path: '/injected' })).rejects.toThrow('不接受')
    expect(await invoke('relayProfilePrepare')).toBeUndefined()
    expect(fixture.profileSource).not.toHaveBeenCalled()
    fixture.chooseOpen.mockResolvedValue({ canceled: false, filePaths: ['/fixture/chosen.yaml'] })
    const report = (await invoke('relayProfilePrepare')) as { evidenceId: string }
    expect(fixture.profileSource).toHaveBeenCalledWith('/fixture/chosen.yaml')
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(await invoke('relayProfileSave', { evidenceId: report.evidenceId })).toMatchObject({
      status: 'saved'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.profileSave).toHaveBeenCalledOnce()
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('waits for confirmed profile persistence before explicit app quit', async () => {
    fixture.chooseOpen.mockResolvedValue({ canceled: false, filePaths: ['/fixture/chosen.yaml'] })
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const report = (await invoke('relayProfilePrepare')) as { evidenceId: string }
    let finish!: (profile: RelayStoredProfile) => void
    fixture.profileSave.mockImplementationOnce(
      () =>
        new Promise<RelayStoredProfile>((resolve) => {
          finish = resolve
        })
    )
    const saving = invoke('relayProfileSave', { evidenceId: report.evidenceId })
    await vi.waitFor(() => expect(fixture.profileSave).toHaveBeenCalled())
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    close({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(fixture.appQuit).not.toHaveBeenCalled()
    finish({
      id: 'fixture',
      name: 'Local',
      createdAt: '2026-10-24',
      sha256: 'b'.repeat(64),
      summary: { proxies: 0, groups: 0, rules: 0, proxyProviders: 0, ruleProviders: 0 }
    })
    expect(await saving).toMatchObject({ status: 'saved' })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(1))
    expect(await invoke('relayProfileList')).toMatchObject({ activeId: null })
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.coreAcquire).not.toHaveBeenCalled()
  })
  it('keeps cached core state inert, validates preparation before an explicit start', async () => {
    expect(invoke('relayCoreState')).toMatchObject({
      phase: 'unknown',
      owned: false,
      trafficEnabled: false
    })
    expect(fixture.coreInspect).not.toHaveBeenCalled()
    expect(() => invoke('relayCoreState', { pid: 1234 })).toThrow('不接受')
    await expect(invoke('relayCorePrepare', { mode: 'rule', path: '/injected' })).rejects.toThrow()
    const proof = (await invoke('relayCorePrepare', { mode: 'global' })) as { evidenceId: string }
    expect(fixture.coreResources).toHaveBeenCalledWith(expect.stringContaining('/extra/relay/core'))
    expect(fixture.coreAcquire).not.toHaveBeenCalled()
    expect(
      await invoke('relayCoreAction', { action: 'start', evidenceId: proof.evidenceId })
    ).toMatchObject({ status: 'started' })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.coreStart).toHaveBeenCalledOnce()
    expect(fixture.coreAcquire).toHaveBeenCalledOnce()
  })
  it('starts only the fixed isolated core and waits for its cleanup before quitting', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const proof = (await invoke('relayCorePrepare', { mode: 'direct' })) as { evidenceId: string }
    expect(
      await invoke('relayCoreAction', { action: 'start', evidenceId: proof.evidenceId })
    ).toMatchObject({
      status: 'started',
      state: { mode: 'direct', owned: true, trafficEnabled: false }
    })
    expect(fixture.coreStart).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/core'),
      'direct',
      expect.any(Function)
    )
    expect(invoke('relayStatus')).toMatchObject({
      coreRunning: true,
      normalBackendReady: false,
      networkChangesAllowed: false
    })
    let finish!: () => void
    fixture.coreStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    close({ preventDefault })
    quit({ preventDefault })
    await vi.waitFor(() => expect(fixture.coreStop).toHaveBeenCalledTimes(1))
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(fixture.coreRelease).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(1))
    expect(fixture.coreRelease).toHaveBeenCalledTimes(1)
  })
  it('retains the window and session ownership when core record cleanup cannot be confirmed', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const proof = (await invoke('relayCorePrepare', { mode: 'rule' })) as { evidenceId: string }
    await invoke('relayCoreAction', { action: 'start', evidenceId: proof.evidenceId })
    fixture.coreRelease.mockRejectedValueOnce(new Error('PRIVATE record'))
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    close({ preventDefault: vi.fn() })
    await vi.waitFor(() =>
      expect(fixture.confirmRestore).toHaveBeenCalledWith(
        fixture.window,
        expect.objectContaining({ title: '核心退出或记录清理尚未完成' })
      )
    )
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(invoke('relayCoreState')).toMatchObject({ owned: true, uncertain: true })
    expect(await invoke('relayCoreAction', { action: 'stop' })).toMatchObject({
      status: 'stopped',
      state: { owned: false }
    })
    expect(fixture.coreStop).toHaveBeenCalledTimes(1)
    const suspend = fixture.powerOn.mock.calls.find((call) => call[0] === 'suspend')?.[1]
    suspend()
    expect(invoke('relayCoreLifecycleState')).toMatchObject({ phase: 'asleep' })
  })
  describe('tray profile activation Main wiring', () => {
    const setup = async () => {
      const stored = await fixture.profileRead()
      const source = profileRuntimeSource.replace(
        /^dns:.*$/mu,
        'dns: {enable: true, nameserver: [1.1.1.1], default-nameserver: [1.1.1.1]}'
      )
      stored.text = source
      stored.profile.sha256 = profileHash(source)
      fixture.profileRead.mockResolvedValue(stored)
      fixture.profileList.mockResolvedValue({
        profiles: [stored.profile],
        activeId: null,
        incomplete: 0,
        warnings: []
      })
      fixture.saveCoreSelectionNative.mockImplementation(
        async (_executable, _context, selection) => {
          const snapshot = { selection, revision: 'b'.repeat(64) }
          fixture.readCoreSelectionNative.mockResolvedValue(snapshot)
          return snapshot
        }
      )
      await fixture.shellHostOptions?.workflowMenuOpening?.()
      expect(fixture.systemProxyNative.mock.calls.every((call) => call[2] === 'inspect')).toBe(true)
      fixture.systemProxyNative.mockClear()
      const menu = fixture.trayItems.find((item) => item.label === '订阅配置')?.submenu
      if (!Array.isArray(menu)) throw new Error('Missing profile menu')
      const click = menu[0]?.click
      if (!click) throw new Error('Missing profile menu action')
      return { stored, click: () => Reflect.apply(click, undefined, []) }
    }
    it('opens a read-only menu then starts its selected profile with one click and no system takeover', async () => {
      expect(fixture.shellHostOptions?.information?.().systemProxy).toBeUndefined()
      const f = await setup()
      expect(fixture.shellHostOptions?.information?.()).toMatchObject({
        systemProxy: false,
        tun: false
      })
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.saveCoreSelectionNative).not.toHaveBeenCalled()
      f.click()
      await vi.waitFor(() =>
        expect(invoke('relayLocalProxyState')).toMatchObject({
          owned: true,
          phase: 'running',
          profileId: f.stored.profile.id,
          httpPort: 18191,
          lifetime: 'main'
        })
      )
      expect(fixture.localStart).toHaveBeenCalledOnce()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.coreStart).not.toHaveBeenCalled()
    })
    it('refuses a stored legacy lease instead of adopting or cleaning it for a tray selection', async () => {
      const f = await setup()
      fixture.coreInspect.mockResolvedValue({
        mode: 'rule',
        revision: 'a'.repeat(64),
        lease: 'active'
      })
      f.click()
      await vi.waitFor(() =>
        expect(fixture.confirmRestore).toHaveBeenCalledWith(
          fixture.window,
          expect.objectContaining({ title: '托盘操作未确认' })
        )
      )
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.coreRelease).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
    })
    it('does not start a late preparation after the window is hidden', async () => {
      const f = await setup()
      let release!: () => void
      fixture.coreInspect.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { mode: 'rule', revision: 'a'.repeat(64), lease: 'missing' }
      })
      f.click()
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
      release()
      await vi.waitFor(() => expect(fixture.confirmRestore).toHaveBeenCalled())
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
    })
    it('keeps a newer saved choice when it changes during tray preparation', async () => {
      const f = await setup()
      let release!: () => void
      fixture.coreInspect.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { mode: 'rule', revision: 'a'.repeat(64), lease: 'missing' }
      })
      f.click()
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      fixture.readCoreSelectionNative.mockResolvedValue({
        revision: 'c'.repeat(64),
        selection: { id: '00000000-0000-0000-0000-000000000002', sha256: f.stored.profile.sha256 }
      })
      release()
      await vi.waitFor(() => expect(fixture.confirmRestore).toHaveBeenCalled())
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.saveCoreSelectionNative).toHaveBeenCalledOnce()
      expect(fixture.localStop).not.toHaveBeenCalled()
    })
  })
  it('waits for a tray read on quit, rejects backup during it and discards the late menu', async () => {
    await fixture.shellHostOptions?.workflowMenuOpening?.()
    let finish!: (value: {
      profiles: never[]
      activeId: null
      incomplete: number
      warnings: never[]
    }) => void
    fixture.profileList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const opening = fixture.shellHostOptions?.workflowMenuOpening?.()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(invoke('relayBackupExport') as Promise<unknown>).rejects.toThrow('窗口')
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    quit({ preventDefault: vi.fn() })
    expect(fixture.appQuit).not.toHaveBeenCalled()
    finish({ profiles: [], activeId: null, incomplete: 0, warnings: [] })
    await opening
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    expect(fixture.saveCoreSelectionNative).not.toHaveBeenCalled()
    expect(fixture.localSelect).not.toHaveBeenCalled()
    expect(fixture.trayItems[0].label).toContain('已变化')
  })
  describe('restart Main guarded shutdown', () => {
    type QuitEvent = { defaultPrevented: boolean; preventDefault(): void }
    const freshEvent = (): QuitEvent => ({
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    })
    const appEvent = (name: string, event: QuitEvent, exitCode = 0): void => {
      for (const [type, callback] of fixture.appOn.mock.calls)
        if (type === name && typeof callback === 'function') callback(event, exitCode)
    }
    const nativeQuit = (
      initial: {
        beforeVeto?: boolean
        willVeto?: boolean
        unloadVeto?: boolean
        exitCode?: number
      } = {}
    ) => {
      const flags = { ...initial, exited: vi.fn() }
      fixture.appQuit.mockImplementation(() => {
        const before = freshEvent()
        appEvent('before-quit', before)
        if (flags.beforeVeto) before.preventDefault()
        if (before.defaultPrevented) return
        const closing = freshEvent()
        for (const [type, callback] of fixture.window.on.mock.calls)
          if (type === 'close' && typeof callback === 'function') callback(closing)
        if (closing.defaultPrevented) return
        if (flags.unloadVeto) {
          const unload = freshEvent()
          for (const [type, callback] of fixture.window.webContents.on.mock.calls)
            if (type === 'will-prevent-unload' && typeof callback === 'function') callback(unload)
          // Electron honors renderer refusal unless Main explicitly overrides it.
          if (!unload.defaultPrevented) return
        }
        const will = freshEvent()
        appEvent('will-quit', will)
        if (flags.willVeto) will.preventDefault()
        if (will.defaultPrevented) return
        flags.exited()
        appEvent('quit', freshEvent(), flags.exitCode ?? 0)
      })
      return flags
    }
    const assertOpen = async (): Promise<void> => {
      await vi.waitFor(() => expect(fixture.shellHostOptions?.canPerform?.()).toBe(true))
      expect(fixture.appRelaunch).not.toHaveBeenCalled()
    }
    const startProxyForQuit = async (): Promise<void> => {
      const stored = await fixture.profileRead()
      stored.text = stored.text.replace(
        /^dns:.*$/mu,
        'dns: {enable: true, nameserver: [1.1.1.1], default-nameserver: [1.1.1.1]}'
      )
      stored.profile.sha256 = profileHash(stored.text)
      fixture.profileRead.mockResolvedValue(stored)
      const plan = (await invoke('relayLocalProxyPrepare', {
        profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
        httpPort: 18191,
        resolverMode: 'profile'
      })) as { evidenceId: string }
      await expect(
        invoke('relayLocalProxyAction', { action: 'start', evidenceId: plan.evidenceId })
      ).resolves.toMatchObject({ status: 'started' })
    }
    it('quits through app and window close with an external proxy and a stale recovery record', async () => {
      await startProxyForQuit()
      const normal = fixture.systemProxyNative.getMockImplementation()
      if (!normal) throw new Error('Missing native adapter')
      fixture.systemProxyNative.mockImplementation(async (...args) => ({
        ...(await normal(...args)),
        status: 'conflict',
        currentProxyPorts: undefined,
        recordID: '00000000-0000-0000-0000-000000000001',
        quitProxyPorts: [7890]
      }))
      const flags = nativeQuit()
      fixture.appQuit()
      await vi.waitFor(() => expect(flags.exited).toHaveBeenCalledOnce())
      expect(fixture.appQuit).toHaveBeenCalledTimes(2)
      expect(fixture.localStop).toHaveBeenCalledOnce()
      expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual([
        'inspect',
        'inspect'
      ])
    })
    it('explains a record-free proxy dependency and exits after an explicit corrected retry', async () => {
      await startProxyForQuit()
      const normal = fixture.systemProxyNative.getMockImplementation()
      if (!normal) throw new Error('Missing native adapter')
      let ports = [18191]
      fixture.systemProxyNative.mockImplementation(async (...args) => ({
        ...(await normal(...args)),
        currentProxyPorts: ports
      }))
      const flags = nativeQuit()
      fixture.appQuit()
      await vi.waitFor(() =>
        expect(fixture.confirmRestore).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            title: '系统代理恢复未确认',
            detail: expect.stringContaining('当前没有可自动恢复的代理记录')
          })
        )
      )
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(flags.exited).not.toHaveBeenCalled()
      ports = []
      fixture.appQuit()
      await vi.waitFor(() => expect(flags.exited).toHaveBeenCalledOnce())
      expect(fixture.localStop).toHaveBeenCalledOnce()
    })
    it('retries only its held core after an unconfirmed stop with an unrelated external proxy', async () => {
      await startProxyForQuit()
      const normal = fixture.systemProxyNative.getMockImplementation()
      if (!normal) throw new Error('Missing native adapter')
      fixture.systemProxyNative.mockImplementation(async (...args) => ({
        ...(await normal(...args)),
        status: 'conflict',
        currentProxyPorts: undefined,
        recordID: '00000000-0000-0000-0000-000000000001',
        quitProxyPorts: [7890]
      }))
      fixture.localStop.mockRejectedValueOnce(new Error('Synthetic unconfirmed stop'))
      const flags = nativeQuit()
      fixture.appQuit()
      await vi.waitFor(() =>
        expect(fixture.confirmRestore).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ title: '本地代理退出尚未确认' })
        )
      )
      expect(invoke('relayLocalProxyState')).toMatchObject({ owned: true, uncertain: true })
      expect(flags.exited).not.toHaveBeenCalled()
      fixture.appQuit()
      await vi.waitFor(() => expect(flags.exited).toHaveBeenCalledOnce())
      expect(fixture.localStop).toHaveBeenCalledTimes(2)
    })
    it('quits an inert core with an unrelated external proxy and a stale recovery record', async () => {
      const plan = (await invoke('relayCorePrepare', { mode: 'rule' })) as { evidenceId: string }
      await expect(
        invoke('relayCoreAction', { action: 'start', evidenceId: plan.evidenceId })
      ).resolves.toMatchObject({ status: 'started', state: { trafficEnabled: false } })
      const normal = fixture.systemProxyNative.getMockImplementation()
      if (!normal) throw new Error('Missing native adapter')
      fixture.systemProxyNative.mockImplementation(async (...args) => ({
        ...(await normal(...args)),
        status: 'conflict',
        currentProxyPorts: undefined,
        recordID: '00000000-0000-0000-0000-000000000001',
        quitProxyPorts: [7890]
      }))
      const flags = nativeQuit()
      fixture.appQuit()
      await vi.waitFor(() => expect(flags.exited).toHaveBeenCalledOnce())
      expect(fixture.coreStop).toHaveBeenCalledOnce()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual(['inspect'])
    })
    it('keeps a running proxy if any service still points to its port', async () => {
      await startProxyForQuit()
      fixture.window.isVisible.mockReturnValue(false)
      fixture.shellShowWindow.mockClear()
      const normal = fixture.systemProxyNative.getMockImplementation()
      if (!normal) throw new Error('Missing native adapter')
      fixture.systemProxyNative.mockImplementation(async (...args) => ({
        ...(await normal(...args)),
        status: 'conflict',
        currentProxyPorts: undefined,
        recordID: '00000000-0000-0000-0000-000000000001',
        quitProxyPorts: [18191]
      }))
      const flags = nativeQuit()
      fixture.appQuit()
      await vi.waitFor(() =>
        expect(fixture.confirmRestore).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ title: '系统代理恢复未确认' })
        )
      )
      expect(fixture.shellShowWindow).toHaveBeenCalled()
      expect(flags.exited).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual(['inspect'])
    })
    it('preserves the running core if a proxy is redirected to it during the quit drain', async () => {
      await startProxyForQuit()
      const normal = fixture.systemProxyNative.getMockImplementation()
      if (!normal) throw new Error('Missing native adapter')
      const conflict = async (args: Parameters<typeof normal>) => ({
        ...(await normal(...args)),
        status: 'conflict',
        currentProxyPorts: undefined,
        recordID: '00000000-0000-0000-0000-000000000001'
      })
      let finishRecheck: (() => void) | undefined
      fixture.systemProxyNative
        .mockImplementationOnce(async (...args) => ({
          ...(await conflict(args)),
          quitProxyPorts: [7890]
        }))
        .mockImplementationOnce(async (...args) => {
          const result = await conflict(args)
          await new Promise<void>((resolve) => {
            finishRecheck = resolve
          })
          return result
        })
      const flags = nativeQuit()
      fixture.appQuit()
      await vi.waitFor(() => expect(finishRecheck).toBeTypeOf('function'))
      expect(fixture.localStop).not.toHaveBeenCalled()
      finishRecheck?.()
      await vi.waitFor(() =>
        expect(fixture.confirmRestore).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ title: '系统代理恢复未确认' })
        )
      )
      expect(flags.exited).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual([
        'inspect',
        'inspect'
      ])
    })
    it('restarts directly but accepts no launch path, arguments or authorization marker', async () => {
      nativeQuit()
      expect(() => invoke('relaunchApp', { args: ['--unsafe'] })).toThrow('不接受')
      expect(await invoke('relayShellAction', 'restartApp')).toEqual({ status: 'requested' })
      await vi.waitFor(() => expect(fixture.appRelaunch).toHaveBeenCalledOnce())
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
    })
    it('drains even with no active owner, returns out of shell pending, then schedules only at final quit', async () => {
      nativeQuit()
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      expect(await invoke('relaunchApp')).toEqual({ status: 'requested' })
      await vi.waitFor(() => expect(fixture.appRelaunch).toHaveBeenCalledOnce())
      expect(fixture.appQuit).toHaveBeenCalledOnce()
      expect(fixture.coreStart).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
      appEvent('quit', freshEvent())
      expect(fixture.appRelaunch).toHaveBeenCalledOnce()
    })
    it('keeps an unconfirmed own proxy shutdown and never schedules a later ordinary quit', async () => {
      await startProxyForQuit()
      fixture.localStop.mockRejectedValueOnce(new Error('synthetic cleanup failure'))
      expect(await invoke('relaunchApp')).toEqual({ status: 'requested' })
      await assertOpen()
      expect(invoke('relayLocalProxyState')).toMatchObject({ owned: true, uncertain: true })
      expect(fixture.appQuit).not.toHaveBeenCalled()
      expect(fixture.localStop).toHaveBeenCalledOnce()
      appEvent('quit', freshEvent())
      expect(fixture.appRelaunch).not.toHaveBeenCalled()
    })
    it.each(['beforeVeto', 'willVeto', 'unloadVeto'] as const)(
      'revokes helper on %s and does not revive it on an ordinary quit',
      async (kind) => {
        const flags = nativeQuit({ [kind]: true })
        fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        expect(await invoke('relaunchApp')).toEqual({ status: 'requested' })
        await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
        await assertOpen()
        expect(invoke('relayCoreLifecycleState')).toMatchObject({ observed: false })
        flags[kind] = false
        fixture.appQuit()
        expect(fixture.appRelaunch).not.toHaveBeenCalled()
      }
    )
    it('recovers observation if a final quit callback is not observed synchronously', async () => {
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relaunchApp')
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
      await assertOpen()
      expect(invoke('relayCoreLifecycleState')).toMatchObject({ observed: false })
    })
    it('does not schedule on nonzero final exit', async () => {
      nativeQuit({ exitCode: 7 })
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relaunchApp')
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
      expect(fixture.appRelaunch).not.toHaveBeenCalled()
    })
    it('revokes a direct restart intent on the actual Host background callback before drain', async () => {
      const pending = invoke('relaunchApp')
      fixture.shellHostOptions?.backgroundChosen?.()
      expect(await pending).toEqual({ status: 'cancelled' })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.appQuit).not.toHaveBeenCalled()
      expect(fixture.appRelaunch).not.toHaveBeenCalled()
    })
    it('does not turn a revoked restart into ordinary quit while geometry is flushing', async () => {
      nativeQuit()
      fixture.window.getNormalBounds.mockReturnValue({ x: 200, y: 80, width: 1100, height: 760 })
      let finish: (revision: string) => void = () => {
        throw new Error('barrier not started')
      }
      fixture.geometrySave.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relaunchApp')
      await vi.waitFor(() => expect(fixture.geometrySave).toHaveBeenCalled())
      for (const [type, callback] of fixture.window.webContents.on.mock.calls)
        if (type === 'did-start-navigation' && typeof callback === 'function')
          callback({ isMainFrame: true, isSameDocument: false })
      finish('b'.repeat(64))
      await assertOpen()
      expect(fixture.appQuit).not.toHaveBeenCalled()
    })
    it('revalidates a fresh drain pass if final before-quit sees newly changed geometry', async () => {
      nativeQuit()
      const drive = fixture.appQuit.getMockImplementation()
      if (!drive) throw new Error('Missing native quit driver')
      let attempts = 0
      const helperCounts: number[] = []
      fixture.appQuit.mockImplementation(() => {
        attempts++
        if (attempts === 1)
          fixture.window.getNormalBounds.mockReturnValue({
            x: 220,
            y: 90,
            width: 1080,
            height: 740
          })
        drive()
        helperCounts.push(fixture.appRelaunch.mock.calls.length)
      })
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      expect(await invoke('relaunchApp')).toEqual({ status: 'requested' })
      await vi.waitFor(() => expect(fixture.appRelaunch).toHaveBeenCalledOnce())
      expect(fixture.appQuit).toHaveBeenCalledTimes(2)
      expect(helperCounts[0]).toBe(0)
      expect(fixture.geometrySave).toHaveBeenCalled()
    })
    it('window close cancels a pending restart without converting it to ordinary quit, even with close-to-tray disabled', async () => {
      nativeQuit()
      fixture.window.getNormalBounds.mockReturnValue({ x: 200, y: 80, width: 1100, height: 760 })
      let finish!: (revision: string) => void
      fixture.geometrySave.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await invoke('relaunchApp')
      await vi.waitFor(() => expect(fixture.geometrySave).toHaveBeenCalled())
      const closing = freshEvent()
      for (const [name, listener] of fixture.window.on.mock.calls)
        if (name === 'close') listener(closing)
      expect(closing.defaultPrevented).toBe(true)
      expect(fixture.window.hide).toHaveBeenCalled()
      finish('b'.repeat(64))
      await assertOpen()
      expect(fixture.appQuit).not.toHaveBeenCalled()
      expect(fixture.appRelaunch).not.toHaveBeenCalled()
    })
    it('lets an explicit ordinary quit override a pending restart without relaunch', async () => {
      nativeQuit()
      fixture.window.getNormalBounds.mockReturnValue({ x: 200, y: 80, width: 1100, height: 760 })
      let finish: (revision: string) => void = () => {
        throw new Error('barrier not started')
      }
      fixture.geometrySave.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await invoke('relaunchApp')
      await vi.waitFor(() => expect(fixture.geometrySave).toHaveBeenCalled())
      fixture.appQuit()
      finish('b'.repeat(64))
      await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(2))
      expect(fixture.appRelaunch).not.toHaveBeenCalled()
    })
  })
  it('online themes Main fetches after one explicit action and only produces an explicit draft', async () => {
    const adapters = fixture.themeAdapters
    if (!adapters) throw new Error('Missing theme adapter')
    adapters.local = () => ({
      phase: 'running',
      owned: true,
      pending: false,
      uncertain: false,
      hasRecord: true,
      instanceId: '00000000-0000-4000-8000-000000000038',
      configurationRevision: 'configuration',
      pid: 42,
      httpPort: 18191,
      traffic: 'listening',
      groups: [],
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: []
    })
    fixture.downloadThemes.mockClear()
    expect(() => invoke('relayShellThemesAcquire', { url: 'https://evil', proxyPort: 80 })).toThrow(
      '固定官方'
    )
    const zip = new AdmZip()
    zip.addFile('Ocean.css', Buffer.from('/* Ocean */\nbody{color:navy}'))
    fixture.downloadThemes.mockResolvedValueOnce(zip.toBuffer())
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const before = invoke('relayShellState')
    const result = (await invoke('relayShellThemesAcquire')) as {
      status: string
      acquisitionId: string
      candidates: unknown[]
    }
    expect(result.status).toBe('ready')
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(result.candidates[0]).not.toHaveProperty('css')
    const themes = await invoke('relayShellThemesDraft', {
      acquisitionId: result.acquisitionId,
      path: 'Ocean.css',
      themes: []
    })
    expect(themes).toEqual([
      { id: expect.any(String), name: 'Ocean', css: '/* Ocean */\nbody{color:navy}' }
    ])
    expect(invoke('relayShellState')).toEqual(before)
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.copy).not.toHaveBeenCalled()
    invoke('relayShellThemesCancel')
    expect(() =>
      invoke('relayShellThemesDraft', {
        acquisitionId: result.acquisitionId,
        path: 'Ocean.css',
        themes: []
      })
    ).toThrow('失效')
  })
  it('online themes Main retires ready candidates only on a replaced main document', async () => {
    const adapters = fixture.themeAdapters
    if (!adapters) throw new Error('Missing theme adapter')
    adapters.local = () => ({
      phase: 'running',
      owned: true,
      pending: false,
      uncertain: false,
      hasRecord: true,
      instanceId: '00000000-0000-4000-8000-000000000038',
      configurationRevision: 'configuration',
      pid: 42,
      httpPort: 18191,
      traffic: 'listening',
      groups: [],
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: []
    })
    const zip = new AdmZip()
    zip.addFile('Ocean.css', Buffer.from('/* Ocean */\nbody{color:navy}'))
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    fixture.downloadThemes.mockClear()
    fixture.downloadThemes.mockResolvedValueOnce(zip.toBuffer())
    const first = (await invoke('relayShellThemesAcquire')) as { acquisitionId: string }
    const draft = { acquisitionId: first.acquisitionId, path: 'Ocean.css', themes: [] }
    const navigate = (isMainFrame: boolean, isSameDocument: boolean) => {
      for (const [name, callback] of fixture.window.webContents.on.mock.calls)
        if (name === 'did-start-navigation') callback({ isMainFrame, isSameDocument })
    }
    navigate(true, true)
    navigate(false, false)
    expect(invoke('relayShellThemesDraft', draft)).toHaveLength(1)
    navigate(true, false)
    expect(() => invoke('relayShellThemesDraft', draft)).toThrow('失效')
  })
  it('online themes Main aborts a pending fetch on a replaced main document', async () => {
    const adapters = fixture.themeAdapters
    if (!adapters) throw new Error('Missing theme adapter')
    adapters.local = () => ({
      phase: 'running',
      owned: true,
      pending: false,
      uncertain: false,
      hasRecord: true,
      instanceId: '00000000-0000-4000-8000-000000000038',
      configurationRevision: 'configuration',
      pid: 42,
      httpPort: 18191,
      traffic: 'listening',
      groups: [],
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: []
    })
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    fixture.downloadThemes.mockReset()
    const navigate = (isMainFrame: boolean, isSameDocument: boolean) => {
      for (const [name, callback] of fixture.window.webContents.on.mock.calls)
        if (name === 'did-start-navigation') callback({ isMainFrame, isSameDocument })
    }
    let finish: (bytes: Buffer) => void = () => {
      throw new Error('barrier not started')
    }
    fixture.downloadThemes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = invoke('relayShellThemesAcquire')
    await vi.waitFor(() => expect(fixture.downloadThemes).toHaveBeenCalledOnce())
    const signal = fixture.downloadThemes.mock.calls[0][1]
    navigate(true, true)
    expect(signal.aborted).toBe(false)
    navigate(true, false)
    expect(signal.aborted).toBe(true)
    finish(Buffer.from('late invalid archive'))
    expect(await pending).toEqual({ status: 'cancelled' })
  })
  it('online themes Main cancels on hide without waiting for a late downloader or touching Core', async () => {
    const adapters = fixture.themeAdapters
    if (!adapters) throw new Error('Missing theme adapter')
    adapters.local = () => ({
      phase: 'running',
      owned: true,
      pending: false,
      uncertain: false,
      hasRecord: true,
      instanceId: '00000000-0000-4000-8000-000000000038',
      configurationRevision: 'configuration',
      pid: 42,
      httpPort: 18191,
      traffic: 'listening',
      groups: [],
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: []
    })
    fixture.downloadThemes.mockClear()
    let finish: (bytes: Buffer) => void = () => {
      throw new Error('barrier not started')
    }
    fixture.downloadThemes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fixture.confirmRestore.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const pending = invoke('relayShellThemesAcquire')
    await vi.waitFor(() => expect(fixture.downloadThemes).toHaveBeenCalledOnce())
    const hide = fixture.window.on.mock.calls.find((call) => call[0] === 'hide')?.[1]
    if (!hide) throw new Error('Missing hide handler')
    hide()
    const signal = fixture.downloadThemes.mock.calls[0][1]
    expect(signal.aborted).toBe(true)
    finish(Buffer.from('late invalid ZIP'))
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(fixture.coreStart).not.toHaveBeenCalled()
  })
  it('tray preferences bind Main save to current revision and retain all other settings', async () => {
    const preferences = fixture.shellHostOptions?.preferences
    if (!preferences) throw new Error('Missing tray preferences adapter')
    const before = preferences.state()
    await preferences.save(
      { ...before.settings, environmentFormat: 'fish', swapTrayClick: true },
      before.revision
    )
    expect(invoke('relayShellState')).toMatchObject({
      settings: { environmentFormat: 'fish', swapTrayClick: true },
      pending: false
    })
    await expect(preferences.save(before.settings, before.revision)).rejects.toThrow('版本')
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.loginWrite).not.toHaveBeenCalled()
    expect(fixture.copy).not.toHaveBeenCalled()
  })
  it('tray information remains unknown without a confirmed own cached session', () => {
    expect(fixture.shellHostOptions?.information?.()).toEqual({
      mode: undefined,
      systemProxy: undefined,
      tun: false
    })
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.copy).not.toHaveBeenCalled()
  })
  it('tray preferences preserve the default environment and reject an invalid explicit format', async () => {
    const preferences = fixture.shellHostOptions?.preferences
    if (!preferences) throw new Error('Missing tray preferences adapter')
    const before = preferences.state()
    expect(before.settings.environmentFormat).toBe('default')
    await expect(
      invoke('relayShellSave', {
        revision: before.revision,
        settings: { ...defaultShellSettings(), environmentFormat: 'arbitrary' }
      })
    ).rejects.toThrow('格式')
    expect(preferences.state().revision).toBe(before.revision)
  })
  it('recovers a hidden custom interface from a native menu without resetting other window preferences', async () => {
    const initial = invoke('relayShellState') as {
      settings: Record<string, unknown>
      revision: string
    }
    await invoke('relayShellSave', {
      settings: { ...initial.settings, customCSS: 'body { visibility: hidden }', appTheme: 'dark' },
      revision: initial.revision
    })
    const root = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0][0].submenu
    if (!Array.isArray(root)) throw new Error('Missing native menu')
    const reset = root.find((item) => item.label === '清除自定义界面样式')?.click
    if (!reset) throw new Error('Missing native reset')
    Reflect.apply(reset, undefined, [])
    await vi.waitFor(() =>
      expect(invoke('relayShellState')).toMatchObject({
        settings: { customCSS: '', appTheme: 'dark' },
        pending: false
      })
    )
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.loginWrite).not.toHaveBeenCalled()
  })
  it('imports a bounded CSS draft only from the native picker and leaves saved settings unchanged', async () => {
    const before = invoke('relayShellState')
    expect(() => invoke('relayShellCSSImport', { path: '/PRIVATE' })).toThrow('不接受')
    expect(await invoke('relayShellCSSImport')).toBeUndefined()
    expect(fixture.binaryRead).not.toHaveBeenCalled()
    fixture.chooseOpen.mockResolvedValueOnce({ canceled: false, filePaths: ['/fixture/theme.css'] })
    expect(await invoke('relayShellCSSImport')).toBe('body{color:red}')
    expect(fixture.binaryRead).toHaveBeenCalledWith('/fixture/theme.css', false, 8192)
    expect(invoke('relayShellState')).toEqual(before)
    fixture.chooseOpen.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/fixture/private.json']
    })
    await expect(invoke('relayShellCSSImport') as Promise<unknown>).rejects.toThrow('CSS')
    expect(fixture.binaryRead).toHaveBeenCalledOnce()
    fixture.chooseOpen.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/fixture/invalid.css']
    })
    fixture.binaryRead.mockResolvedValueOnce(Buffer.from([0xff]))
    await expect(invoke('relayShellCSSImport') as Promise<unknown>).rejects.toThrow()
  })
  it('waits for CSS file selection on quit without writing the returned draft', async () => {
    let finish!: (value: { canceled: boolean; filePaths: string[] }) => void
    fixture.chooseOpen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const selecting = invoke('relayShellCSSImport') as Promise<unknown>
    await vi.waitFor(() => expect(fixture.chooseOpen).toHaveBeenCalled())
    await expect(invoke('relayBackupExport') as Promise<unknown>).rejects.toThrow('窗口')
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    quit({ preventDefault: vi.fn() })
    expect(fixture.appQuit).not.toHaveBeenCalled()
    finish({ canceled: true, filePaths: [] })
    await expect(selecting).resolves.toBeUndefined()
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    expect(fixture.binaryRead).not.toHaveBeenCalled()
  })
  it('keeps login-item startup inert and rejects the development Electron host', async () => {
    expect(fixture.loginRead).not.toHaveBeenCalled()
    expect(fixture.loginWrite).not.toHaveBeenCalled()
    expect(() => invoke('checkAutoRun')).toThrow('已打包')
    await expect(invoke('enableAutoRun') as Promise<unknown>).rejects.toThrow('已打包')
    expect(fixture.loginWrite).not.toHaveBeenCalled()
    await fixture.afterBackupRestore?.()
    expect(fixture.loginWrite).not.toHaveBeenCalled()
  })
  it('registers current-app login channels once and rejects paths and untrusted senders before OS access', () => {
    fixture.packaged = true
    expect(invoke('checkAutoRun')).toBe(false)
    for (const channel of ['checkAutoRun', 'enableAutoRun', 'disableAutoRun']) {
      expect(() => invoke(channel, { path: '/Other.app' })).toThrow('不接受')
      const handler = fixture.handlers.get(channel)
      expect(handler).toBeDefined()
      expect(() => handler?.({ sender: {}, senderFrame: {} })).toThrow('Untrusted')
    }
    expect(fixture.loginRead).toHaveBeenCalledOnce()
    expect(fixture.loginWrite).not.toHaveBeenCalled()
  })
  it('modifies directly on explicit action and targets only the current-app login item', async () => {
    fixture.packaged = true
    expect(await invoke('enableAutoRun')).toMatchObject({ status: 'applied', openAtLogin: true })
    expect(await invoke('disableAutoRun')).toMatchObject({ status: 'applied', openAtLogin: false })
    expect(fixture.loginWrite.mock.calls).toEqual([
      [{ openAtLogin: true }],
      [{ openAtLogin: false }]
    ])
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.coreStart).not.toHaveBeenCalled()
    expect(fixture.localStart).not.toHaveBeenCalled()
  })
  it('holds backup and window mutations during a direct login action and rechecks quit before writing', async () => {
    fixture.packaged = true
    const changing = invoke('enableAutoRun') as Promise<unknown>,
      rejected = expect(changing).rejects.toThrow('退出')
    const blockedBackup = expect(invoke('relayBackupExport') as Promise<unknown>).rejects.toThrow()
    expect(() => invoke('relayShellInitialize')).toThrow('登录项')
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    quit({ preventDefault: vi.fn() })
    expect(fixture.appQuit).not.toHaveBeenCalled()
    fixture.packaged = false
    await blockedBackup
    await rejected
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledOnce())
    expect(fixture.loginWrite).not.toHaveBeenCalled()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
  })
  it('reads guard build status only on a trusted argument-free request, without starting another action', async () => {
    expect(fixture.guardReadinessNative).not.toHaveBeenCalled()
    expect(() => invoke('relayGuardReadiness', { path: '/injected.app' })).toThrow('不接受')
    expect(fixture.guardReadinessNative).not.toHaveBeenCalled()
    expect(await invoke('relayGuardReadiness')).toEqual(guardReadinessFixture())
    expect(fixture.guardReadinessNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative')
    )
    expect(fixture.openDesktopTransport).not.toHaveBeenCalled()
    expect(fixture.openRelayBrowser).not.toHaveBeenCalled()
    expect(fixture.openEdgeToolNative).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
  })
  it('keeps Edge inspection inert and opens the checked profile directly while preserving its native revision', async () => {
    expect(fixture.inspectEdgeNative).not.toHaveBeenCalled()
    const report = (await invoke('relayEdgeInspect')) as { evidenceId: string }
    expect(fixture.inspectEdgeNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      {
        home: '/fake/home',
        stateRoot: '/fake/home/Library/Application Support/Relay-Preview'
      }
    )
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: true })
    expect(await invoke('relayEdgeProfileOpen', { evidenceId: report.evidenceId })).toMatchObject({
      status: 'requested',
      installed: false
    })
    expect(fixture.openEdgeToolNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      'openProfile',
      {
        home: '/fake/home',
        stateRoot: '/fake/home/Library/Application Support/Relay-Preview'
      },
      'a'.repeat(64)
    )
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
  })
  it('only opens the two fixed Edge/system entries and rejects renderer paths before any open', async () => {
    expect(() => invoke('relayEdgeInspect', { home: '/injected' })).toThrow('不接受')
    for (const request of [
      { action: 'openProfile' },
      { action: 'edgePolicy', url: 'https://injected' }
    ])
      await expect(invoke('relayEdgeEntryOpen', request) as Promise<unknown>).rejects.toThrow()
    expect(fixture.openEdgeToolNative).not.toHaveBeenCalled()
    for (const action of ['deviceManagement', 'edgePolicy'])
      expect(await invoke('relayEdgeEntryOpen', { action })).toMatchObject({
        action,
        installed: false
      })
    expect(fixture.openEdgeToolNative).toHaveBeenCalledTimes(2)
  })
  it('blocks configuration and desktop actions while an Edge native open is pending and waits before quit', async () => {
    const proxyPlan = await localPreparation()
    let finish!: (value: unknown) => void
    fixture.openEdgeToolNative.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const report = (await invoke('relayEdgeInspect')) as { evidenceId: string }
    const opening = invoke('relayEdgeProfileOpen', { evidenceId: report.evidenceId })
    await vi.waitFor(() => expect(fixture.openEdgeToolNative).toHaveBeenCalledOnce())
    expect(invoke('relayLocalProxyState')).toMatchObject({ owned: false })
    expect(() =>
      invoke('relayLocalProxyAction', { action: 'start', evidenceId: proxyPlan.evidenceId })
    ).toThrow('请先结束')
    expect(fixture.localStart).not.toHaveBeenCalled()
    for (const channel of [
      'relayCodeApply',
      'relayRecoveryRestore',
      'relaySavePreferences',
      'relayBrowserOpen',
      'relayDesktopAction'
    ])
      await expect(async () => invoke(channel)).rejects.toThrow('Edge')
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    quit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(fixture.appQuit).not.toHaveBeenCalled()
    finish({ status: 'requested', action: 'openProfile', installed: false, warnings: [] })
    await opening
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(1))
    expect(fixture.openEdgeToolNative).toHaveBeenCalledOnce()
  })
  it('keeps desktop status inert and opens the owned host only on explicit start', async () => {
    expect(invoke('relayDesktopState')).toMatchObject({ host: 'absent', pending: false })
    expect(await invoke('relayDesktopAction', { action: 'start' })).toMatchObject({
      status: 'completed'
    })
    expect(fixture.openDesktopTransport).toHaveBeenCalledOnce()
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(() => invoke('relayDesktopState', { path: '/other' })).toThrow('不接受')
  })
  it('opens only the owned host after confirmation and blocks Code, restore and browser writes while active', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await expect(
      invoke('relayDesktopAction', { action: 'start', path: '/other' }) as Promise<unknown>
    ).rejects.toThrow('固定')
    await invoke('relayDesktopAction', { action: 'start' })
    expect(fixture.openDesktopTransport).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      {
        home: '/fake/home',
        stateRoot: '/fake/home/Library/Application Support/Relay-Preview'
      },
      expect.any(Function)
    )
    for (const channel of [
      'relayCodePrepare',
      'relayCodeApply',
      'relaySavePreferences',
      'relayRecoveryRestore',
      'relayBrowserOpen'
    ])
      await expect(async () => invoke(channel)).rejects.toThrow('桌面登录')
    expect(await invoke('relayDesktopAction', { action: 'finish' })).toMatchObject({
      state: { host: 'absent' }
    })
  })
  it('waits for the desktop close handshake before quitting and keeps the window if recovery is refused', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await invoke('relayDesktopAction', { action: 'start' })
    fixture.desktopRequest.mockResolvedValueOnce(desktopResponse(3, 'recoveryNeeded'))
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    close({ preventDefault })
    await vi.waitFor(() =>
      expect(fixture.confirmRestore).toHaveBeenCalledWith(
        fixture.window,
        expect.objectContaining({ title: '桌面登录恢复尚未完成' })
      )
    )
    expect(preventDefault).toHaveBeenCalled()
    expect(fixture.appQuit).not.toHaveBeenCalled()
    await invoke('relayDesktopAction', { action: 'restore' })
    expect(invoke('relayDesktopState')).toMatchObject({ host: 'absent', uncertain: false })
  })
  it('shares one pending desktop close across window and app quit, then exits only after acknowledgment', async () => {
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await invoke('relayDesktopAction', { action: 'start' })
    let finish!: (value: ReturnType<typeof desktopResponse>) => void
    fixture.desktopRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const close = fixture.window.on.mock.calls.find((call) => call[0] === 'close')?.[1]
    const quit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    close({ preventDefault })
    quit({ preventDefault })
    await vi.waitFor(() => expect(fixture.desktopRequest).toHaveBeenCalledWith('close'))
    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(fixture.desktopRequest.mock.calls.filter(([action]) => action === 'close')).toHaveLength(
      1
    )
    finish(desktopResponse(3, 'idle', true))
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(1))
  })
  it('reads desktop readiness only after an explicit path-free request', async () => {
    expect(fixture.desktopReadinessNative).not.toHaveBeenCalled()
    expect(await invoke('relayDesktopReadiness')).toEqual(desktopReadinessFixture())
    expect(fixture.desktopReadinessNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      {
        home: '/fake/home',
        stateRoot: '/fake/home/Library/Application Support/Relay-Preview'
      }
    )
    expect(() => invoke('relayDesktopReadiness', { home: '/other' })).toThrow('不接受')
    expect(fixture.desktopReadinessNative).toHaveBeenCalledTimes(1)
  })
  it('routes backup opening through fixed context and the guarded directory opener', async () => {
    await invoke('relayBackupDirectoryOpen', { source: 'relay' })
    const args = fixture.openBackupDirectory.mock.calls[0] as unknown as [
      unknown,
      unknown,
      (path: string) => Promise<string>
    ]
    expect(args[0]).toEqual({
      home: '/fake/home',
      stateRoot: '/fake/home/Library/Application Support/Relay-Preview'
    })
    expect(args[1]).toEqual({ source: 'relay' })
    expect(fixture.openPath).not.toHaveBeenCalled()
    await args[2]('/fixture/validated-by-directory-opener')
    expect(fixture.openPath).toHaveBeenCalledWith('/fixture/validated-by-directory-opener')
  })
  const startDedicatedFixture = async () => {
    const settings = { ...preferenceFixture().preferences, node: 'Node' }
    const plan = await localPreparation({
      route: settings.node,
      httpPort: settings.httpPort,
      socksPort: 17890
    })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: plan.evidenceId })
    const applied = appliedCodeFixture()
    fixture.applyCodeNative.mockResolvedValue({
      ...applied,
      preferenceSnapshot: { ...applied.preferenceSnapshot, preferences: settings }
    })
    return settings
  }
  it('prepares actual Code files through owned context and applies once with the cached native revision', async () => {
    await expect(invoke('relayCodePrepare', preferenceFixture().preferences)).rejects.toThrow(
      '启动本次自有HTTP代理'
    )
    const settings = await startDedicatedFixture()
    const proof = (await invoke('relayCodePrepare', settings)) as RelayCodePreparation
    expect(fixture.prepareCodeNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      settings,
      {
        home: '/fake/home',
        stateRoot: '/fake/home/Library/Application Support/Relay-Preview',
        browserExecutable: expect.stringContaining('/extra/relay/RelayBrowser')
      }
    )
    expect(await invoke('relayCodeApply', { evidenceId: proof.evidenceId })).toMatchObject({
      status: 'applied'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.applyCodeNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      settings,
      proof.revision,
      {
        home: '/fake/home',
        stateRoot: '/fake/home/Library/Application Support/Relay-Preview',
        browserExecutable: expect.stringContaining('/extra/relay/RelayBrowser')
      }
    )
  })
  it('uses only the bundled browser entry and rejects supplied paths or URLs', async () => {
    await expect(invoke('relayBrowserOpen')).rejects.toThrow('指定节点HTTP入口未就绪')
    await startDedicatedFixture()
    expect(await invoke('relayBrowserOpen')).toMatchObject({ status: 'requested' })
    expect(fixture.openRelayBrowser).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayBrowser')
    )
    await expect(invoke('relayBrowserOpen', { url: 'http://injected' })).rejects.toThrow(
      '不接受路径'
    )
    expect(fixture.openRelayBrowser).toHaveBeenCalledTimes(1)
  })
  it('waits for a pending Code transaction and blocks competing restore, save and launch actions', async () => {
    const settings = await startDedicatedFixture()
    let finish!: (answer: ReturnType<typeof appliedCodeFixture>) => void
    fixture.applyCodeNative.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    const proof = (await invoke('relayCodePrepare', settings)) as RelayCodePreparation
    const result = invoke('relayCodeApply', { evidenceId: proof.evidenceId })
    await vi.waitFor(() => expect(fixture.applyCodeNative).toHaveBeenCalled())
    for (const channel of [
      'relayRecoveryRestore',
      'relaySavePreferences',
      'relayBrowserOpen',
      'relayBackupDirectoryOpen',
      'relayDesktopReadiness',
      'relayDesktopAction'
    ])
      await expect(async () => invoke(channel)).rejects.toThrow('尚未结束')
    const close = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const preventDefault = vi.fn()
    close({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(fixture.appQuit).not.toHaveBeenCalled()
    const applied = appliedCodeFixture()
    finish({
      ...applied,
      preferenceSnapshot: { ...applied.preferenceSnapshot, preferences: settings }
    })
    await expect(result).resolves.toMatchObject({ status: 'applied' })
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(1))
  })
  it('reads recovery metadata only after a request using the fixed namespace', async () => {
    expect(fixture.recoveryStatusNative).not.toHaveBeenCalled()
    expect(await invoke('relayRecoveryStatus')).toEqual(recoveryFixture())
    expect(fixture.recoveryStatusNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      { home: '/fake/home', stateRoot: '/fake/home/Library/Application Support/Relay-Preview' }
    )
    expect(() => invoke('relayRecoveryStatus', { path: '/injected' })).toThrow('不接受路径')
    expect(fixture.savePreferencesNative).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
  })
  it('preflights only a listed record with main-owned paths and no restore action', async () => {
    const selection = preflightFixture().selection
    expect(fixture.recoveryPreflightNative).not.toHaveBeenCalled()
    await expect(invoke('relayRecoveryPreflight', selection)).rejects.toThrow('先读取')
    await invoke('relayRecoveryStatus')
    expect(await invoke('relayRecoveryPreflight', selection)).toMatchObject(preflightFixture())
    expect(fixture.recoveryPreflightNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      selection,
      { home: '/fake/home', stateRoot: '/fake/home/Library/Application Support/Relay-Preview' }
    )
    await expect(
      invoke('relayRecoveryPreflight', { ...selection, context: { home: '/injected' } })
    ).rejects.toThrow()
    expect(fixture.handlers.has('relayRestore')).toBe(false)
    expect(fixture.savePreferencesNative).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
  })
  it('restores on an explicit action with the cached native revision', async () => {
    await invoke('relayRecoveryStatus')
    const proof = (await invoke(
      'relayRecoveryPreflight',
      preflightFixture().selection
    )) as RelayRecoveryInspection
    expect(await invoke('relayRecoveryRestore', { evidenceId: proof.evidenceId })).toMatchObject({
      status: 'restored'
    })
    expect(fixture.confirmRestore).not.toHaveBeenCalled()
    expect(fixture.recoveryRestoreNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      proof.selection,
      proof.revision,
      false,
      { home: '/fake/home', stateRoot: '/fake/home/Library/Application Support/Relay-Preview' }
    )
    expect(fixture.write).not.toHaveBeenCalled()
  })
  it('waits for a pending restore before closing the window or quitting', async () => {
    let finish!: (result: { status: string; warnings: string[] }) => void
    fixture.recoveryRestoreNative.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fixture.confirmRestore.mockResolvedValue({ response: 1, checkboxChecked: false })
    await invoke('relayRecoveryStatus')
    const proof = (await invoke(
      'relayRecoveryPreflight',
      preflightFixture().selection
    )) as RelayRecoveryInspection
    const result = invoke('relayRecoveryRestore', { evidenceId: proof.evidenceId })
    await vi.waitFor(() => expect(fixture.recoveryRestoreNative).toHaveBeenCalled())
    for (const channel of ['relayBackupDirectoryOpen', 'relayDesktopReadiness'])
      await expect(async () => invoke(channel)).rejects.toThrow('尚未结束')
    const beforeQuit = fixture.appOn.mock.calls.find((call) => call[0] === 'before-quit')?.[1]
    const beforeClose = fixture.window.on.mock.calls.find((call) => call[0] === 'close')?.[1]
    const preventDefault = vi.fn()
    beforeQuit({ preventDefault })
    beforeClose({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(fixture.appQuit).not.toHaveBeenCalled()
    expect(() => invoke('relayCorePrepare', { mode: 'isolated-check' })).toThrow('退出恢复')
    expect(() => invoke('relayConfigEditClear')).toThrow('退出恢复')
    expect(() => invoke('relayProfilePrepare', { name: 'late write' })).toThrow('退出恢复')
    finish({ status: 'restored', warnings: [] })
    await result
    await vi.waitFor(() => expect(fixture.appQuit).toHaveBeenCalledTimes(1))
  })
  it('reads and saves only through main-owned preference context, and rejects read-path injection', async () => {
    expect(fixture.readPreferencesNative).not.toHaveBeenCalled()
    expect(await invoke('relayReadPreferences')).toEqual(preferenceFixture())
    expect(fixture.readPreferencesNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      { home: '/fake/home', stateRoot: '/fake/home/Library/Application Support/Relay-Preview' }
    )
    expect(() => invoke('relayReadPreferences', { path: '/injected' })).toThrow('不接受路径')
    const request = {
      preferences: { httpPort: 8888, node: 'fixture-node', internalExceptions: 'git.corp' },
      revision: 'a'.repeat(64)
    }
    await invoke('relaySavePreferences', request)
    expect(fixture.savePreferencesNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      request,
      { home: '/fake/home', stateRoot: '/fake/home/Library/Application Support/Relay-Preview' }
    )
    expect(fixture.write).not.toHaveBeenCalled()
    expect(fixture.diagnoseNative).not.toHaveBeenCalled()
  })
  const startDiagnosticCore = async (): Promise<void> => {
    const original = fixture.localStart.getMockImplementation()
    if (!original) throw new Error('Missing local core fixture')
    fixture.localStart.mockImplementationOnce(async (...args: unknown[]) => {
      const child = await original(...args)
      return {
        ...child,
        read: async (endpoint: string) =>
          endpoint === 'proxies'
            ? {
                proxies: {
                  Node: { type: 'Shadowsocks' },
                  Group: { type: 'Selector', now: 'Node', all: ['Node', 'DIRECT'] }
                }
              }
            : child.read(endpoint)
      }
    })
    const prepared = await localPreparation({ route: 'Node', httpPort: 17891, socksPort: 17890 })
    await invoke('relayLocalProxyAction', { action: 'start', evidenceId: prepared.evidenceId })
  }
  it('does not diagnose automatically and routes explicit observation to only main-owned paths', async () => {
    expect(fixture.diagnoseNative).not.toHaveBeenCalled()
    await expect(
      invoke('relayDiagnose', { httpPort: 7890, node: 'fixture-node', internalExceptions: '' })
    ).rejects.toThrow('不接受参数')
    expect(fixture.diagnoseNative).not.toHaveBeenCalled()
    await startDiagnosticCore()
    const observation = (await invoke('relayDiagnose')) as RelayObservation
    expect(observation.source).toBe('relay-owned')
    expect(fixture.diagnoseNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      { httpPort: 17891, node: 'Relay 当前实例', internalExceptions: '' },
      {
        home: '/fake/home',
        clashRoot: '/fake/home/Library/Application Support/mihomo-party',
        browserProfile: '/fake/home/Library/Application Support/Relay-Preview/Private Browser',
        browserExecutable: expect.stringContaining('/extra/relay/RelayBrowser'),
        owned: {
          systemHTTPPort: 18191,
          systemSOCKSPort: null,
          codeHTTPPort: 17891,
          dedicatedSOCKSPort: 17890
        }
      }
    )
    await invoke('relayGenerate', {
      kind: 'guardPlan',
      node: 'Node',
      evidenceId: observation.evidenceId
    })
    expect(fixture.guardPlanNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      'Node',
      { Node: 'Shadowsocks', Group: 'Selector' }
    )
    await invoke('relayGenerate', { kind: 'edgeProfile' })
    expect(fixture.edgeProfileNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative')
    )
    expect(fixture.write).not.toHaveBeenCalled()
    expect(fixture.chooseSave).not.toHaveBeenCalled()
  })
  it('opens only the three fixed upstream references through an explicit main-frame request', async () => {
    expect(fixture.openExternal).not.toHaveBeenCalled()
    const handler = fixture.handlers.get('relayOpenUpstreamReference')
    expect(handler).toBeDefined()
    expect(() =>
      handler?.({ sender: fixture.window.webContents, senderFrame: {} }, 'docs')
    ).toThrow()
    for (const input of ['https://mihomo.party', 'constructor', { id: 'docs' }, undefined])
      expect(() => invoke('relayOpenUpstreamReference', input)).toThrow('参考链接')
    expect(fixture.openExternal).not.toHaveBeenCalled()
    await invoke('relayOpenUpstreamReference', 'docs')
    await invoke('relayOpenUpstreamReference', 'github')
    await invoke('relayOpenUpstreamReference', 'telegram')
    expect(fixture.openExternal.mock.calls).toEqual([
      ['https://mihomo.party'],
      ['https://github.com/mihomo-party-org/mihomo-party'],
      ['https://t.me/mihomo_party_group']
    ])
  })
  it('keeps diagnostic evidence for in-page navigation and retires it with the old document', async () => {
    await startDiagnosticCore()
    const plan = (observation: RelayObservation): unknown =>
      invoke('relayGenerate', {
        kind: 'guardPlan',
        node: 'Node',
        evidenceId: observation.evidenceId
      })
    const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      for (const [name, handler] of fixture.window.webContents.on.mock.calls)
        if (name === 'did-start-navigation') handler(details)
    }
    const observation = (await invoke('relayDiagnose')) as RelayObservation
    navigate({ isMainFrame: false, isSameDocument: false })
    navigate({ isMainFrame: true, isSameDocument: true })
    await expect(plan(observation)).resolves.toBeDefined()
    navigate({ isMainFrame: true, isSameDocument: false })
    await expect(plan(observation)).rejects.toThrow('证据缺失')
    const afterReload = (await invoke('relayDiagnose')) as RelayObservation
    for (const [name, handler] of fixture.window.webContents.on.mock.calls)
      if (name === 'render-process-gone') handler()
    await expect(plan(afterReload)).rejects.toThrow('证据缺失')
    expect(fixture.guardPlanNative).toHaveBeenCalledTimes(1)
  })
  it('routes the renderer request through IPC, native merger and a cancellable save adapter', async () => {
    const input = { httpPort: 7890, node: 'fixture', existingJSON: '{}', internalExceptions: '' }
    const result = (await invoke('relayGenerate', { kind: 'configuration', input })) as {
      artifacts: { id: string }[]
    }
    expect(fixture.previewNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      input
    )
    expect(
      await invoke('relayArtifactAction', { id: result.artifacts[1].id, action: 'copy' })
    ).toEqual({ status: 'copied' })
    expect(fixture.copy).toHaveBeenCalledWith('fixture plan')
    expect(
      await invoke('relayArtifactAction', { id: result.artifacts[1].id, action: 'save' })
    ).toEqual({ status: 'cancelled' })
    expect(fixture.write).not.toHaveBeenCalled()
    fixture.chooseSave.mockResolvedValue({ canceled: false, filePath: '/fake/user-selected.md' })
    await invoke('relayArtifactAction', { id: result.artifacts[1].id, action: 'save' })
    expect(fixture.write).toHaveBeenCalledWith('/fake/user-selected.md', 'fixture plan', {
      mode: 0o600
    })
    expect(fixture.savePreferencesNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative'),
      {
        preferences: { httpPort: 7890, node: 'fixture', internalExceptions: '' },
        revision: preferenceFixture().revision
      },
      { home: '/fake/home', stateRoot: '/fake/home/Library/Application Support/Relay-Preview' }
    )
  })
  it('reads only the fixed bundled reference and runs the fixed offline simulation entry', async () => {
    await invoke('relayGenerate', { kind: 'handoff' })
    expect(fixture.readFile).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/docs/AI-Network-Handoff.md'),
      'utf8'
    )
    await invoke('relayGenerate', { kind: 'simulation' })
    expect(fixture.simulateNative).toHaveBeenCalledWith(
      expect.stringContaining('/extra/relay/RelayNative')
    )
    expect(fixture.chooseSave).not.toHaveBeenCalled()
    expect(invoke('relayStatus')).toMatchObject({
      networkChangesAllowed: false,
      coreRunning: false,
      guardEnabled: false
    })
  })
  it('rejects subframes and unrelated web contents before reaching any adapter', async () => {
    for (const channel of [
      'relayBackupAccountList',
      'relayBackupAccountSave',
      'relayBackupAccountDisable',
      'relayBackupAccountPrepareRemote',
      'relayBackupAccountPrepareRuntime',
      'relayBackupScheduleState',
      'relayBackupScheduleArm',
      'relayBackupScheduleStop',
      'relayBackupDirectoryPrepare',
      'relayBackupDirectoryExecute',
      'relayBackupDirectoryCancel',
      'relayOverrideLibraryList',
      'relayOverrideLibraryRead',
      'relayOverrideLibraryCreate',
      'relayOverrideLibrarySaveMetadata',
      'relayOverrideLibrarySaveBody',
      'relayOverrideLibraryRemove',
      'relayOverrideLibraryFetchPrepare',
      'relayOverrideLibraryFetchExecute',
      'relayOverrideLibraryFetchCancel',
      'relayOverrideLibraryBindingsRead',
      'relayOverrideLibraryBind',
      'relayOverrideLibraryRefresh',
      'relayOverrideLibraryOrder',
      'relayRuntimeGistDiscoveryPrepare',
      'relayRuntimeGistDiscoveryExecute',
      'relayRuntimeGistDiscoveryCancel',
      'relayRuntimeGistSyncState',
      'relayRuntimeGistSyncArm',
      'relayRuntimeGistSyncStop',
      'relayBackupLegacyPrepare',
      'relayBackupRecoveryList',
      'relayBackupRecoveryPrepare',
      'relayBackupRecoveryCommit',
      'relayBackupRecoveryCancel',
      'relayResourceList',
      'relayResourcePrepare',
      'relayResourceAcquire',
      'relayResourceCheck',
      'relayResourceCancel',
      'relayResourceState',
      'relaySourceScheduleState',
      'relaySourceScheduleArm',
      'relaySourceScheduleDisarm',
      'relaySourceList',
      'relaySourceRegisterPrepare',
      'relaySourceUpdatePrepare',
      'relaySourceRestorePrepare',
      'relaySourceExecute',
      'relaySourceCancel',
      'relaySourceState',
      'relayProvidersInspect',
      'relayProviderPrepare',
      'relayProviderAcquire',
      'relayProviderBatchPrepare',
      'relayProviderBatchAcquire',
      'relayProviderSnapshotPrepare',
      'relayProviderSnapshotSave',
      'relayProviderCancel',
      'relayProviderState',
      'relaySubscriptionPrepare',
      'relaySubscriptionDownload',
      'relaySubscriptionSave',
      'relaySubscriptionCancel',
      'relaySubscriptionState',
      'relayLocalProxyState',
      'relayLocalProxyPrepare',
      'relayLocalProxyAction',
      'relayProfileRuntimePrepare',
      'relayProfileRuntimeCheck',
      'relayProfilePrepare',
      'relayProfileSave',
      'relayProfileList',
      'relayCoreState',
      'relayCorePrepare',
      'relayCoreAction',
      'relayGuardReadiness',
      'relayGenerate',
      'relayArtifactAction',
      'relayDiagnose',
      'relayReadPreferences',
      'relaySavePreferences',
      'relayRecoveryStatus',
      'relayRecoveryPreflight',
      'relayRecoveryRestore',
      'relayCodePrepare',
      'relayCodeApply',
      'relayBrowserOpen',
      'relayBackupDirectoryOpen',
      'relayDesktopReadiness',
      'relayDesktopState',
      'relayDesktopAction',
      'relayEdgeInspect',
      'relayEdgeProfileOpen',
      'relayEdgeEntryOpen'
    ]) {
      const handler = fixture.handlers.get(channel)
      if (!handler) throw new Error('handler missing')
      for (const badEvent of [
        { sender: {}, senderFrame: fixture.window.webContents.mainFrame },
        { sender: fixture.window.webContents, senderFrame: {} }
      ])
        await expect(async () => handler(badEvent, { kind: 'handoff' })).rejects.toThrow(
          'Untrusted caller'
        )
    }
    expect(fixture.readFile).not.toHaveBeenCalled()
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.chooseSave).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled()
    expect(fixture.accountCredential).not.toHaveBeenCalled()
    expect(fixture.runtimeGistRequest).not.toHaveBeenCalled()
  })

  describe('Tray network toggle integration', () => {
    const selectFixture = async () => {
      const stored = await fixture.profileRead()
      const source = profileRuntimeSource.replace(
        /^dns:.*$/mu,
        'dns: {enable: true, nameserver: [1.1.1.1], default-nameserver: [1.1.1.1]}'
      )
      stored.text = source
      stored.profile.sha256 = profileHash(source)
      fixture.profileRead.mockResolvedValue(stored)
      const selection = { id: stored.profile.id, sha256: stored.profile.sha256 }
      fixture.readCoreSelectionNative.mockResolvedValue({ revision: 'b'.repeat(64), selection })
      return selection
    }
    const toggle = async (action: RelayShellAction) => {
      const host = fixture.shellHostOptions
      if (!host) throw new Error('Missing shell host')
      return host.perform(action)
    }
    const allowApply = () => {
      const normal = fixture.systemProxyNative.getMockImplementation()
      if (!normal) throw new Error('Missing native fixture')
      fixture.systemProxyNative.mockImplementation(async (executable, context, action) => {
        const report = await normal(executable, context, action)
        return action === 'apply'
          ? {
              ...report,
              status: 'applied',
              canApply: false,
              canRestore: true,
              recordID: '00000000-0000-4000-8000-000000000038',
              revision: 'b'.repeat(64)
            }
          : report
      })
    }
    it('starts the pinned selected HTTP profile and applies system proxy in one action without an app confirmation', async () => {
      const selection = await selectFixture()
      allowApply()
      await toggle('triggerSysProxy')
      expect(invoke('relayLocalProxyState')).toMatchObject({
        owned: true,
        phase: 'running',
        profileId: selection.id,
        httpPort: 18191,
        lifetime: 'main'
      })
      expect(fixture.localStart).toHaveBeenCalledOnce()
      expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual([
        'inspect',
        'prepare',
        'prepare',
        'apply'
      ])
      expect(fixture.systemProxyNative.mock.calls[1][3]).toMatchObject({
        host: '127.0.0.1',
        port: 18191,
        serviceIDs: ['Wi-Fi']
      })
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('reuses a confirmed owned HTTP listener without restarting it', async () => {
      const plan = await localPreparation()
      await invoke('relayLocalProxyAction', { action: 'start', evidenceId: plan.evidenceId })
      allowApply()
      await toggle('triggerSysProxy')
      expect(fixture.localStart).toHaveBeenCalledOnce()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative.mock.calls.some((call) => call[2] === 'apply')).toBe(true)
    })
    it('refuses a blocked port without taking system proxy or stopping another core', async () => {
      await selectFixture()
      fixture.localPort.mockResolvedValue(false)
      await expect(toggle('triggerSysProxy')).rejects.toThrow('端口')
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual(['inspect'])
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it('does not launch an old selected profile when the selection changes during preparation', async () => {
      const selection = await selectFixture()
      fixture.coreInspect.mockImplementationOnce(async () => {
        fixture.readCoreSelectionNative.mockResolvedValue({
          revision: 'c'.repeat(64),
          selection: { ...selection, id: '00000000-0000-0000-0000-000000000002' }
        })
        return { mode: 'rule', revision: 'a'.repeat(64), lease: 'missing' }
      })
      await expect(toggle('triggerSysProxy')).rejects.toThrow()
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual(['inspect'])
      expect(fixture.localStop).not.toHaveBeenCalled()
    })
    it('cancels late system preparation after hide then show instead of accepting restored visibility', async () => {
      await selectFixture()
      allowApply()
      const normal = fixture.systemProxyNative.getMockImplementation()
      if (!normal) throw new Error('Missing native fixture')
      let release!: () => void
      fixture.systemProxyNative.mockImplementation(async (executable, context, action) => {
        if (action === 'prepare')
          await new Promise<void>((resolve) => {
            release = resolve
          })
        return normal(executable, context, action)
      })
      const action = toggle('triggerSysProxy')
      const rejected = expect(action).rejects.toThrow('本次界面授权已失效')
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      fixture.window.isVisible.mockReturnValue(false)
      fixture.window.on.mock.calls.find(([name]) => name === 'hide')?.[1]()
      fixture.window.isVisible.mockReturnValue(true)
      release()
      await rejected
      expect(fixture.systemProxyNative.mock.calls.map((call) => call[2])).toEqual([
        'inspect',
        'prepare'
      ])
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
    })
    it('reports a running HTTP owner as a TUN conflict without stopping or migrating it', async () => {
      const plan = await localPreparation()
      await invoke('relayLocalProxyAction', { action: 'start', evidenceId: plan.evidenceId })
      await expect(toggle('triggerTun')).rejects.toThrow('普通代理核心正在运行')
      expect(fixture.localStart).toHaveBeenCalledOnce()
      expect(fixture.localStop).not.toHaveBeenCalled()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.coreStop).not.toHaveBeenCalled()
    })
    it('reports an absent managed TUN helper without opening a host or applying proxy settings', async () => {
      const read = await fixture.profileRead()
      const source = JSON.stringify({ rules: ['MATCH,REJECT'] })
      const selection = { id: read.profile.id, sha256: profileHash(source) }
      fixture.profileRead.mockResolvedValue({
        ...read,
        text: source,
        profile: { ...read.profile, sha256: selection.sha256 }
      })
      fixture.readCoreSelectionNative.mockResolvedValue({ revision: 'b'.repeat(64), selection })
      await expect(toggle('triggerTun')).rejects.toThrow('尚未安装')
      expect(fixture.completeCheck).toHaveBeenCalledOnce()
      expect(fixture.tunOpen).not.toHaveBeenCalled()
      expect(fixture.tunInspect).not.toHaveBeenCalled()
      expect(fixture.localStart).not.toHaveBeenCalled()
      expect(fixture.systemProxyNative).not.toHaveBeenCalled()
      expect(fixture.confirmRestore).not.toHaveBeenCalled()
    })
  })
})
