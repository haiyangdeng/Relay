// Intentionally separate from ../index.ts. Importing the upstream entry would
// register core/system-proxy lifecycle side effects before our preview gate.
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, join } from 'path'
import { access, readFile, realpath } from 'fs/promises'
import { pathToFileURL } from 'url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  session,
  safeStorage,
  screen,
  shell
} from 'electron'
import { RELAY_UI_PREFERENCES_CHANNELS } from '../../shared/relay/ui-preferences'
import { relayUpstreamReferences } from '../../shared/relay/upstream-reference'
import { RELAY_MAINTENANCE_CHANNELS } from '../../shared/relay/maintenance'
import { RELAY_OWNED_RESET_CHANNELS } from '../../shared/relay/owned-reset'
import { sourceSelection } from '../../shared/relay/subscription-sources'
import { smartToolsRequest, type SmartToolsInspection } from '../../shared/relay/smart-tools'
import { relayUpstreamChannels } from '../../shared/relay/channels'
import type { RelayStatus } from '../../shared/relay/protocol'
import { atomicWriteFile } from '../utils/safeFile'
import { mainWindowLogger, setAppLogSizeMiB } from '../utils/logger'
import { validateCoreAction } from '../../shared/relay/core'
import {
  localProxyAction,
  relayProxyCanPrepare,
  localProxyPrepare,
  type LocalResolverMode,
  type LocalProxyGroup,
  type RelayProxyPageOwner
} from '../../shared/relay/local-proxy'
import { profileSelection, type RelayProfileSelection } from '../../shared/relay/runtime'
import { canSelectCachedGroupMember } from '../../shared/relay/profiles'
import { systemProxyInboundPort } from '../../shared/relay/system-proxy'
import {
  enabledLocalProxyPorts,
  localProxyPortsCompatible,
  localProxyPortsFor
} from '../../shared/relay/local-proxy-ports'
import { dedicatedListenersCompatible } from '../../shared/relay/dedicated-listeners'
import {
  localProxyPlan,
  RELAY_LOCAL_PROXY_PLAN_CHANNELS
} from '../../shared/relay/local-proxy-plan'
import { webdavDirectoryEvidence } from '../../shared/relay/backup-directory'
import { variantImportRequest, type VariantImportRequest } from '../../shared/relay/variant'
import { tunEvidenceRequest, tunSessionRequest, type TunStatus } from '../../shared/relay/tun'
import { tunRuleChangeRequest, tunRulesReadRequest } from '../../shared/relay/tun-rules'
import { tunResourceReadRequest, tunResourceReplaceRequest } from '../../shared/relay/tun-resources'
import {
  tunRuleProvidersReadRequest,
  tunRuleProviderReplaceRequest
} from '../../shared/relay/tun-rule-providers'
import type { RelayRuntimeGistSource } from '../../shared/relay/runtime-gist'
import { isGeoResourceKind } from '../../shared/relay/geo-origins'
import type { ResourceKind } from '../../shared/relay/resources'
import { geoScheduleArmRequest } from '../../shared/relay/geo-scheduler'
import type { RelayShellTheme } from '../../shared/relay/shell'
import { RELAY_SIMPLE_CHANNELS } from '../../shared/relay/simple'
import { RELAY_SIMPLE_SOURCE_CHANNELS } from '../../shared/relay/simple-sources'
import { RELAY_SIMPLE_CONFIGURATION_CHANNELS } from '../../shared/relay/simple-configuration'
import { RELAY_SIMPLE_PUBLICATION_CHANNELS } from '../../shared/relay/simple-publication'
import { getAppInfo as resolveConnectionAppInfo } from '../utils/app-info'
import type { SubStoreAdvancedStart } from '../../shared/relay/substore'
import { coreOwnerAction } from '../../shared/relay/core-owner'
import { createTunHandoff, type TunHandoffContext } from './tun/handoff'
import { createTunProfileSwitch } from './tun/profile-switch'
import { tunLocalPlanProjection } from './tun/local-plan-projection'
import { createOwnedDiagnosticService } from './owned-diagnostics'
import { createDiagnosticEvidenceReader } from './diagnostic-evidence'
import {
  nativeReady,
  previewNative,
  simulateNative,
  edgeProfileNative,
  diagnoseNative,
  guardPlanNative,
  readPreferencesNative,
  savePreferencesNative,
  recoveryStatusNative,
  recoveryPreflightNative,
  recoveryRestoreNative,
  prepareCodeNative,
  applyCodeNative,
  desktopReadinessNative,
  inspectEdgeNative,
  openEdgeToolNative,
  guardReadinessNative,
  guardHostResourceNative,
  coreRecordRecoveryNative,
  readCoreSelectionNative,
  saveCoreSelectionNative,
  systemProxyNative,
  backupMoveNative,
  backupPublishNative,
  backupFileNative
} from './native'
import { createGuardManagementService } from './guard/management-service'
import { createGuardNativeBridge } from './guard/native-addon'
import { createScopedCLIService } from './guard/scoped-cli-service'
import { createScopedStorageBridge } from './guard/scoped-storage-native'
import { createTerminalCLIService } from './guard/terminal-cli-service'
import { createTerminalLeaseChannel } from './guard/terminal-lease-channel'
import { createUIPreferencesService } from './ui-preferences/service'
import { SystemProxyDraftStore } from './system-proxy/draft-store'
import { LocalProxyPlanStore } from './core/local-proxy-plan-store'
import { createMaintenanceService } from './maintenance/service'
import { RelayMaintenanceStore } from './maintenance/store'
import { runOwnedResetBootstrap } from './maintenance/reset-bootstrap'
import { createOwnedResetService } from './maintenance/reset-service'
import { createOwnedResetBridge } from './maintenance/reset-native'
import { ownedResetStartup, type OwnedResetStartup } from './maintenance/reset-startup'
import { watchRendererStartup } from './shell/renderer-startup'
import { createRelayShellService } from './shell/service'
import { createShellActions } from './shell/actions'
import { createRestartCoordinator } from './shell/restart-coordinator'
import type { RestartDrainPass } from './shell/restart-intent'
import { createOnlineThemeService } from './shell/theme-service'
import { downloadOnlineThemes } from './shell/theme-download'
import { createLoginItemService } from './shell/login-item'
import { createLoginItemRegistration } from './shell/login-item-registration'
import { prepareAutomaticUninstall, startAutomaticUninstallMonitor } from './automatic-uninstall'
import { closePrivateBrowserForUninstall } from './private-browser-uninstall'
import { createTrayWorkflows } from './shell/tray-workflows'
import { RelayShellStore } from './shell/store'
import { defaultWindowStartup, readWindowStartup } from './shell/window-startup'
import { createElectronShellHost } from './shell/electron-host'
import { createWindowGeometryService, RelayWindowStateStore } from './shell/window-state'
import { createWindowGeometryHost, flushWindowGeometryForExit } from './shell/window-geometry-host'
import { createBackupService } from './backup/service'
import { writeBackupKeyFile } from './backup/key-file'
import { createRemoteBackupService } from './backup/remote-service'
import { createRuntimeGistService } from './backup/runtime-gist'
import { RelayWebdavReceiptStore } from './backup/webdav-receipts'
import {
  createRuntimeGistSyncService,
  matchesRuntimeGistSyncAccount
} from './backup/runtime-gist-sync'
import { createBackupAccountsService } from './backup/accounts-service'
import { createRuntimeGistDiscoveryService } from './backup/runtime-gist-discovery'
import { RelayBackupAccountsStore } from './backup/accounts-store'
import { createWebdavBackupScheduler, matchesWebdavBackupAccount } from './backup/webdav-scheduler'
import { createWebdavDirectoryService } from './backup/webdav-directory'
import { RelayBackupStore } from './backup/store'
import {
  prepareLegacyMigrationRecord,
  prepareLegacyRelayMigrationRecord
} from './backup/legacy-record'
import { createLegacyRelayMigration } from './backup/legacy-relay'
import { createSubStoreService } from './substore/service'
import { startSubStoreEgress } from './substore/isolated-egress'
import { startRemoteSubStore } from './substore/remote-runtime'
import { isolatedProbeConfiguration } from './network-info/probe-configuration'
import { inspectProbeNetwork } from './network-info/network-observer'
import { SubStoreResources } from './substore/resources'
import { startSubStoreRuntime } from './substore/runtime'
import { openSubStoreWindow } from './substore/window'
import { RelayPluginStore } from './plugins/store'
import { createRelayPluginService } from './plugins/service'
import { createRelayPluginScheduler } from './plugins/scheduler'
import { createRelayPluginContext } from './plugins/transport'
import { downloadDescriptor } from './plugins/descriptor-source'
import { readDescriptorFile, createDescriptorInbox } from './plugins/descriptor-file'
import { trustedUpdateCatalog } from './updates/catalog'
import { UpdateCandidateStore } from './updates/store'
import { createUpdateService } from './updates/service'
import { createAppUpdateService } from './updates/app/service'
import { AppUpdateCandidateStore } from './updates/app/store'
import { AppInstallationJournal } from './updates/app/journal'
import { MacAppUpdatePlatform } from './updates/app/macos'
import { appUpdateNetwork, appUpdateHandoff } from './updates/app/runtime'
import { registerAppUpdateIPC } from './updates/app/handlers'
import { createSubscriptionService } from './subscriptions/service'
import { downloadSubscription } from './subscriptions/transfer'
import { createProviderService } from './providers/service'
import { SubscriptionSourceStore } from './subscriptions/source-store'
import { createSubscriptionSourceService } from './subscriptions/source-service'
import { transferSubscriptionSource } from './subscriptions/source-transfer'
import { createSourceScheduler } from './subscriptions/source-scheduler'
import { ResourceStore } from './resources/store'
import { ResourceOriginStore } from './resources/origin-store'
import { createResourceOriginService } from './resources/origin-service'
import { createGeoSourceScheduler } from './resources/geo-scheduler'
import { assertGeoAutomaticPermit } from './resources/automatic-permit'
import { readGeoOriginCandidate, readDefaultGeoBinding } from './resources/origin-candidate'
import { readRuleProviderCandidate } from './resources/rule-provider-candidate'
import { createResourceService } from './resources/service'
import { readBinaryResource, downloadBinaryResource, resourceHash } from './resources/source'
import { checkResourceWithCore } from './resources/checker'
import { allowedPreviewRequest } from './navigation'
import { createPreviewBackend } from './preview'
import { createClashBackend } from './clash-backend'
import geodataCoreManifest from './core/geodata-manifest.json'
import { createArtifactService } from './artifacts'
import { relayRuntimeContext, relayDiagnosticContext } from './context'
import { createDiagnosticService } from './diagnostics'
import { createRecoveryService } from './recovery'
import { createCodeService } from './code'
import { createAiClientService } from './ai-clients/service'
import { createRuntimeInfoService } from './network-info/service'
import { createIsolatedProbes } from './network-info/probes'
import { createConnectionAppInfo } from './network-info/app-info'
import { createTrafficHistory } from './traffic/history'
import { normalizeTrayPNG } from './shell/tray-image'
import { RelayLibraryStore } from './profiles/library'
import { openRelayBrowser } from './browser'
import { createBrowserBindingChannel } from './browser-binding'
import { openBackupDirectory } from './backup-directory'
import { createDesktopService } from './desktop'
import { openDesktopTransport } from './desktop-transport'
import { createEdgeService } from './edge'
import { createGuardReadinessService } from './guard'
import { CoreStore } from './core/store'
import { createCoreService } from './core/service'
import { verifyCoreResource } from './core/resources'
import {
  inspectAuxiliaryOwnedActorsIdle,
  inspectOtherAuxiliaryOwnedActorsIdle
} from './core/probe-owners'
import { createCoreOwnerRuntime } from './core-owner/runtime'
import { startIsolatedCore } from './core/isolated-runtime'
import { ProfileStore } from './profiles/store'
import { createProfileService } from './profiles/service'
import { createSimpleDraftService } from './simple/service'
import { SimpleDraftStore } from './simple/store'
import { createPinnedSimpleCapture } from './simple/capture'
import { createPinnedSimpleBindingReader } from './simple/bindings'
import { createPinnedSimpleConfigurationReader } from './simple/configuration'
import { createSimplePublicationService } from './simple/publication-service'
import { SimplePublicationJournal } from './simple/publication-journal'
import { createSimplePublicationHandlers } from './simple/publication-handlers'
import { createSimpleHandlers, reopenSimpleWhenIdle } from './simple/handlers'
import { SimpleFailure } from './simple/model'
import { pickProfileSource } from './profiles/source'
import { convertRuleMRS } from './resources/mrs-convert'
import { createProfileRuntimeService } from './profiles/runtime-service'
import { checkProfileRuntime } from './core/profile-check'
import { createLocalProxyService } from './core/local-proxy-service'
import { createProfileStartup } from './core/profile-startup'
import { createStartupPreferences } from './core/startup-preferences'
import { applyStartupSystemProxy } from './core/startup-system-proxy'
import { startLocalProxyCore } from './core/local-proxy-runtime'
import {
  probeLocalPort,
  probeLocalUdpPort,
  ownsHttpListener,
  ownsUdpListener,
  waitForTunPlanPorts
} from './core/port'
import {
  createCompleteConfigurationService,
  CheckedConfigurationFailure
} from './configuration/service'
import { createConfigurationEditService } from './configuration/edit-service'
import { OverrideLibraryStore } from './configuration/override-library-store'
import { createOverrideLibraryService } from './configuration/override-library-service'
import { ConfigurationEditStore } from './configuration/edit-store'
import { VariantStore } from './core/variant-store'
import { createVariantService } from './core/variant-service'
import {
  captureSelectedCoreSnapshot,
  type CoreSnapshotScope
} from './configuration/core-snapshot-prototype'
import { runConfigurationScript } from './configuration/script'
import { checkCompleteConfiguration } from './configuration/checker'
import { createCoreLifecycle } from './core/lifecycle'
import { createCoreRecordRecovery } from './core/record-recovery'
import { createCoreSelectionService } from './core/selection'
import { createSystemProxyService } from './system-proxy/service'
import { startPacServer } from './system-proxy/pac'
import { verifyProxyTarget } from './system-proxy/target'
import {
  createTunSessionService,
  TunStartFailure,
  type TunSessionHost,
  type TunSessionCandidate
} from './tun/service'
import {
  inspectTunNative,
  openTunNativeHost,
  prepareTunDiagnostics,
  readTunInstallation,
  type ExecutionStageV2,
  type TunInstallation,
  type TunNativeInspection
} from './tun/transport'
import { encodeCheckedTunExecutionV2, smartStateCollectsCSV } from './tun/checked-execution'
import { SmartStateStore } from './core/smart-state-store'
import { inspectRuntimeConfiguration } from './configuration/schema'
import { plainConfigurationMap } from './profiles/document'
import { analyzeProfile } from './profiles/inspect'

const preparingAutomaticUninstall = process.argv.includes('--relay-uninstall-prepare')
app.setName('Relay')
const originalStateRoot = join(app.getPath('appData'), 'Relay-Preview')
let resetStartup: OwnedResetStartup | undefined,
  resetStartupRefused = false,
  preparationProfileReady = true
if (!preparingAutomaticUninstall) {
  try {
    resetStartup = ownedResetStartup(app.getPath('home'))
    if (resetStartup.targetRoot !== originalStateRoot)
      throw new Error('自有数据根与固定主目录不一致。')
  } catch {
    resetStartupRefused = true
  }
  app.setPath('userData', resetStartup?.profileRoot ?? originalStateRoot)
  app.setPath('sessionData', join(app.getPath('userData'), 'Chromium'))
} else {
  // Electron requires existing directories for setPath. Use only our normal
  // namespace; a never-opened App has no profile and needs no new profile here.
  try {
    app.setPath('userData', originalStateRoot)
    app.setPath('sessionData', join(originalStateRoot, 'Chromium'))
  } catch {
    preparationProfileReady = false
    app.exit(1)
  }
}
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
let startupWindowPreferences =
  !resetStartupRefused && resetStartup?.mode === 'normal'
    ? readWindowStartup(app.getPath('home'), originalStateRoot)
    : defaultWindowStartup
if (startupWindowPreferences.disableHardwareAcceleration) {
  try {
    app.disableHardwareAcceleration()
  } catch {
    startupWindowPreferences = { ...startupWindowPreferences, disableHardwareAcceleration: false }
    console.warn('Relay 未确认本次启动的图形加速切换，保留默认设置。')
  }
}

let window: BrowserWindow | null = null
const descriptorInbox = createDescriptorInbox()
let notifyOpenedDescriptor: (() => void) | undefined
if (!preparingAutomaticUninstall)
  app.on('open-file', (event, path) => {
    if (descriptorInbox.offer(path)) {
      event.preventDefault()
      notifyOpenedDescriptor?.()
    }
  })
const runtime = relayRuntimeContext({
  packaged: app.isPackaged,
  resources: process.resourcesPath,
  mainDirectory: __dirname,
  userData: originalStateRoot
})
let automaticUninstallRequested = false,
  uninstallNativeExecutable: string | undefined
const nativePath = (): string => uninstallNativeExecutable ?? runtime.nativeExecutable
const stateContext = (): { home: string; stateRoot: string } => ({
  home: app.getPath('home'),
  stateRoot: runtime.stateDirectory
})
const codeContext = (): { home: string; stateRoot: string; browserExecutable: string } => ({
  ...stateContext(),
  browserExecutable: runtime.browserExecutable
})

// A trusted command already identifies the user's chosen operation. Recheck
// its window authority here; this is not a second permission prompt.
function actionWindowAvailable(): boolean {
  return (
    !automaticUninstallRequested &&
    !!window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed()
  )
}

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('Untrusted caller')
  if (automaticUninstallRequested) throw new Error('Relay 正在自动卸载，不能开始新操作。')
}

app
  .whenReady()
  .then(async () => {
    if (preparingAutomaticUninstall) {
      if (!preparationProfileReady) return
      const prepared = await prepareAutomaticUninstall({
        platform: process.platform,
        packaged: app.isPackaged,
        uid: process.getuid?.(),
        args: process.argv.slice(1),
        disableLoginItem: () => app.setLoginItemSettings({ openAtLogin: false }),
        loginItemEnabled: () => app.getLoginItemSettings().openAtLogin
      })
      app.exit(prepared ? 0 : 1)
      return
    }
    if (resetStartupRefused) {
      dialog.showErrorBox(
        'Relay维护启动已拒绝',
        '自有维护路径归属未确认。普通工作流没有初始化，也没有移动或删除数据。请保留现场并手动退出。'
      )
      return
    }
    const loginRegistration = createLoginItemRegistration({
      platform: process.platform,
      packaged: app.isPackaged,
      home: app.getPath('home'),
      legacy: {
        read: () => app.getLoginItemSettings(),
        write: (openAtLogin) => app.setLoginItemSettings({ openAtLogin })
      }
    })
    try {
      loginRegistration.migrate()
    } catch {
      console.warn('Relay 登录项迁移未完成，已保留现有注册及恢复数据。')
    }
    const ownedResetBridge = createOwnedResetBridge({
      targetRoot: originalStateRoot,
      inspect: () => guardHostResourceNative(nativePath())
    })
    const inspectResetOwningIdle = async (): Promise<void> => {
      if (!(await inspectAuxiliaryOwnedActorsIdle(stateContext())))
        throw new Error('存在未收尾的临时核心、受限CLI或Sub-Store会话记录，不能隔离整套数据。')
      if ((await new RelayBackupStore(stateContext()).unresolved()).length)
        throw new Error('存在未确认的自有备份恢复记录，不能隔离整套数据。')
    }
    if (resetStartup?.mode === 'maintenance') {
      let bootstrapCurrent = true
      const beforeBootstrapQuit = (event: Electron.Event): void => {
        bootstrapCurrent = false
        try {
          ownedResetBridge.invalidate()
        } catch {
          /* Keep the pending journal authoritative. */
        }
        if (ownedResetBridge.isBusy()) event.preventDefault()
      }
      app.on('before-quit', beforeBootstrapQuit)
      try {
        await runOwnedResetBootstrap(
          ownedResetBridge,
          dialog,
          () => bootstrapCurrent,
          inspectResetOwningIdle
        )
      } finally {
        app.removeListener('before-quit', beforeBootstrapQuit)
      }
      return
    }
    let assertResetRuntimeIdle: () => void = () => {
        throw new Error('普通工作流尚未初始化。')
      },
      ownedResetAssertion = false
    const ownedResetService = createOwnedResetService({
      bridge: ownedResetBridge,
      inspectOwningIdle: inspectResetOwningIdle,
      assertIdle: () => assertResetRuntimeIdle()
    })
    const resetAdmission = await ownedResetService.initialize()
    if (!resetAdmission.allowActors) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Relay自有数据维护暂缓启动',
        message: '原生独占或待处理事务不允许初始化普通工作流。',
        detail:
          '可能仍有其他Relay实例，或维护计划需要在独立Bootstrap profile中处理。没有停止其他实例、退出/重启或移动数据。请保留现场并自行退出后再打开。',
        buttons: ['保留现场'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return
    }
    // Relay deliberately skips upstream initialization. Prepare its existing
    // logger here; TUN admission independently proves a fresh write before spawn.
    await prepareTunDiagnostics().catch(() => {
      console.warn('TUN诊断日志未就绪；启用前会重新核对，失败时不启动核心。')
    })
    // Block every outbound renderer request, including localhost. Loading the
    // packaged UI/assets is the sole exception; no subscription/IP probes run.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !allowedPreviewRequest(details.url, join(__dirname, '../renderer')) })
    })
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false)
    )
    session.defaultSession.setPermissionCheckHandler(() => false)
    let preferenceBackupAccess: { isBusy(): boolean; whenIdle(): Promise<void> } | undefined =
      undefined
    const preferenceWriteBarriers: { appUpdate(): boolean; ownedReset(): boolean } = {
      appUpdate: () => true,
      ownedReset: () => true
    }
    let preferenceNotifyPending = false,
      preferenceNotifyQueued = false
    const notifyUIPreferences = (): void => {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        preferenceNotifyPending = false
        return
      }
      if (!preferenceBackupAccess) {
        preferenceNotifyPending = true
        return
      }
      if (preferenceBackupAccess.isBusy()) {
        preferenceNotifyPending = true
        if (!preferenceNotifyQueued) {
          preferenceNotifyQueued = true
          void preferenceBackupAccess
            .whenIdle()
            .then(() => {
              preferenceNotifyQueued = false
              if (preferenceNotifyPending) notifyUIPreferences()
            })
            .catch(() => {
              preferenceNotifyQueued = false
            })
        }
        return
      }
      preferenceNotifyPending = false
      try {
        window.webContents.send('appConfigUpdated')
      } catch {
        /* A lost frame cannot receive metadata. */
      }
    }
    const uiPreferences = createUIPreferencesService(
      stateContext(),
      notifyUIPreferences,
      setAppLogSizeMiB
    )
    const systemProxyDraft = new SystemProxyDraftStore(stateContext())
    const localProxyPlanStore = new LocalProxyPlanStore(stateContext())
    const localPreferencesBusy = (): boolean =>
      uiPreferences.isBusy() || systemProxyDraft.isBusy() || localProxyPlanStore.isBusy()
    await uiPreferences.initialize().catch(() => {
      console.warn('本地界面偏好未确认，原文件保留；请从偏好入口重新读取。')
    })
    const reloadAppLogSize = async (): Promise<void> => {
      try {
        await uiPreferences.readAppLogSize()
      } catch {
        console.warn('应用日志大小偏好未确认，继续使用当前限制。')
      }
    }
    await reloadAppLogSize()
    let maintenance: ReturnType<typeof createMaintenanceService> | undefined = undefined
    let maintenanceAssertion = false
    const backend = createPreviewBackend({
      preferences: () => uiPreferences.state().value,
      windowPreferences: startupWindowPreferences,
      appearance: () => {
        const settings = shellWorkflow.state().settings
        return { appTheme: settings.appTheme, operationMode: settings.operationMode }
      },
      patchView: (input) => {
        if (maintenance?.isBusy()) throw new Error('本地维护尚未结束。')
        return uiPreferences.patchView(input, publicUIPreferencesContext())
      }
    })
    let profileStartup: ReturnType<typeof createProfileStartup> | undefined
    let trayWorkflows: ReturnType<typeof createTrayWorkflows> | undefined
    let isolatedProbes: ReturnType<typeof createIsolatedProbes> | undefined = undefined
    const isolatedProbePermit = Symbol('isolated-probe')
    const subStoreNetworkPermit = Symbol('substore-isolated-network')
    let subStoreNetworkBusy = false,
      subStoreNetworkEpoch = 0
    let subStoreNetworkAbort: AbortController | undefined
    let cancelSubStoreOperation: () => void = () => {}
    const invalidateSubStoreNetwork = (): void => {
      cancelSubStoreOperation()
      ++subStoreNetworkEpoch
      subStoreNetworkAbort?.abort()
    }
    let trafficHistory: ReturnType<typeof createTrafficHistory> | undefined = undefined
    let connectionAppInfo: ReturnType<typeof createConnectionAppInfo> | undefined = undefined
    let invalidateFloatingTraffic = (): void => {}
    let onlineThemes: ReturnType<typeof createOnlineThemeService> | undefined = undefined
    let restartCoordinator: ReturnType<typeof createRestartCoordinator> | undefined = undefined
    const notifyClash = (): void => {
      trayWorkflows?.invalidate()
      invalidateFloatingTraffic()
      onlineThemes?.invalidateIfOwnerChanged()
      if (!window || window.isDestroyed()) return
      for (const channel of [
        'groupsUpdated',
        'controledMihomoConfigUpdated',
        'profileConfigUpdated'
      ])
        window.webContents.send(channel)
    }
    let guardRendererEpoch = 0
    let scopedCLI: ReturnType<typeof createScopedCLIService> | undefined = undefined
    let terminalCLI: ReturnType<typeof createTerminalCLIService> | undefined = undefined
    let guardManagement: ReturnType<typeof createGuardManagementService> | undefined = undefined
    const guardReadiness = createGuardReadinessService(() => guardReadinessNative(nativePath()))
    // Shared with the P6 Main binding: Root keeps one declaration and the real
    // P6 assignment on merge. An unavailable inspector is unknown, never inactive.
    let appUpdates: ReturnType<typeof createAppUpdateService> | undefined = undefined
    let disposeAppUpdateIPC: (() => void) | undefined = undefined
    let retainedExitPending = false,
      retainedExitAssertion = false
    let retainedExitPassLive: (() => void) | undefined
    let retainedExitPass: { sessionId: string; revision: string } | undefined
    let appUpdateAssertion = false,
      appInstallReserved = false
    const appUpdateBlocks = (): boolean =>
      !appUpdateAssertion && (!!appUpdates?.isBlocking() || appInstallReserved)
    const coreOwnerBlocks = (): boolean =>
      !retainedExitAssertion &&
      (retainedExitPending ||
        ordinaryCoreOwner.isOperating() ||
        ordinaryCoreOwner.retained() ||
        (ordinaryCoreOwner.isBlocking() && !ordinaryCoreOwner.ownsLocalInstance()))
    const extendedWorkflowBlocking = (): boolean =>
      coreOwnerBlocks() ||
      appUpdateBlocks() ||
      (!maintenanceAssertion && (!!maintenance?.isBusy() || localPreferencesBusy())) ||
      (!ownedResetAssertion && ownedResetService.isBlocking())
    const extendedWorkflowBusy = (): boolean =>
      !!appUpdates?.isBusy() ||
      !!maintenance?.isBusy() ||
      localPreferencesBusy() ||
      ownedResetService.isBusy()
    const updateWorkflowsBlocking = (): boolean => updates.isBusy() || extendedWorkflowBlocking()
    const ordinaryCoreOwner = createCoreOwnerRuntime(stateContext(), nativePath)
    await ordinaryCoreOwner.refreshPresence()
    const coreStore = new CoreStore(stateContext())
    const profileStore = new ProfileStore(stateContext())
    const simpleStore = new SimpleDraftStore(stateContext())
    const simple = createSimpleDraftService({
      store: simpleStore,
      capture: createPinnedSimpleCapture(stateContext()),
      bindingReader: createPinnedSimpleBindingReader(stateContext()),
      configurationReader: createPinnedSimpleConfigurationReader(stateContext())
    })
    const invalidateSimpleRenderer = (cancelStartup = true): void => {
      if (cancelStartup) profileStartup?.cancel()
      appUpdates?.cancel()
      maintenance?.cancel()
      ownedResetService.invalidate()
      simple.clear()
      publication.clear()
      try {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send('relayBackupPreparationsInvalidated')
      } catch {
        /* The closing frame has already lost its authority. */
      }
    }
    const providerStore = new ProfileStore(stateContext(), 'ProviderResources')
    const resourceStore = new ResourceStore(stateContext())
    const smartStateStore = new SmartStateStore(stateContext())
    const resourceOrigins = new ResourceOriginStore(stateContext(), resourceStore)
    const saveProfile = async (name: string, text: string) => {
      const saved = await profileStore.save(name, text)
      notifyClash()
      return saved
    }
    const profiles = createProfileService({
      read: (selection) => profileStore.read(selection),
      readRuleResource: (selection) => resourceStore.read(selection, 2 * 1024 * 1024),
      convertRuleMRS: (job) => convertRuleMRS(coreRoot, job),
      confirmExport: async (_profile) => {
        return actionWindowAvailable()
      },
      writeExport: async (name, bytes, recheck) => {
        if (!window) return false
        const selected = await dialog.showSaveDialog(window, {
          title: '保存配置原文',
          defaultPath: name.replaceAll('/', '_').replaceAll('\\', '_'),
          filters: [{ name: 'Clash配置', extensions: ['yaml', 'yml', 'json'] }]
        })
        if (selected.canceled || !selected.filePath) return false
        await recheck()
        await atomicWriteFile(selected.filePath, bytes, { mode: 0o600 })
        return true
      },
      pick: async () => {
        if (!window) return undefined
        const answer = await dialog.showOpenDialog(window, {
          title: '选择本地 Clash 配置（仅检查）',
          properties: ['openFile'],
          filters: [{ name: 'YAML / JSON', extensions: ['yaml', 'yml', 'json'] }]
        })
        if (answer.canceled || answer.filePaths.length !== 1) return undefined
        return pickProfileSource(answer.filePaths[0])
      },
      confirm: async (_preparation, _purpose) => {
        return actionWindowAvailable()
      },
      save: saveProfile,
      list: () => profileStore.list()
    })
    const publication = createSimplePublicationService({
      store: simpleStore,
      journal: new SimplePublicationJournal(stateContext()),
      simple,
      profiles,
      readProfile: (selection) => profileStore.read(selection)
    })
    // Read-only journal classification precedes admitting writes through IPC.
    await publication.initialize()
    const coreRoot = join(nativePath(), '..', 'core')
    const geoCoreRoot = join(nativePath(), '..', 'core-geodata-v1')
    const selectedCoreRoot = (): Promise<string> => variantStore.resolveCoreRoot(coreRoot)
    const localProxyCoreRoot = async (hasGeoAssets: boolean): Promise<string> => {
      const selected = await selectedCoreRoot()
      if (!hasGeoAssets) return selected
      if (selected === coreRoot) return geoCoreRoot
      if ((await verifyCoreResource(selected)).capability !== 'local-geodata-v1')
        throw new Error('当前核心不支持固定本地地理资源，请在内核设置中使用内置核心。')
      return selected
    }
    const executionScope: CoreSnapshotScope = {
      generation: 0,
      assertLive() {
        if (quitAfterRestore || variantService.isBusy()) throw new Error('核心选择范围已失效。')
      }
    }
    const resourceCoreRoot = async (kind: ResourceKind): Promise<string> => {
      const selected = await selectedCoreRoot()
      return isGeoResourceKind(kind) ? geoCoreRoot : selected
    }
    const subscriptions = createSubscriptionService({
      download: downloadSubscription,
      save: saveProfile,
      confirmDownload: async (_preparation) => {
        return actionWindowAvailable()
      },
      confirmSave: async (_preparation) => {
        return actionWindowAvailable()
      }
    })
    const providers = createProviderService({
      read: (selection) => profileStore.read(selection),
      cache: providerStore,
      save: saveProfile,
      download: (url, port, signal, headers, limit) =>
        downloadSubscription(url, port, signal, headers, limit),
      pick: async () => {
        if (!window) return undefined
        const answer = await dialog.showOpenDialog(window, {
          title: '选择本地节点提供者资源（不读取原path）',
          properties: ['openFile'],
          filters: [{ name: 'YAML / JSON', extensions: ['yaml', 'yml', 'json'] }]
        })
        return answer.canceled || answer.filePaths.length !== 1
          ? undefined
          : pickProfileSource(answer.filePaths[0])
      },
      confirmAcquire: async (_report) => {
        return actionWindowAvailable()
      },
      confirmBatchAcquire: async (_report) => {
        return actionWindowAvailable()
      },
      confirmSnapshot: async (_report) => {
        return actionWindowAvailable()
      }
    })
    const subscriptionSourceStore = new SubscriptionSourceStore(stateContext())
    const subscriptionSources = createSubscriptionSourceService({
      store: subscriptionSourceStore,
      transfer: transferSubscriptionSource,
      profiles: profileStore,
      inheritProfileEdits: (previousId, targetId) =>
        configurationEdit.inheritProfileEdits(previousId, targetId),
      download: (url, port, signal) => downloadSubscription(url, port, signal),
      confirm: async (_report) => {
        return actionWindowAvailable()
      }
    })
    const resources = createResourceService({
      cache: resourceStore,
      download: downloadBinaryResource,
      check: async (job) => checkResourceWithCore(await resourceCoreRoot(job.descriptor.kind), job),
      convertRuleMRS: (job, assertCurrent) => convertRuleMRS(coreRoot, job, { assertCurrent }),
      pick: async () => {
        if (!window) return undefined
        const answer = await dialog.showOpenDialog(window, {
          title: '选择规则／地理资源（不读取原path）',
          properties: ['openFile'],
          filters: [
            {
              name: 'Rules / geodata',
              extensions: ['yaml', 'yml', 'txt', 'mrs', 'dat', 'mmdb', 'db', 'metadb']
            },
            { name: 'All files', extensions: ['*'] }
          ]
        })
        if (answer.canceled || answer.filePaths.length !== 1) return undefined
        const path = answer.filePaths[0],
          bytes = await readBinaryResource(path)
        return { bytes, readAgain: () => readBinaryResource(path) }
      },
      confirm: async (_report) => {
        return actionWindowAvailable()
      }
    })
    const geoOrigins = createResourceOriginService({
      origins: resourceOrigins,
      cache: resourceStore,
      download: downloadBinaryResource,
      onChanged: async (id) => {
        if (id) await geoScheduler.disarm({ id })
        else await geoScheduler.requestClose()
      },
      check: async (job, signal, live) => {
        live()
        const root = await resourceCoreRoot(job.descriptor.kind)
        live()
        if (signal?.aborted) throw new Error('资源检查已取消。')
        return checkResourceWithCore(root, job, live)
      },
      confirmSave: async (_plan) => {
        return actionWindowAvailable()
      },
      confirmFetch: async (plan) => {
        if (!actionWindowAvailable() || plan.preparation.source.kind !== 'http') return false

        return true
      }
    })
    const sourceScheduler = createSourceScheduler({
      store: subscriptionSourceStore,
      canRun: () =>
        !subStoreNetworkBusy &&
        !isolatedProbes?.isBlocking() &&
        !updateWorkflowsBlocking() &&
        !(configurationEdit.isBusy() || simple.isBusy() || publication.isBlocking()) &&
        !pluginScheduler.isBusy() &&
        !(
          remoteBackup.isBusy() ||
          runtimeGist.isBusy() ||
          runtimeGistDiscovery.isBusy() ||
          overrideLibrary.isBusy()
        ) &&
        !backupAccounts.isBusy() &&
        !webdavBackupScheduler.isBusy() &&
        !plugins.isBusy() &&
        !backupService.isBusy() &&
        !quitAfterRestore &&
        !subscriptionSources.isBusy() &&
        !subscriptions.isBusy() &&
        !providers.isBusy() &&
        !resources.isBusy() &&
        !geoOrigins.isBusy() &&
        !geoScheduler.isBusy() &&
        !edge.isBusy() &&
        !desktop.isBlocking() &&
        !code.isApplying() &&
        !recovery.isRestoring() &&
        !profiles.isBusy() &&
        !profileRuntime.isBusy() &&
        !completeConfiguration.isBusy() &&
        !coreRecordRecovery.isBusy() &&
        !tunSession.isBlocking() &&
        !systemProxy.isBusy(),
      run: (id, revision) => subscriptionSources.runScheduled(id, revision),
      requestStop: () => subscriptionSources.requestClose(),
      confirm: async (_source, _schedule) => {
        return actionWindowAvailable()
      }
    })
    const switchingContext = new AsyncLocalStorage<symbol>()
    let switchingToken: symbol | undefined
    const requireProfileSwitchIdle = (): void => {
      if (switchingToken && switchingContext.getStore() !== switchingToken)
        throw new Error('虚拟网卡正在切换配置，请稍后操作。')
    }
    const requireSubscriptionActorsFinished = (
      allowBackup = false,
      allowUpdates = false,
      allowRemote = false,
      allowRuntimeGist = false,
      allowBackupAccounts = false,
      runtimeSource?: RelayRuntimeGistSource,
      probePermit?: typeof isolatedProbePermit,
      subStorePermit?: typeof subStoreNetworkPermit
    ): void => {
      requireProfileSwitchIdle()
      if (subStoreNetworkBusy && subStorePermit !== subStoreNetworkPermit)
        throw new Error('请先结束Sub-Store独立出口。')
      if (isolatedProbes?.isBlocking() && probePermit !== isolatedProbePermit)
        throw new Error('请先取消并结束独立探测。')
      if (quitAfterRestore && !(allowBackup && backupService.isBusy()))
        throw new Error('退出恢复正在进行，不接受新的写入或准备。')
      if (
        configurationEdit.isBusy() ||
        simple.isBusy() ||
        (!maintenanceAssertion && (localPreferencesBusy() || maintenance?.isBusy()))
      )
        throw new Error('配置编辑操作尚未结束。')
      if (extendedWorkflowBlocking()) throw new Error('更新候选操作尚未结束。')
      if (!allowUpdates && updates.isBusy()) throw new Error('更新候选操作尚未结束。')
      if (plugins.isBusy() || pluginScheduler.isBusy()) throw new Error('插件操作尚未结束。')
      if (!allowRemote && remoteBackup.isBusy()) throw new Error('远程备份操作尚未结束。')
      if (!allowRuntimeGist && runtimeGist.isBusy()) throw new Error('运行配置同步尚未结束。')
      if (runtimeGistDiscovery.isBusy()) throw new Error('运行Gist候选查找尚未结束。')
      if (overrideLibrary.isBusy()) throw new Error('覆写库操作尚未结束。')
      if (!allowBackupAccounts && backupAccounts.isBusy()) throw new Error('备份账号操作尚未结束。')
      if (webdavBackupScheduler.isBusy() && !(allowBackup && backupService.isBusy()))
        throw new Error('定时备份操作尚未结束。')
      if (!allowBackup && backupService.isBusy()) throw new Error('备份或恢复操作尚未结束。')
      if (systemProxy.isBusy()) throw new Error('系统代理事务尚未结束。')
      if (tunSession.isBlocking()) {
        const tun = tunSession.state()
        if (
          runtimeSource?.kind !== 'tun-managed' ||
          tun.sessionId !== runtimeSource.sessionId ||
          tun.pending ||
          tun.phase !== 'active' ||
          !tun.owned ||
          tun.traffic !== 'forwarding'
        )
          throw new Error('本次TUN会话或恢复尚未结束。')
      }
      if (completeConfiguration.isBusy()) throw new Error('完整配置生成或检查尚未结束。')
      if (coreRecordRecovery.isBusy()) throw new Error('核心旧记录操作尚未结束。')
      if (resources.isBusy() || geoOrigins.isBusy() || geoScheduler.isBusy())
        throw new Error('资源操作尚未结束。')
      if (sourceScheduler.isBusy() || subscriptionSources.isBusy())
        throw new Error('订阅来源操作尚未结束。')
      if (providers.isBusy()) throw new Error('提供者操作尚未结束。')
      if (subscriptions.isBusy()) throw new Error('订阅操作尚未结束。')
    }
    const requireSubscriptionFinished = (
      ...args: Parameters<typeof requireSubscriptionActorsFinished>
    ): void => {
      // A quiescent unresolved marker can be included in a backup or replaced
      // by an explicitly confirmed restore. Active publication must settle.
      if (args[0] === true ? publication.isBusy() : publication.isBlocking())
        throw new Error('Simple发布尚未收尾，请先核对发布状态。')
      requireSubscriptionActorsFinished(...args)
    }
    const requireIndependentOperationIdle = (): void => {
      requireProfileSwitchIdle()
      if (tunHandoff.isBusy()) throw new Error('核心切换正在进行。')
      if (subStoreNetworkBusy) throw new Error('请先结束Sub-Store独立出口。')
      if (isolatedProbes?.isBlocking()) throw new Error('请先取消并结束独立探测。')
      if (guardManagement?.isBlocking())
        throw new Error('系统过滤管理尚未收尾，请先读取并处理状态。')
      if (quitAfterRestore) throw new Error('退出恢复正在进行。')
      if (
        configurationEdit.isBusy() ||
        simple.isBusy() ||
        publication.isBlocking() ||
        updateWorkflowsBlocking() ||
        appUpdateBlocks() ||
        (!maintenanceAssertion && (!!maintenance?.isBusy() || localPreferencesBusy())) ||
        (!ownedResetAssertion && ownedResetService.isBlocking()) ||
        plugins.isBusy() ||
        pluginScheduler.isBusy() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy() ||
        runtimeGistDiscovery.isBusy() ||
        overrideLibrary.isBusy() ||
        backupAccounts.isBusy() ||
        webdavBackupScheduler.isBusy()
      )
        throw new Error('请先结束配置编辑、覆写库、插件、更新、运行Gist候选查找或远程备份操作。')
      if (geoOrigins.isBusy() || geoScheduler.isBusy())
        throw new Error('地理资源来源操作尚未结束。')
    }
    const profileRuntime = createProfileRuntimeService({
      read: (selection) => profileStore.read(selection),
      check: async (source) => checkProfileRuntime(await selectedCoreRoot(), source)
    })
    const completeConfiguration = createCompleteConfigurationService({
      profiles: profileStore,
      providers: providerStore,
      resources: resourceStore,
      defaultGeoResource: (kind) => readDefaultGeoBinding(resourceOrigins, resourceStore, kind),
      script: (script, configuration, signal) =>
        runConfigurationScript(nativePath(), script, configuration, signal),
      captureExecution: async (source, assets, signal, expiresAt) => {
        let defaultRoot = coreRoot
        if (!(await variantStore.list()).activeCoreId) {
          const configuration = inspectRuntimeConfiguration(source).configuration
          if (
            !configuration ||
            !plainConfigurationMap(configuration.tun) ||
            configuration.tun.enable !== true
          )
            return undefined
          const installed = await readTunInstallation('core-managed')
          if (!installed?.executionCore) return undefined
          if (
            installed.executionCore.profile === 'local-geodata-v1' ||
            assets.some((asset) =>
              ['GeoSite.dat', 'GeoIP.dat', 'Country.mmdb', 'ASN.mmdb'].includes(asset.path)
            )
          )
            defaultRoot = geoCoreRoot
        }
        return captureSelectedCoreSnapshot({
          store: variantStore,
          defaultRoot,
          configuration: source,
          resources: assets,
          scope: executionScope,
          signal,
          expiresAt
        })
      },
      check: async (source, assets, signal, execution) => {
        if (execution)
          return checkCompleteConfiguration(
            await execution.parserRoot(),
            source,
            assets,
            signal,
            execution
          )
        const selected = await selectedCoreRoot(),
          hasGeo = assets.some((asset) =>
            ['GeoSite.dat', 'GeoIP.dat', 'Country.mmdb', 'ASN.mmdb'].includes(asset.path)
          )
        let parserRoot = selected === coreRoot && hasGeo ? geoCoreRoot : selected
        if (selected === coreRoot && !hasGeo) {
          const configuration: unknown = JSON.parse(source)
          if (
            plainConfigurationMap(configuration) &&
            plainConfigurationMap(configuration.tun) &&
            configuration.tun.enable === true
          ) {
            // Even a candidate without Geo files must be checked by the fixed
            // Core that the positively verified managed installation will use.
            const installed = await readTunInstallation('core-managed'),
              architecture = process.arch
            if (
              (architecture === 'arm64' || architecture === 'x64') &&
              installed?.coreSHA256 === geodataCoreManifest.assets[architecture].sha256
            )
              parserRoot = geoCoreRoot
          }
        }
        return checkCompleteConfiguration(parserRoot, source, assets, signal)
      }
    })
    const overrideLibraryStore = new OverrideLibraryStore(stateContext())
    const configurationEditStore = new ConfigurationEditStore(stateContext())
    const configurationEdit = createConfigurationEditService({
      store: configurationEditStore,
      profiles: profileStore,
      runtimeResources: resourceStore,
      defaultGeoResource: (kind) => readDefaultGeoBinding(resourceOrigins, resourceStore, kind),
      assertLibraryBindings: (refs) => overrideLibraryStore.assertBindings(refs),
      script: (script, configuration) =>
        runConfigurationScript(nativePath(), script, configuration),
      prepare: (request, recheck, enableTun, transform) => {
        if (quitAfterRestore) throw new Error('退出恢复正在进行。')
        return completeConfiguration.prepare(request, recheck, enableTun, transform)
      }
    })
    const overrideLibrary = createOverrideLibraryService({
      store: overrideLibraryStore,
      editor: configurationEdit,
      profiles: profileStore,
      assertIdle: () => {
        if (!canRunWebdavBackup(false, false, false, true) || webdavBackupScheduler.isBusy())
          throw new Error('请先结束正在处理的数据、核心转换或备份操作，再管理覆写库。')
      },
      confirmFetch: async (_plan) => {
        return actionWindowAvailable()
      }
    })
    const variantStore = new VariantStore(stateContext())
    const requireVariantCoreIdle = (): void => {
      if (
        core.isBlocking() ||
        localProxy.isBlocking() ||
        profileRuntime.isBusy() ||
        profiles.isBusy() ||
        clashBackend.isBusy()
      )
        throw new Error('请先结束本次核心运行或配置操作，再更改变体。')
    }
    const confirmVariantAcquire = async (_request: VariantImportRequest): Promise<boolean> => {
      return actionWindowAvailable()
    }
    const variantService = createVariantService({
      store: variantStore,
      selectionChanged: () => {
        ++executionScope.generation
        completeConfiguration.clear()
      },
      ensureIdle: () => {
        requireCompleteIdle(true)
        requireVariantCoreIdle()
      },
      confirmAcquire: confirmVariantAcquire,
      confirmSelect: async (_record) => {
        return actionWindowAvailable()
      },
      confirmRemove: async (_record) => {
        return actionWindowAvailable()
      }
    })
    const core = createCoreService({
      inspect: () => coreStore.inspect(),
      resources: async () => verifyCoreResource(await selectedCoreRoot()),
      acquire: (mode, revision) => coreStore.acquire(mode, revision),
      start: async (mode, registerCleanup) =>
        startIsolatedCore(await selectedCoreRoot(), mode, registerCleanup),
      confirm: async (_preparation) => {
        return actionWindowAvailable()
      }
    })
    const startupPreferences = createStartupPreferences(stateContext())
    const pendingProxyChoices = new Set<Promise<unknown>>()
    const trackProxyChoice = <T>(operation: Promise<T>): Promise<T> => {
      pendingProxyChoices.add(operation)
      return operation.finally(() => pendingProxyChoices.delete(operation))
    }
    const localProxy = createLocalProxyService({
      rememberSelector: startupPreferences.select,
      readSelectors: startupPreferences.selectors,
      beforeRuntimeMutation: async () => {
        await guardManagement?.beforeRuntimeMutation()
        await scopedCLI?.beforeRuntimeMutation()
      },
      onRuntimeChanging: () => {
        invalidateSubStoreNetwork()
        isolatedProbes?.invalidate()
        connectionAppInfo?.invalidate()
        trafficHistory?.invalidate()
        onlineThemes?.cancel()
        invalidateFloatingTraffic()
      },
      onRuntimeChanged: () => {
        runtimeGistSync.changed()
        onlineThemes?.invalidateIfOwnerChanged()
      },
      read: (selection, resolverMode) =>
        configurationEdit.readRuntimeProfile(selection, resolverMode),
      resolvePinnedNode: async (stored, plan) => {
        await preserveDedicatedPin(coreOwnerIntent(false, false))
        return localProxyPlanStore.resolvePinnedNode(plan, stored.profile.id, () => {
          const source = analyzeProfile(stored.text).data
          return Array.isArray(source?.proxies)
            ? source.proxies.find((node) => plainConfigurationMap(node) && node.name === plan.route)
            : undefined
        })
      },
      inspect: () => coreStore.inspect(),
      resources: async (lifetime, runtimeAssets) =>
        lifetime === 'persistent'
          ? ordinaryCoreOwner.resources()
          : verifyCoreResource(await localProxyCoreRoot(!!runtimeAssets?.length)),
      portAvailable: probeLocalPort,
      portAvailableUDP: probeLocalUdpPort,
      ownsUDPListener: ownsUdpListener,
      acquire: (context, revision, lifetime) =>
        lifetime === 'persistent'
          ? ordinaryCoreOwner.acquire(context, revision)
          : coreStore.acquire('rule', revision, context),
      start: async (
        source,
        port,
        register,
        resolverMode,
        dedicated,
        owner,
        lifetime,
        logLevel,
        runtimeAssets,
        ports,
        pinnedNode,
        selectors
      ) =>
        lifetime === 'persistent'
          ? ordinaryCoreOwner.start(
              source,
              port,
              register,
              (() => {
                const page = coreOwnerIntent(false, !tunHandoff.isBusy())
                return () => {
                  owner.assertLive()
                  page()
                }
              })(),
              selectors
            )
          : startLocalProxyCore(
              await localProxyCoreRoot(!!runtimeAssets?.length),
              source,
              port,
              register,
              resolverMode,
              dedicated,
              Object.freeze({
                profileUUID: owner.profileUUID,
                store: smartStateStore,
                assertOwner: owner.assertLive,
                mayPersist: owner.mayPersist
              }),
              logLevel,
              runtimeAssets,
              ports,
              pinnedNode,
              selectors
            ),
      confirmStart: async (_preparation, assertContext) => {
        const owner = window,
          live = assertContext ?? coreOwnerIntent(false, !tunHandoff.isBusy())
        if (!owner) return false
        live()
        return true
      },
      confirmTest: async (_group, _member, _origin) => {
        return actionWindowAvailable()
      },
      confirmReload: async (_preparation) => {
        return actionWindowAvailable()
      },
      confirmMode: async (_previous, _next) => {
        return (
          (tunHandoff.isBusy() && !quitAfterRestore && !shellQuitting) || actionWindowAvailable()
        )
      },
      confirmRule: async (_report) => {
        return actionWindowAvailable()
      },
      confirmStop: async (_state, _reason) => {
        return automaticUninstallRequested || actionWindowAvailable()
      }
    })
    const guardBridge = createGuardNativeBridge({
      inspect: () => guardHostResourceNative(nativePath())
    })
    guardManagement = createGuardManagementService({
      bridge: guardBridge,
      additionalActivity: () =>
        scopedCLI?.isBlocking() === true || terminalCLI?.isBlocking() === true,
      capture: (signal) => localProxy.captureRuntime(signal),
      owned: () => ({ instanceId: localProxy.state().instanceId, pid: localProxy.state().pid }),
      assertIdle: () => {
        requireCompleteIdle(false, false, false, false, false, false, undefined, true)
        if (localProxy.state().pending || tunSession.isBlocking() || core.isBlocking())
          throw new Error('请先结束核心或 TUN 操作。')
      },
      notify: () => {
        if (window && !window.isDestroyed()) window.webContents.send('relayGuardManagementUpdated')
      }
    })
    const confirmScopedCLI = async (): Promise<boolean> => {
      const owner = window,
        epoch = guardRendererEpoch,
        frame = owner?.webContents.mainFrame
      const current = (): boolean => {
        try {
          return (
            !!owner &&
            !!frame &&
            owner === window &&
            !owner.isDestroyed() &&
            !owner.webContents.isDestroyed() &&
            owner.isVisible() &&
            owner.webContents.mainFrame === frame &&
            epoch === guardRendererEpoch
          )
        } catch {
          return false
        }
      }
      if (!owner || !current()) return false

      return current()
    }
    const scopedStorage = createScopedStorageBridge({
      inspect: () => guardHostResourceNative(nativePath())
    })
    scopedCLI = createScopedCLIService({
      context: stateContext(),
      resourceRoot: dirname(nativePath()),
      bridge: guardBridge,
      storage: scopedStorage,
      assertStorageIdle: () => {
        requireCompleteIdle(false, false, false, false, false, false, undefined, true)
        if (
          localProxy.state().pending ||
          core.state().pending ||
          guardManagement?.state().pending ||
          terminalCLI?.isBlocking() ||
          guardBridge.pending()
        )
          throw new Error('请先结束核心或系统过滤事务，再处理私有磁盘。')
      },
      capture: (signal) => localProxy.captureRuntime(signal),
      owned: () => ({ instanceId: localProxy.state().instanceId, pid: localProxy.state().pid }),
      assertIdle: () => {
        requireCompleteIdle(false, false, false, false, false, false, undefined, true)
        if (localProxy.state().pending || tunSession.isBlocking() || guardManagement?.isBlocking())
          throw new Error('请先结束核心、系统过滤或受限 CLI 操作。')
      },
      confirmStart: async () => {
        return confirmScopedCLI()
      },
      confirmStop: async () => {
        return automaticUninstallRequested || confirmScopedCLI()
      }
    })
    terminalCLI = createTerminalCLIService({
      channel: createTerminalLeaseChannel(
        app.isPackaged,
        dirname(nativePath()),
        guardBridge.terminalLease
      ),
      bridge: guardBridge,
      capture: (signal) => localProxy.captureRuntime(signal),
      owned: () => ({ instanceId: localProxy.state().instanceId, pid: localProxy.state().pid }),
      assertIdle: () => {
        requireCompleteIdle()
        if (
          shellQuitting ||
          localProxy.state().pending ||
          tunSession.isBlocking() ||
          core.isBlocking()
        )
          throw new Error('请先结束退出、核心或 TUN 操作。')
      }
    })
    let tunCandidate: TunSessionCandidate | undefined,
      tunExecution: ExecutionStageV2 | undefined,
      tunInstallation: TunInstallation | undefined,
      tunObservation: TunNativeInspection | undefined,
      tunHost: TunSessionHost | undefined
    let trayTunSessionId: string | undefined
    const notifyTun = (): void => {
      const state = tunSession.state()
      const sessionId = state.owned && state.phase === 'active' ? state.sessionId : undefined
      if (sessionId !== trayTunSessionId) {
        trayTunSessionId = sessionId
        trayWorkflows?.invalidate()
      }
      if (window && !window.isDestroyed()) window.webContents.send('relayTunUpdated')
    }
    const tunSession = createTunSessionService({
      execution: 'core-managed',
      onRuntimeChanging: () => {
        invalidateSubStoreNetwork()
        isolatedProbes?.invalidate()
        invalidateFloatingTraffic()
        trafficHistory?.invalidate()
      },
      onRuntimeChanged: () => {
        runtimeGistSync.changed()
        void geoScheduler.invalidateOwners().catch(() => {})
      },
      readCandidate: async (request) => {
        const candidate = tunCandidate
        tunCandidate = undefined
        if (
          !candidate ||
          candidate.evidence.parser.configurationSHA256 !== request.configurationSHA256
        )
          throw new Error('请重新执行完整配置检查，再准备TUN。')
        const parsed = inspectRuntimeConfiguration(candidate.evidence.configuration).configuration
        if (!parsed || !plainConfigurationMap(parsed.tun)) throw new Error('TUN候选无效。')
        return candidate
      },
      openHost: async (runtime, binding, launch, register) => {
        if (!tunInstallation || !tunObservation) throw new Error('TUN安装或网络证据已失效。')
        const execution = tunExecution
        tunExecution = undefined
        const host = await openTunNativeHost(
          tunInstallation,
          tunObservation.baseline,
          runtime,
          binding,
          launch,
          (owned) => {
            tunHost = owned
            register(owned)
          },
          () => {
            tunSession.invalidatePending()
            notifyTun()
          },
          { execution }
        )
        // Either successful terminal operation retires this native host.
        // A denied close must retain it for an explicit recovery attempt.
        for (const operation of ['dispose', 'disposeReleased'] as const) {
          const dispose = host[operation]?.bind(host)
          if (dispose)
            host[operation] = async () => {
              await dispose()
              if (tunHost === host) tunHost = undefined
            }
        }
        return host
      },
      confirmStart: async (_preparation) => {
        return actionWindowAvailable()
      },
      readResourceCandidate: (selection) =>
        readGeoOriginCandidate(resourceOrigins, resourceStore, selection),
      confirmResource: async (_report) => {
        return actionWindowAvailable()
      },
      readRuleProviderCandidate: (selection, expected) =>
        readRuleProviderCandidate(resourceStore, selection, expected),
      confirmRuleProvider: async (_report) => {
        return actionWindowAvailable()
      },
      confirmRule: async (_report) => {
        return actionWindowAvailable()
      },
      confirmStop: async (_state, _reason) => {
        return automaticUninstallRequested || actionWindowAvailable()
      },
      notify: notifyTun
    })
    const assertTunLocalReady = (): void => {
      const local = localProxy.state()
      if (
        local.pending ||
        local.uncertain ||
        (local.owned
          ? local.phase !== 'running' || local.traffic !== 'listening' || !local.instanceId
          : local.hasRecord || local.traffic !== 'inactive')
      )
        throw new Error('普通代理状态需要核对，不能切换虚拟网卡。')
    }
    const requireSystemProxyIdle = (): void => {
      const state = tunSession.state()
      requireCompleteIdle(
        false,
        false,
        false,
        false,
        false,
        false,
        state.owned && state.phase === 'active' && state.sessionId
          ? { kind: 'tun-managed', sessionId: state.sessionId }
          : undefined
      )
    }
    const tunConfigurationHandoffs = new Map<string, TunHandoffContext>()
    const tunHandoff = createTunHandoff({
      state: () => tunSession.state(),
      localOwned: () => localProxy.state().owned,
      notify: notifyTun,
      systemProxyNeeded: (ports) => systemProxy.needsCoreForHandoff(ports),
      readSelections: () => tunSession.proxySelections(),
      start: (input) => tunSession.start(input),
      stop: (input) => tunSession.stop(input)
    })
    const prepareTunConfiguration = async (raw: unknown, firstClick = false) => {
      const selection = profileSelection(raw),
        current = coreOwnerIntent()
      await profileStartup?.cancelAndWait()
      await waitForProfileInventory(current)
      requireCompleteIdle()
      assertTunLocalReady()
      if (firstClick && !(await coreSelection.read())) {
        const first = (await listVisibleProfiles(current)).profiles[0]
        if (first?.id !== selection.id || first.sha256 !== selection.sha256)
          throw new Error('首份订阅已变化，请核对当前配置。')
        await preserveDedicatedPin(current)
        await waitForProfileInventory(current)
        const eligible = () => {
          current()
          requireCompleteIdle()
          assertTunLocalReady()
          const local = localProxy.state()
          if (local.owned && local.profileId !== selection.id)
            throw new Error('普通代理所用配置已变化。')
        }
        await coreSelection.remember(selection, eligible)
        current()
        notifyClash()
      }
      const initial = localProxy.state()
      if (initial.owned && initial.instanceId) {
        const refreshed = await localProxy.action({
          action: 'refresh',
          instanceId: initial.instanceId
        })
        if (refreshed.status !== 'refreshed') throw new Error('普通代理运行状态读取未确认。')
      }
      assertTunLocalReady()
      const local = localProxy.state(),
        saved = await localProxyPlanStore.read(current)
      current()
      const savedSelectors = local.owned
        ? undefined
        : await startupPreferences.selectors(selection.id)
      const selections: LocalProxyGroup[] = structuredClone(local.groups)
      const globalSelection = async (): Promise<LocalProxyGroup | undefined> => {
        if (!local.owned) return undefined
        const live = await localProxy.inspectLive()
        const proxies =
          live && plainConfigurationMap(live.proxies.proxies) ? live.proxies.proxies : undefined
        const global = proxies?.GLOBAL
        if (
          live?.instanceId !== local.instanceId ||
          !plainConfigurationMap(global) ||
          global.type !== 'Selector' ||
          typeof global.now !== 'string' ||
          !Array.isArray(global.all) ||
          !global.all.every((item): item is string => typeof item === 'string') ||
          !global.all.includes(global.now)
        )
          throw new Error('全局节点选择读取未确认，保持当前普通代理。')
        return {
          name: 'GLOBAL',
          type: 'select',
          now: global.now,
          members: global.all,
          confirmed: true,
          selectable: true
        }
      }
      const global = await globalSelection()
      if (global && !selections.some((group) => group.name === 'GLOBAL')) selections.push(global)
      if (local.owned && local.profileId !== selection.id)
        throw new Error('运行配置与所选配置不同，请先核对当前核心。')
      // Follow the listeners actually serving the user's connections, not an
      // unapplied port draft saved while that core was running.
      const plan = local.owned
        ? localProxyPlan({
            httpPort: local.httpPort,
            resolverMode: local.resolution?.mode ?? saved.document.resolverMode,
            ...(local.ports ? { ports: local.ports } : {}),
            ...(local.dedicated
              ? {
                  dedicated: {
                    route: local.dedicated.route,
                    ...(local.dedicated.httpPort === undefined
                      ? {}
                      : { httpPort: local.dedicated.httpPort }),
                    ...(local.dedicated.socksPort === undefined
                      ? {}
                      : { socksPort: local.dedicated.socksPort })
                  }
                }
              : {})
          })
        : saved.document
      const fixedGroups = selections.flatMap((group) => {
        if (group.type === 'select' || !group.fixed) return []
        if (!group.confirmed || !group.selectable || !group.members.includes(group.fixed))
          throw new Error('普通代理组的固定节点尚未确认。')
        return [{ name: group.name, member: group.fixed }]
      })
      const stored = await profileStore.read(selection)
      const pin = plan.dedicated
        ? await localProxyPlanStore.resolvePinnedNode(plan.dedicated, selection.id, () => {
            const source = analyzeProfile(stored.text).data
            return Array.isArray(source?.proxies)
              ? source.proxies.find(
                  (node) => plainConfigurationMap(node) && node.name === plan.dedicated?.route
                )
              : undefined
          })
        : undefined
      const recheck = async (): Promise<void> => {
        current()
        if (savedSelectors) {
          const latest = await startupPreferences.selectors(selection.id)
          if (
            savedSelectors.size !== latest.size ||
            [...savedSelectors].some(([group, member]) => latest.get(group) !== member)
          )
            throw new Error('准备期间节点选择已变化，请重新开启虚拟网卡。')
        }
        if (localProxy.state().owned) {
          const freshGlobal = await globalSelection()
          if (
            global &&
            (freshGlobal?.now !== global.now ||
              JSON.stringify(freshGlobal?.members) !== JSON.stringify(global.members))
          )
            throw new Error('全局节点选择已变化，请重新切换。')
        }
        const selected = await coreSelection.read()
        if (
          selected?.id !== selection.id ||
          selected.sha256 !== selection.sha256 ||
          (await localProxyPlanStore.read(current)).revision !== saved.revision
        )
          throw new Error('配置或启动设置已变化，请重新切换。')
        current()
      }
      let resumeCurrent = coreOwnerIntent(false, false)
      const resumeEdits = await configurationEditStore.read()
      const recheckResume = async (): Promise<void> => {
        await waitForProfileInventory(resumeCurrent)
        const selected = await coreSelection.read()
        const edits = await configurationEditStore.read()
        const latestPlan = await localProxyPlanStore.read(resumeCurrent)
        if (
          selected?.id !== selection.id ||
          selected.sha256 !== selection.sha256 ||
          edits.revision !== resumeEdits.revision ||
          edits.exists !== resumeEdits.exists ||
          latestPlan.revision !== saved.revision
        )
          throw new Error('恢复普通代理所需的配置已变化，请核对当前所选配置。')
        resumeCurrent()
      }
      const ordinaryPorts = localProxyPortsFor(plan.httpPort, plan.ports)
      const tcpPorts = [
        ...enabledLocalProxyPorts(ordinaryPorts),
        ...[plan.dedicated?.httpPort, plan.dedicated?.socksPort].filter((p): p is number => !!p)
      ]
      const proxyPorts = tcpPorts.filter((port) => port !== ordinaryPorts.redir)
      let resumedInstance: { id: string; revision?: string } | undefined
      const resumedOwner = () => {
        resumeCurrent()
        const live = localProxy.state()
        if (
          !resumedInstance ||
          live.instanceId !== resumedInstance.id ||
          live.configurationRevision !== resumedInstance.revision ||
          live.profileId !== selection.id ||
          !live.pid ||
          !live.owned ||
          live.pending ||
          live.uncertain ||
          live.phase !== 'running' ||
          live.traffic !== 'listening' ||
          tunSession.state().owned ||
          !live.ports ||
          !localProxyPortsCompatible(live.ports, ordinaryPorts) ||
          !dedicatedListenersCompatible(live.dedicated, plan.dedicated)
        )
          throw new Error('普通代理实例或监听设置已变化，请重新核对。')
        return { id: resumedInstance.id, pid: live.pid, state: live }
      }
      const context: TunHandoffContext = {
        fixedGroups,
        proxyPorts,
        mixedPort: plan.ports?.mixed,
        httpPort: plan.httpPort,
        instanceId: local.owned ? local.instanceId : undefined,
        recheck,
        recheckResume,
        authorizeStop: () => {
          resumeCurrent = coreOwnerIntent(false, false)
        },
        authorized: () => {
          try {
            resumeCurrent()
            return true
          } catch {
            return false
          }
        },
        assertCurrentOwner: () => {
          assertTunLocalReady()
          const now = localProxy.state()
          if (
            now.owned !== local.owned ||
            now.instanceId !== local.instanceId ||
            now.configurationRevision !== local.configurationRevision ||
            now.mode !== local.mode ||
            JSON.stringify(
              now.groups
                .filter((group) => group.selectable)
                .map((group) => [
                  group.name,
                  group.type === 'select' ? group.now : undefined,
                  group.fixed
                ])
            ) !==
              JSON.stringify(
                local.groups
                  .filter((group) => group.selectable)
                  .map((group) => [
                    group.name,
                    group.type === 'select' ? group.now : undefined,
                    group.fixed
                  ])
              )
          )
            throw new Error('本次普通核心已变化，请重新切换。')
        },
        stopLocal: async () => {
          if (!local.instanceId) return true
          const stopped = await localProxy.action({ action: 'stop', instanceId: local.instanceId })
          return (
            stopped.status === 'stopped' &&
            !localProxy.state().owned &&
            !localProxy.state().uncertain
          )
        },
        resumeLocal: async (choices) => {
          const assertResumeOwner = (): void => {
            resumeCurrent()
            const state = localProxy.state()
            if (state.owned || state.pending || state.uncertain || tunSession.state().owned)
              throw new Error('核心恢复条件未确认，保留现场。')
          }
          if (!resumedInstance) {
            assertResumeOwner()
            if (!(await waitForTunPlanPorts(plan, assertResumeOwner)))
              throw new Error('原监听端口尚未释放，不能恢复普通代理。')
            await recheckResume()
            assertResumeOwner()
            const prepared = await localProxy.prepare({
              profile: selection,
              ...plan,
              lifetime: local.lifetime ?? 'main',
              ...(local.logLevel ? { logLevel: local.logLevel } : {})
            })
            await recheckResume()
            assertResumeOwner()
            if (!prepared.canStart) throw new Error('普通代理恢复准备未通过，请核对内核状态。')
            const result = await localProxy.action(
              { action: 'start', evidenceId: prepared.evidenceId },
              resumeCurrent
            )
            if (result.status !== 'started' || !result.state.instanceId)
              throw new Error('普通代理恢复未确认，请核对内核状态。')
            resumedInstance = {
              id: result.state.instanceId,
              revision: result.state.configurationRevision
            }
          }
          const resumed = resumedOwner()
          if (local.mode && resumed.state.mode !== local.mode) {
            const mode = await localProxy.action({
              action: 'mode',
              instanceId: resumed.id,
              mode: local.mode
            })
            if (!['modeChanged', 'refreshed'].includes(mode.status))
              throw new Error('普通代理已启动，但出站模式恢复未确认。')
          }
          // Live selections from TUN take precedence over the previous ordinary core.
          const members = new Map<string, string | null>()
          for (const group of selections) {
            const member = group.type === 'select' ? group.now : group.fixed
            if (member && group.selectable && group.confirmed) members.set(group.name, member)
          }
          for (const choice of choices ?? []) members.set(choice.name, choice.now)
          for (const [group, member] of members) {
            const now = resumedOwner().state.groups.find((g) => g.name === group)
            if (
              now?.confirmed &&
              (now.type === 'select' ? now.now : (now.fixed ?? null)) === member
            )
              continue
            const selected = await localProxy.action(
              member === null
                ? { action: 'automatic', instanceId: resumed.id, group }
                : { action: 'select', instanceId: resumed.id, group, member }
            )
            if (selected.status !== (member === null ? 'automatic' : 'selected'))
              throw new Error('普通代理已启动，但节点选择恢复未确认。')
          }
          await recheckResume()
          const { pid } = resumedOwner()
          const udp = [ordinaryPorts.socks, ordinaryPorts.mixed].filter(Boolean)
          const ownership = await Promise.all([
            ...tcpPorts.map((port) => ownsHttpListener(pid, port)),
            ...udp.map((port) => ownsUdpListener(pid, port))
          ])
          if (!ownership.every(Boolean)) throw new Error('普通代理端口归属未确认。')
          // A redirect listener is verified by process ownership, not by proxy-client traffic.
          await Promise.all(
            proxyPorts.map((port) => verifyProxyTarget({ host: '127.0.0.1', port }))
          )
          resumedOwner()
          notifyClash()
        }
      }
      await recheck()
      const prepared = await configurationEdit.prepareForTun(selection, {
        transform: (configuration) => ({
          ...tunLocalPlanProjection(configuration, plan, pin?.node, selections, savedSelectors),
          ...(local.mode ? { mode: local.mode } : {})
        }),
        recheck
      })
      tunConfigurationHandoffs.clear()
      tunConfigurationHandoffs.set(prepared.evidenceId, context)
      return prepared
    }
    const geoScheduler = createGeoSourceScheduler({
      origins: resourceOrigins,
      canRun: () =>
        !subStoreNetworkBusy &&
        !isolatedProbes?.isBlocking() &&
        !webdavBackupScheduler.isBusy() &&
        canRunWebdavBackup(),
      owner: async (sessionId, kind, assertUI) => {
        assertUI()
        const owner = tunSession.automaticResourceOwner(sessionId)
        if (!owner) return undefined
        const live = (): void => {
            assertUI()
            owner.assertCurrent()
          },
          observed = await tunSession.readResources({ sessionId }, live)
        live()
        if (
          observed.status !== 'snapshot' ||
          observed.snapshot.configurationRevision !== owner.configurationRevision ||
          !observed.snapshot.resources.some((row) => row.kind === kind && row.active)
        )
          return undefined
        return owner
      },
      confirm: async (_plan) => {
        return actionWindowAvailable()
      },
      run: async (record, permit, target) => {
        const live = (): void => assertGeoAutomaticPermit(permit, record.info)
        live()
        if (target.kind === 'tun') {
          const before = await tunSession.readResources({ sessionId: target.sessionId }, live)
          live()
          if (
            before.status !== 'snapshot' ||
            !before.snapshot.resources.some(
              (row) => row.kind === record.info.descriptor.kind && row.active
            )
          )
            return {
              status: before.status === 'uncertain' ? 'uncertain' : 'failed',
              warnings: ['本次活动资源范围未确认，未开始自动获取。']
            }
        }
        const fetched = await geoOrigins.fetch(
          { id: record.info.id, revision: record.info.revision },
          live,
          permit
        )
        live()
        if (fetched.status !== 'updated')
          return {
            status:
              fetched.status === 'uncertain'
                ? 'uncertain'
                : fetched.status === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
            warnings: fetched.warnings
          }
        if (target.kind === 'cache') return { status: 'updated', warnings: fetched.warnings }
        const current = await resourceOrigins.readId(record.info.id)
        live()
        const observed = await tunSession.readResources({ sessionId: target.sessionId }, live)
        live()
        if (observed.status !== 'snapshot')
          return {
            status: observed.status === 'uncertain' ? 'uncertain' : 'failed',
            warnings: ['缓存已保留，活动代际未确认。']
          }
        const changed = await tunSession.replaceResourceScheduled(
          {
            sessionId: target.sessionId,
            configurationRevision: observed.snapshot.configurationRevision,
            expectedGenerationSHA256: observed.snapshot.generationSHA256,
            origin: { id: current.info.id, revision: current.info.revision }
          },
          permit,
          live
        )
        if (changed.status === 'updated' || changed.status === 'unchanged')
          return { status: changed.status, warnings: [] }
        return {
          status:
            changed.status === 'uncertain'
              ? 'uncertain'
              : changed.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
          warnings: ['缓存已保留，本次活动资源更新未完整确认。']
        }
      },
      requestStop: async () => {
        tunSession.invalidateResources()
        await Promise.all([geoOrigins.requestClose(), tunSession.whenIdle()])
      }
    })
    const tunStatus = async (): Promise<TunStatus> => {
      try {
        const installed = await readTunInstallation('core-managed')
        if (!installed)
          return {
            session: tunSession.state(),
            ordinaryRecovery: tunHandoff.ordinaryRecovery(),
            helper: 'missing',
            warnings: [
              'Mihomo 自管 TUN 权限组件尚未安装。请按自用版说明安装与当前用户及版本匹配的组件，再重新检查。App 不会自动安装组件。'
            ]
          }
        const observed = await inspectTunNative(installed)
        const httpPort = tunHandoff.proxyPort()
        return {
          mixedPort: tunHandoff.mixedPort(),
          ...(httpPort === undefined ? {} : { httpPort }),
          session: tunSession.state(),
          ordinaryRecovery: tunHandoff.ordinaryRecovery(),
          helper:
            observed.helper.state === 'ready'
              ? 'ready'
              : observed.helper.state === 'requiresApproval'
                ? 'requiresApproval'
                : 'unconfirmed',
          warnings:
            observed.helper.state === 'ready'
              ? []
              : ['辅助程序认证／执行器尚未就绪，请核对安装与授权。']
        }
      } catch {
        return {
          session: tunSession.state(),
          ordinaryRecovery: tunHandoff.ordinaryRecovery(),
          helper: 'unconfirmed',
          warnings: ['TUN辅助程序或网络环境检查未通过；请核对本次安装候选与恢复记录。']
        }
      }
    }
    const coreRecordRecovery = createCoreRecordRecovery({
      inspect: () => coreRecordRecoveryNative(nativePath(), stateContext(), 'inspect'),
      archive: (revision) =>
        coreRecordRecoveryNative(nativePath(), stateContext(), 'archive', revision),
      held: () => core.isBlocking() || localProxy.isBlocking() || tunSession.isBlocking(),
      confirm: async (_report) => {
        return actionWindowAvailable()
      }
    })
    const coreLifecycle = createCoreLifecycle({
      invalidate: () => {
        core.invalidatePending()
        localProxy.invalidatePending()
        tunSession.invalidatePending()
        completeConfiguration.cancel()
        profileRuntime.clear()
        coreRecordRecovery.clear()
        systemProxy.clear()
      },
      pauseScheduling: async () => {
        await Promise.all([
          sourceScheduler.suspend(),
          pluginScheduler.suspend(),
          geoScheduler.suspend()
        ])
      },
      resumeScheduling: () => {
        sourceScheduler.resume()
        geoScheduler.resume()
        pluginScheduler.resume()
      },
      observeCore: () => core.observeOwned(),
      observeProxy: async () => {
        await localProxy.whenIdle()
        const state = localProxy.state()
        if (!state.owned) return 'none'
        if (state.traffic === 'inactive') return 'unexpectedExit'
        return (await localProxy.inspectLive()) ? 'running' : 'unconfirmed'
      },
      notify: notifyClash
    })
    const onSuspend = (): void => {
      invalidateSubStoreNetwork()
      isolatedProbes?.invalidate()
      trafficHistory?.invalidate()
      void coreLifecycle.suspend()
    }
    const onResume = (): void => {
      void coreLifecycle.resume()
      webdavBackupScheduler.resume()
      if (tunSession.state().owned) void tunSession.inspect().catch(() => {})
    }
    powerMonitor.on('suspend', onSuspend)
    powerMonitor.on('resume', onResume)
    const coreSelection = createCoreSelectionService({
      profiles: profileStore,
      read: () => readCoreSelectionNative(nativePath(), stateContext()),
      save: (selection, revision) =>
        saveCoreSelectionNative(nativePath(), stateContext(), selection, revision)
    })
    const preserveDedicatedPin = async (current: () => void): Promise<void> => {
      let source:
        | { selection: RelayProfileSelection; revision: string; resolverMode: LocalResolverMode }
        | undefined
      await localProxyPlanStore.preservePinnedNode(
        async (plan) => {
          const selection = await coreSelection.read()
          current()
          if (!selection) return undefined
          const stored = await configurationEdit.readRuntimeProfile(selection, plan.resolverMode)
          current()
          source = { selection, revision: stored.revision, resolverMode: plan.resolverMode }
          const configuration = analyzeProfile(stored.text).data
          return {
            sourceProfileId: selection.id,
            node: Array.isArray(configuration?.proxies)
              ? configuration.proxies.find(
                  (node) => plainConfigurationMap(node) && node.name === plan.dedicated?.route
                )
              : undefined
          }
        },
        current,
        async () => {
          current()
          if (!source) return
          const selected = await coreSelection.read()
          if (
            selected?.id !== source.selection.id ||
            selected.sha256 !== source.selection.sha256 ||
            (await configurationEdit.readRuntimeProfile(selected, source.resolverMode)).revision !==
              source.revision
          )
            throw new Error('原 AI 固定节点所属配置已变化，未切换配置。')
          current()
        }
      )
    }
    const clashBackend = createClashBackend({
      local: localProxy,
      profiles: profileStore,
      notify: notifyClash,
      readSelection: () => coreSelection.readPreferred(),
      rememberSelection: (selection) => coreSelection.remember(selection),
      beforeProfileChange: () => preserveDedicatedPin(coreOwnerIntent(false, false))
    })
    const systemProxy = createSystemProxyService({
      native: (action, settings, revision) =>
        systemProxyNative(nativePath(), stateContext(), action, settings, revision),
      pac: startPacServer,
      verifyTarget: verifyProxyTarget,
      notify: notifyClash,
      confirm: async (_plan, reason) =>
        (automaticUninstallRequested && reason === 'quit') || actionWindowAvailable()
    })
    const executeUserSystemProxy = async (input: unknown) => {
      if (quitAfterRestore || shellQuitting) throw new Error('退出期间不能切换系统代理。')
      return trackProxyChoice(
        systemProxy.execute(input).then(async (result) => {
          if (result.status === 'applied') tunHandoff.clearOrdinaryRecovery()
          if (result.status === 'applied' || result.status === 'restored')
            await startupPreferences.systemProxy(result.status === 'applied')
          return result
        })
      )
    }
    const diagnostics = createDiagnosticService({
      ownedObserve: () => ownedDiagnostics.observe(),
      observe: (settings) =>
        diagnoseNative(
          nativePath(),
          settings,
          relayDiagnosticContext(app.getPath('home'), nativePath(), runtime.stateDirectory)
        ),
      guardPlan: (node, proxyTypes) => guardPlanNative(nativePath(), node, proxyTypes),
      now: Date.now
    })
    const recovery = createRecoveryService({
      inventory: () => recoveryStatusNative(nativePath(), stateContext()),
      inspect: (selection) => recoveryPreflightNative(nativePath(), selection, stateContext()),
      confirm: async () => actionWindowAvailable(),
      restore: (inspection, allowLegacy) =>
        recoveryRestoreNative(
          nativePath(),
          inspection.selection,
          inspection.revision,
          allowLegacy,
          stateContext()
        )
    })
    const aiClients = createAiClientService({
      state: () => localProxy.state(),
      readCodexConfig: async () => {
        // Check only whether the Codex config exists. Routing is managed separately.
        try {
          await access(join(codeContext().home, '.codex/config.toml'))
          return { exists: true }
        } catch {
          return { exists: false }
        }
      }
    })
    const diagnosticEvidence = createDiagnosticEvidenceReader(stateContext())
    const ownedDiagnostics = createOwnedDiagnosticService({
      state: () => localProxy.state(),
      live: () => localProxy.inspectLive(true),
      association: () => aiClients.inspect(),
      clients: (owned) =>
        diagnoseNative(
          nativePath(),
          {
            httpPort: 17891,
            node: 'Relay 当前实例',
            internalExceptions: ''
          },
          {
            ...relayDiagnosticContext(app.getPath('home'), nativePath(), runtime.stateDirectory),
            owned
          }
        ),
      guard: () => guardReadiness.read(),
      evidence: () => diagnosticEvidence.read()
    })
    let browserBindingReady = false
    const browserBinding = createBrowserBindingChannel(stateContext(), async () => {
      if (automaticUninstallRequested || quitAfterRestore || shellQuitting)
        throw new Error('Relay 正在退出。')
      const binding = await aiClients.ownedBrowserBinding()
      if (automaticUninstallRequested || quitAfterRestore || shellQuitting)
        throw new Error('Relay 正在退出。')
      return binding
    })
    const library = new RelayLibraryStore(stateContext(), async () => {
      const [profiles, sources] = await Promise.all([
        profileStore.list(),
        subscriptionSourceStore.list()
      ])
      if (
        profiles.incomplete ||
        sources.incomplete ||
        profiles.warnings.some((w) => w.includes('截断')) ||
        sources.warnings.some((w) => w.includes('截断'))
      )
        throw new Error('库清单不完整，保留全部条目。')
      const disk = await coreStore.inspect(),
        generic = core.state(),
        local = localProxy.state(),
        tun = tunSession.state(),
        scheduled = sourceScheduler.state()
      const unconfirmed =
        generic.phase === 'unknown' ||
        generic.pending ||
        generic.uncertain ||
        generic.owned ||
        generic.hasRecord ||
        disk.lease !== 'missing' ||
        local.phase === 'unknown' ||
        local.pending ||
        local.uncertain ||
        (!local.owned && local.hasRecord) ||
        (local.owned && !local.profileId) ||
        tun.pending ||
        !['idle', 'prepared', 'restored', 'released'].includes(tun.phase) ||
        tun.owned
      const ownerRevision = resourceHash(
        Buffer.from(
          JSON.stringify({
            generic: {
              phase: generic.phase,
              pending: generic.pending,
              owned: generic.owned,
              hasRecord: generic.hasRecord,
              uncertain: generic.uncertain
            },
            local: {
              phase: local.phase,
              pending: local.pending,
              owned: local.owned,
              hasRecord: local.hasRecord,
              uncertain: local.uncertain,
              instanceId: local.instanceId,
              profileId: local.profileId,
              configurationRevision: local.configurationRevision,
              pid: local.pid
            },
            tun: {
              phase: tun.phase,
              pending: tun.pending,
              owned: tun.owned,
              sessionId: tun.sessionId,
              traffic: tun.traffic
            },
            disk
          })
        )
      )
      return [
        ...profiles.profiles.map((item) => ({
          kind: 'profile' as const,
          id: item.id,
          name: item.name,
          revision: item.sha256,
          active:
            local.owned &&
            local.phase === 'running' &&
            !local.uncertain &&
            !local.pending &&
            local.profileId === item.id,
          ...(unconfirmed
            ? { protectionReason: '运行配置未确认，暂不能移出；请先核对自有核心的运行记录。' }
            : {}),
          ownerRevision,
          scheduled: false
        })),
        ...sources.sources.map((item) => ({
          kind: 'source' as const,
          id: item.id,
          name: item.name,
          revision: item.revision,
          active: false,
          ownerRevision,
          scheduled: scheduled.entries.some((entry) => entry.id === item.id && entry.enabled)
        }))
      ]
    })
    trafficHistory = createTrafficHistory({
      context: stateContext(),
      local: () => localProxy.state(),
      tunOwner: () => tunSession.historyOwner(),
      cancelRead: () => tunSession.cancelHistoryRead(),
      assertAvailable: () => {
        const owner = tunSession.historyOwner()
        requireCompleteIdle(
          false,
          false,
          false,
          false,
          false,
          false,
          owner?.kind === 'tun-managed'
            ? { kind: 'tun-managed', sessionId: owner.instanceId }
            : undefined
        )
      },
      confirm: async (_action, _owner) => {
        return actionWindowAvailable()
      }
    })
    connectionAppInfo = createConnectionAppInfo({
      home: stateContext().home,
      local: () => localProxy.state(),
      resolve: async (path) => {
        if (process.platform !== 'darwin') return { name: '', icon: '' }
        // The source is an owned Core observation, never a renderer pathname.
        const canonical = await realpath(path)
        if (canonical !== path) return { name: '', icon: '' }
        return resolveConnectionAppInfo({ processPath: canonical })
      }
    })
    isolatedProbes = createIsolatedProbes({
      context: stateContext(),
      confirmArchive: async (_count, signal) => {
        const owner = window,
          live = runtimeGistContext(),
          epoch = guardRendererEpoch
        if (!owner || owner.isDestroyed()) return false
        live()

        live()
        return epoch === guardRendererEpoch && !signal.aborted
      },
      // Use the same composed source (including global/profile overrides) as
      // the ordinary core. The probe still projects its own restricted network
      // configuration without the original route's geodata dependencies; this
      // read never applies edits to the running core.
      readProfile: (selection) => configurationEdit.readIsolatedProbeProfile(selection),
      resourceRoot: async () => coreRoot,
      independentNetwork: async () => {
        const observed = await inspectProbeNetwork(
            join(dirname(nativePath()), 'RelayNetworkObserver')
          ),
          tun = tunSession.state()
        if (
          observed.existingTunnel ||
          tun.owned ||
          tun.pending ||
          !['idle', 'prepared', 'restored', 'released'].includes(tun.phase)
        )
          throw new Error('当前没有TUN截流的事实未确认，独立探测没有启动。')
        return JSON.stringify({
          network: observed.networkSHA256,
          protection: observed.protectionSHA256
        })
      },
      confirm: async (_plan, signal) => {
        const owner = window,
          live = runtimeGistContext(),
          epoch = guardRendererEpoch
        if (!owner || owner.isDestroyed()) return false
        live()

        live()
        return (
          window === owner &&
          !owner.isDestroyed() &&
          !signal.aborted &&
          epoch === guardRendererEpoch
        )
      }
    })
    const readObservedConnections = async () => {
      const ticket = trafficHistory?.ticket(),
        appTicket = connectionAppInfo?.ticket()
      const snapshot = await localProxy.connections()
      trafficHistory?.observe(ticket, snapshot)
      connectionAppInfo?.observe(appTicket, snapshot)
      return snapshot
    }
    const runtimeInfo = createRuntimeInfoService({
      state: () => localProxy.state(),
      connections: readObservedConnections
    })
    const code = createCodeService({
      prepare: async (settings) => {
        if (!browserBindingReady) throw new Error('Relay专用浏览器入口未就绪，请重新打开Relay。')
        const association = localProxy.state()
        await aiClients.verifyClaudeCodePort(settings.httpPort, association, settings.node)
        const report = await prepareCodeNative(nativePath(), settings, codeContext())
        return { report, context: association }
      },
      confirm: async (_preparation) => {
        return actionWindowAvailable()
      },
      verify: async (settings, association) => {
        // Re-verify the live listener immediately before the native write;
        // the instance may have stopped between prepare and apply.
        await aiClients.verifyClaudeCodePort(settings.httpPort, association, settings.node)
      },
      apply: (settings, revision) =>
        applyCodeNative(nativePath(), settings, revision, codeContext())
    })
    const desktop = createDesktopService({
      open: (onUncertain) => openDesktopTransport(nativePath(), stateContext(), onUncertain),
      confirm: async (action) => {
        return (automaticUninstallRequested && action === 'restore') || actionWindowAvailable()
      }
    })
    const edge = createEdgeService({
      inspect: () => inspectEdgeNative(nativePath(), stateContext()),
      openProfile: (revision) =>
        openEdgeToolNative(nativePath(), 'openProfile', stateContext(), revision),
      openEntry: (action) => openEdgeToolNative(nativePath(), action, stateContext()),
      confirm: async () => actionWindowAvailable()
    })
    let quitAfterRestore = false,
      backupRendererEpoch = 0,
      systemProxyReadEpoch = 0,
      quitDrainSequence = 0,
      ordinaryQuitRequested = false
    const invalidateRendererEpochs = (): void => {
      ++backupRendererEpoch
      ++systemProxyReadEpoch
    }
    const reopenSimpleAfterCancelledQuit = (): void => {
      const sequence = quitDrainSequence,
        generation = restartCoordinator?.state().generation
      void reopenSimpleWhenIdle(
        {
          whenIdle: async () => {
            await Promise.all([simple.whenIdle(), publication.whenIdle(), profiles.whenIdle()])
          },
          state: () => simple.state(),
          reopen: () => {
            simple.reopen()
            publication.reopen()
          }
        },
        () =>
          sequence === quitDrainSequence &&
          generation === restartCoordinator?.state().generation &&
          !automaticUninstallRequested &&
          !quitAfterRestore &&
          !shellQuitting
      ).catch(() => {})
    }
    let finalQuitPassedSystemProxy = false
    const recoverCancelledQuit = (generation?: number): void => {
      if (generation !== undefined && restartCoordinator?.state().generation !== generation) return
      finalQuitPassedSystemProxy = false
      retainedExitPass = undefined
      retainedExitPassLive = undefined
      retainedExitPending = false
      restartCoordinator?.quitCancelled(generation)
      quitAfterRestore = false
      shellQuitting = false
      coreLifecycle.cancelClose()
      reopenSimpleAfterCancelledQuit()
      shellHost.showWindow()
    }
    const waitToQuit = (presetRestartPass?: RestartDrainPass): void => {
      if (
        ordinaryCoreOwner.retained() ||
        (ordinaryCoreOwner.isBlocking() && !ordinaryCoreOwner.ownsLocalInstance())
      ) {
        shellHost.showWindow()
        return
      }
      if (quitAfterRestore) return
      finalQuitPassedSystemProxy = false
      const restartPass = presetRestartPass ?? restartCoordinator?.beginDrain()
      const sequence = ++quitDrainSequence
      const release = (): void => {
        if (sequence === quitDrainSequence) quitAfterRestore = false
      }
      const unwind = (result: 'cancelled' | 'failed'): void => {
        if (restartPass) restartCoordinator?.settleDrain(restartPass, result)
        if (sequence !== quitDrainSequence) return
        finalQuitPassedSystemProxy = false
        release()
        shellQuitting = false
        coreLifecycle.cancelClose()
        reopenSimpleAfterCancelledQuit()
      }
      const canContinue = (): boolean => {
        if (sequence !== quitDrainSequence || !quitAfterRestore) return false
        if (!restartPass || ordinaryQuitRequested || restartCoordinator?.ownsDrain(restartPass))
          return true
        unwind('cancelled')
        shellHost.showWindow()
        return false
      }
      quitAfterRestore = true
      onlineThemes?.cancel()
      trayWorkflows?.invalidate()
      void (async () => {
        try {
          if (subStoreNetworkBusy && !(await subStore.requestClose()))
            throw new Error('Sub-Store独立出口收尾未确认。')
          await isolatedProbes?.requestClose()
          updates.cancel()
          appUpdates?.cancel()
          remoteBackup.cancel()
          runtimeGist.cancel()
          runtimeGistDiscovery.invalidate()
          overrideLibrary.invalidate()
          backupAccounts.cancel()
          backupService.invalidatePending()
          const closingRuntimeSync = runtimeGistSync.stop('quitting')
          const closingDirectory = webdavDirectory.requestClose()
          if (backupAccounts.isBusy()) await backupAccounts.whenIdle()
          // A confirmed restore owns its file transaction until it settles.
          // Closing idle schedulers first would transiently trip its rechecks.
          if (backupService.isBusy()) await backupService.whenIdle()
          if (!canContinue()) return
          // A confirmed restore settles and rereads Simple before its quit drain.
          await publication.requestClose()
          if (!canContinue()) return
          const closingSimple = simple.requestClose()
          const closingWebdav = webdavBackupScheduler.requestClose()
          await Promise.all([
            closingRuntimeSync,
            closingDirectory,
            closingWebdav,
            closingSimple,
            resources.requestClose(),
            geoOrigins.requestClose(),
            geoScheduler.requestClose(),
            sourceScheduler.requestClose(),
            pluginScheduler.requestClose(),
            providers.requestClose(),
            subscriptions.requestClose(),
            subscriptionSources.requestClose(),
            completeConfiguration.requestClose(),
            plugins.requestClose()
          ])
          await Promise.allSettled(pendingProxyChoices)
          await Promise.all([
            code.whenIdle(),
            recovery.whenIdle(),
            edge.whenIdle(),
            profiles.whenIdle(),
            profileRuntime.whenIdle(),
            coreRecordRecovery.whenIdle(),
            clashBackend.whenIdle(),
            core.whenIdle(),
            localProxy.whenIdle(),
            variantService.whenIdle(),
            shellWorkflow.whenIdle(),
            loginItem.whenIdle(),
            trayWorkflows?.whenIdle(),
            geometryHost.whenIdle(),
            floatingGeometryHost.whenIdle(),
            backupService.whenIdle(),
            uiPreferences.whenIdle(),
            systemProxyDraft.whenIdle(),
            localProxyPlanStore.whenIdle(),
            maintenance?.whenIdle(),
            remoteBackup.whenIdle(),
            runtimeGist.whenIdle(),
            runtimeGistDiscovery.whenIdle(),
            overrideLibrary.whenIdle(),
            runtimeGistSync.whenIdle(),
            webdavDirectory.whenIdle(),
            backupAccounts.whenIdle(),
            webdavBackupScheduler.whenIdle(),
            updates.whenIdle(),
            appUpdates?.whenIdle(),
            ownedResetService.whenIdle(),
            configurationEdit.whenIdle()
          ])
          if (!canContinue()) return
          if (terminalCLI && !(await terminalCLI.requestClose())) {
            unwind('cancelled')
            return
          }
          if (!(await scopedCLI?.requestClose())) {
            unwind('cancelled')
            return
          }
          if (!(await guardManagement?.requestClose())) {
            unwind('cancelled')
            return
          }
          const local = localProxy.state()
          let ownedProxyPorts: number[] | undefined
          // The isolated core has no proxy listeners. A failed local stop also
          // retains its listener plan, so a retry can prove independence using
          // the same conservative port set without claiming the core is live.
          if (!tunSession.isBlocking() && !local.pending) {
            if (!local.owned) ownedProxyPorts = []
            else if (local.ports)
              ownedProxyPorts = [
                ...enabledLocalProxyPorts(local.ports),
                ...(local.dedicated?.httpPort ? [local.dedicated.httpPort] : []),
                ...(local.dedicated?.socksPort ? [local.dedicated.socksPort] : [])
              ]
          }
          const cancelUnconfirmedSystemProxy = async (): Promise<void> => {
            unwind('cancelled')
            shellHost.showWindow()
            const state = systemProxy.state(),
              noRecord = state.report && !state.report.recordID,
              dependency = state.pacServersRetained > 0 ? '本次PAC服务' : '本次代理端口'
            if (window && !automaticUninstallRequested)
              await dialog.showMessageBox(window, {
                type: 'warning',
                title: '系统代理恢复未确认',
                message: noRecord
                  ? `系统代理仍可能引用${dependency}，已保留Relay以免连接中断。`
                  : '系统代理恢复或依赖检查尚未通过，已保留本次核心和PAC服务。',
                detail: noRecord
                  ? '当前没有可自动恢复的代理记录。请打开macOS“系统设置 → 网络 → 当前网络 → 详细信息 → 代理”，停用指向Relay的手动/自动代理或切换至可用代理后，再选择退出Relay。没有自动覆盖外部配置。'
                  : '请在系统代理设置中重新读取状态，处理仍指向本次端口的代理或未确认的自动代理后再次退出。外部修改不会自动覆盖；没有停止当前Clash或强行清空系统代理。',
                buttons: ['返回处理'],
                defaultId: 0,
                cancelId: 0
              })
          }
          if (!(await systemProxy.requestClose(ownedProxyPorts))) {
            await cancelUnconfirmedSystemProxy()
            return
          }
          const portsToRecheck = ownedProxyPorts?.length ? ownedProxyPorts : undefined
          if (!canContinue()) return
          if (!(await tunSession.requestClose())) {
            unwind('cancelled')
            shellHost.showWindow()
            if (window && !automaticUninstallRequested)
              await dialog.showMessageBox(window, {
                type: 'warning',
                title: 'TUN停用或恢复尚未确认',
                message: '保留本次宿主、恢复记录和Relay窗口，请先完成TUN停用。',
                buttons: ['返回处理'],
                defaultId: 0,
                cancelId: 0
              })
            return
          }
          if (!canContinue()) return
          if (!(await subStore.requestClose())) {
            unwind('cancelled')
            shellHost.showWindow()
            return
          }
          ++subStoreWindowEpoch
          subStoreWindow?.destroy()
          subStoreWindow = undefined
          if (!canContinue()) return
          let externalProxyUnconfirmed = false
          const proxyClosed = await localProxy.requestClose(
            portsToRecheck
              ? async () => {
                  externalProxyUnconfirmed =
                    !(await systemProxy.verifyExternalProxyForQuit(portsToRecheck))
                  return !externalProxyUnconfirmed && canContinue()
                }
              : undefined
          )
          if (proxyClosed === 'cancelled') {
            if (externalProxyUnconfirmed) await cancelUnconfirmedSystemProxy()
            else unwind('cancelled')
            return
          }
          if (proxyClosed === 'failed') {
            unwind('cancelled')
            if (window && !automaticUninstallRequested)
              await dialog.showMessageBox(window, {
                type: 'warning',
                title: '本地代理退出尚未确认',
                message: '保留实例、记录和窗口，请重试停止本次代理。',
                detail: '没有强制结束本次代理或操作当前Clash。',
                buttons: ['返回处理'],
                defaultId: 0,
                cancelId: 0
              })
            return
          }
          if (!canContinue()) return
          if (automaticUninstallRequested && desktop.state().snapshot?.requiresRecoveryConsent) {
            await desktop.whenIdle()
            await desktop.action('restore')
            if (!canContinue()) return
          }
          const closing = Promise.all([desktop.requestClose(), core.requestClose()])
          await Promise.all([
            recovery.whenIdle(),
            code.whenIdle(),
            edge.whenIdle(),
            profiles.whenIdle(),
            profileRuntime.whenIdle(),
            coreRecordRecovery.whenIdle(),
            clashBackend.whenIdle()
          ])
          if ((await closing).every(Boolean)) {
            if (!canContinue()) return
            await desktop.whenIdle()
            await flushWindowGeometryForExit(backupStore, geometryHost, floatingGeometryHost)
            if (!canContinue()) return
            await library.whenIdle()
            await trafficHistory?.requestClose()
            if (!canContinue()) return
            await coreLifecycle.close()
            if (!canContinue()) return
            // The settled drain may preserve an external proxy's recovery
            // record. Bypass only this gate in the final app/window close.
            finalQuitPassedSystemProxy = true
            release()
            if (restartPass && restartCoordinator?.settleDrain(restartPass, 'confirmed')) {
              if (!restartCoordinator.quitAfterDrain(restartPass)) {
                unwind('failed')
                shellHost.showWindow()
              }
            } else if (!restartPass || ordinaryQuitRequested) app.quit()
            else unwind('cancelled')
          } else {
            unwind('cancelled')
            if (window && !automaticUninstallRequested)
              await dialog.showMessageBox(window, {
                type: 'warning',
                title: core.isBlocking() ? '核心退出或记录清理尚未完成' : '桌面登录恢复尚未完成',
                message: '保留 Relay 窗口，请先处理并确认恢复。',
                detail:
                  '后台操作可能仍在进行或记录需要核对。请在桌面登录面板确认恢复，或在隔离核心面板重试停止本次实例。没有按磁盘PID操作其他进程。',
                buttons: ['返回处理'],
                defaultId: 0,
                cancelId: 0
              })
          }
        } catch {
          unwind('failed')
        }
      })()
    }
    const updates = createUpdateService({
      store: new UpdateCandidateStore(stateContext(), trustedUpdateCatalog()),
      assertIdle: () => requireCompleteIdle(false, false, true),
      assertImportIdle: requireVariantCoreIdle,
      confirmImport: confirmVariantAcquire,
      assertSubStoreIdle: () => {
        if (subStore.isBlocking()) throw new Error('请先结束本次Sub-Store，再接入候选资源。')
      },
      applySubStore: async (backend, frontend, signal) => {
        await subStore.installCandidates(backend, frontend, signal)
      },
      confirmSubStore: async (_plan) => {
        return actionWindowAvailable()
      },
      importCandidate: async (request) => {
        await variantStore.acquire(request)
      },
      confirmDownload: async (_plan) => {
        return actionWindowAvailable()
      },
      confirmRemove: async (_candidate) => {
        return actionWindowAvailable()
      }
    })
    const confirmAppUpdate = async (): Promise<boolean> => {
      const owner = window,
        epoch = backupRendererEpoch,
        frame = (() => {
          try {
            return owner?.webContents.mainFrame
          } catch {
            return undefined
          }
        })()
      const live = (): boolean => {
        try {
          return (
            !!owner &&
            !!frame &&
            window === owner &&
            !owner.isDestroyed() &&
            !owner.webContents.isDestroyed() &&
            owner.isVisible() &&
            owner.webContents.mainFrame === frame &&
            backupRendererEpoch === epoch &&
            !quitAfterRestore &&
            !shellQuitting
          )
        } catch {
          return false
        }
      }
      if (!owner || !live()) return false

      return live()
    }
    const appUpdateStore = new AppUpdateCandidateStore(stateContext())
    const assertAppUpdateIdle = (): void => {
      const previous = appUpdateAssertion
      appUpdateAssertion = true
      try {
        requireCompleteIdle()
      } finally {
        appUpdateAssertion = previous
      }
    }
    appUpdates = createAppUpdateService({
      store: appUpdateStore,
      journal: new AppInstallationJournal(stateContext()),
      platform: new MacAppUpdatePlatform(appUpdateStore),
      architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
      runningVersion: () => app.getVersion(),
      network: appUpdateNetwork(() => localProxy.state()),
      assertIdle: assertAppUpdateIdle,
      handoff: appUpdateHandoff({
        reserve: async () => {
          if (appInstallReserved) throw new Error('应用安装交接已被其他操作持有。')
          appInstallReserved = true
          return () => {
            appInstallReserved = false
          }
        },
        assertOtherOperationsIdle: () => {
          assertAppUpdateIdle()
          if (subStore.isBlocking()) throw new Error('请先结束本次Sub-Store服务。')
        },
        local: () => localProxy.state(),
        core: () => core.state(),
        coreStore: () => coreStore.inspect(),
        tun: () => tunSession.state(),
        systemProxy: () => systemProxy.inspect(),
        desktop: async () => desktop.state(),
        desktopReadiness: () => desktopReadinessNative(nativePath(), stateContext()),
        guard: async () => (guardManagement ? guardManagement.inspectActivity() : 'unknown')
      }),
      confirmDownload: async (_plan) => {
        return confirmAppUpdate()
      },
      confirmInstall: async ({ plan: _plan }) => {
        return confirmAppUpdate()
      },
      confirmRecovery: async (_record, _dismiss) => {
        return confirmAppUpdate()
      },
      confirmRemove: async (_candidate) => {
        return confirmAppUpdate()
      }
    })
    // A corrupt/unknown marker preserves the startup barrier but keeps the UI
    // available for explicit local inspection; it never starts a recovery action.
    await appUpdates.initialize().catch(() => {})
    const pluginProxy = async () => {
      const state = localProxy.state()
      if (
        !state.owned ||
        state.pending ||
        state.phase !== 'running' ||
        !state.pid ||
        !state.httpPort ||
        !(await ownsHttpListener(state.pid, state.httpPort))
      )
        throw new Error('插件代理必须是已确认的本次Relay HTTP入口。')
      const current = localProxy.state()
      if (
        current.instanceId !== state.instanceId ||
        current.configurationRevision !== state.configurationRevision ||
        current.pending
      )
        throw new Error('代理在关联期间已变化。')
      return { host: '127.0.0.1', port: state.httpPort }
    }
    const plugins = createRelayPluginService({
      store: new RelayPluginStore(stateContext(), {
        available: async () => safeStorage.isEncryptionAvailable(),
        encrypt: async (text) => safeStorage.encryptString(text),
        decrypt: async (bytes) => safeStorage.decryptString(bytes)
      }),
      context: (record, signal) =>
        createRelayPluginContext({
          record,
          signal,
          proxy: pluginProxy
        }),
      downloadDescriptor: (source, signal) =>
        downloadDescriptor(source, signal, { proxy: pluginProxy }),
      readOpenedDescriptor: async () => {
        const path = descriptorInbox.take()
        notifyOpenedDescriptor?.()
        return path ? readDescriptorFile(path) : undefined
      },
      pickDescriptor: async () => {
        if (!window) return undefined
        const selected = await dialog.showOpenDialog(window, {
          title: '选择插件描述文件',
          properties: ['openFile'],
          filters: [{ name: 'CPX', extensions: ['cpx'] }]
        })
        if (selected.canceled || selected.filePaths.length !== 1) return undefined
        return readDescriptorFile(selected.filePaths[0])
      },
      openBrowser: (url) => shell.openExternal(url),
      saveProfile,
      notify: notifyClash,
      confirm: async (_permission) => {
        return actionWindowAvailable()
      }
    })
    const pluginScheduler = createRelayPluginScheduler({
      prepare: (id) => plugins.prepareSchedule(id),
      canRun: () => {
        try {
          requireCompleteIdle()
          return !subStore.isBusy() && !clashBackend.isBusy() && !shellWorkflow.isBusy()
        } catch {
          return false
        }
      },
      confirm: async (_permission, _minutes) => {
        return actionWindowAvailable()
      },
      notify: notifyClash
    })
    let subStoreWindow: BrowserWindow | undefined
    let subStoreOpening: Promise<BrowserWindow> | undefined
    let subStoreWindowEpoch = 0
    const subStoreResources = new SubStoreResources(stateContext().stateRoot)
    const beginSubStoreEgress = async (
      request: SubStoreAdvancedStart,
      input: { signal: AbortSignal; registerCleanup(stop: () => Promise<void>): void }
    ) => {
      if (subStoreNetworkBusy) throw new Error('Sub-Store独立出口尚未收尾。')
      const owner = window,
        epoch = ++subStoreNetworkEpoch,
        controller = new AbortController()
      subStoreNetworkBusy = true
      subStoreNetworkAbort = controller
      const live = (): void => {
        if (
          !owner ||
          owner.isDestroyed() ||
          window !== owner ||
          controller.signal.aborted ||
          subStoreNetworkEpoch !== epoch ||
          shellQuitting ||
          quitAfterRestore
        )
          throw new Error('Sub-Store独立授权已失效。')
        requireCompleteIdle(
          false,
          false,
          false,
          false,
          false,
          false,
          undefined,
          false,
          undefined,
          subStoreNetworkPermit
        )
      }
      let close: (() => Promise<void>) | undefined
      const stop = async (): Promise<void> => {
        controller.abort()
        await close?.()
        if (subStoreNetworkAbort === controller) {
          subStoreNetworkAbort = undefined
          subStoreNetworkBusy = false
        }
      }
      input.registerCleanup(stop)
      live()
      const source = await profileStore.read(request.profile)
      live()
      const root = coreRoot
      live()
      return startSubStoreEgress({
        context: stateContext(),
        resourceRoot: root,
        text: source.text,
        request,
        signal: AbortSignal.any([input.signal, controller.signal]),
        assertLive: live,
        network: async () => {
          live()
          const current = await profileStore.read(request.profile)
          live()
          if (current.revision !== source.revision) throw new Error('独立出站配置修订变化。')
          const installed = await readTunInstallation('core-managed')
          live()
          if (!installed) throw new Error('只读网络观察组件未安装。')
          const observation = await inspectTunNative(installed),
            tun = tunSession.state()
          live()
          if (
            observation.helper.identity !== 'authenticated' ||
            observation.network.state !== 'observed' ||
            observation.network.existingTunnel !== 'none' ||
            tun.owned ||
            tun.pending ||
            !['idle', 'prepared', 'restored', 'released'].includes(tun.phase)
          )
            throw new Error('没有TUN截流的事实未确认。')
          return JSON.stringify({
            installation: installed.revision,
            network: observation.baseline.networkSHA256,
            protection: observation.baseline.protectionSHA256
          })
        },
        registerCleanup: (handle) => {
          close = handle
        },
        failed: () => {
          controller.abort()
          subStore.networkUnavailable()
        }
      })
    }
    const subStore = createSubStoreService({
      resources: subStoreResources,
      advanced: {
        validate: async (request) => {
          const source = await profileStore.read(request.profile)
          isolatedProbeConfiguration(source.text, { target: request.target, kind: 'ip' }, 49152)
        },
        confirm: async (request, _purpose, signal) => {
          const owner = window,
            epoch = subStoreNetworkEpoch,
            intent = guardRendererEpoch,
            live = runtimeGistContext()
          if (!owner || owner.isDestroyed()) return false
          live()
          await profileStore.read(request.profile)
          live()
          if (intent !== guardRendererEpoch) throw new Error('本次Sub-Store页面意图已失效。')

          live()
          return (
            window === owner &&
            !owner.isDestroyed() &&
            epoch === subStoreNetworkEpoch &&
            intent === guardRendererEpoch &&
            !signal.aborted
          )
        },
        acquire: beginSubStoreEgress,
        open: async (request, input) => {
          let backendStop: (() => Promise<void>) | undefined,
            egressStop: (() => Promise<void>) | undefined
          const combined = async (): Promise<void> => {
            await backendStop?.()
            await egressStop?.()
          }
          input.registerCleanup(combined)
          const egress = await beginSubStoreEgress(request, {
            signal: input.signal,
            registerCleanup: (stop) => {
              egressStop = stop
            }
          })
          const runtime =
            request.mode === 'remote'
              ? await startRemoteSubStore({
                  resources: subStoreResources,
                  backendURL: request.backendURL,
                  egress,
                  signal: input.signal,
                  registerCleanup: (stop) => {
                    backendStop = stop
                  }
                })
              : await startSubStoreRuntime({
                  resources: subStoreResources,
                  dependencyRoot: join(app.getAppPath(), 'node_modules'),
                  proxyPort: egress.port,
                  signal: input.signal,
                  advanced: request,
                  egressPID: egress.pid,
                  beforeSessionRelease: () => egress.stop(),
                  registerCleanup: (stop) => {
                    backendStop = stop
                  }
                })
          return { ...runtime, alive: () => runtime.alive() && egress.alive(), stop: combined }
        }
      },
      start: ({ proxyPort, signal, registerCleanup }) =>
        startSubStoreRuntime({
          resources: subStoreResources,
          dependencyRoot: join(app.getAppPath(), 'node_modules'),
          proxyPort,
          signal,
          registerCleanup
        }),
      save: saveProfile,
      confirmRecover: async (_record, signal) => {
        const owner = window,
          live = runtimeGistContext(),
          epoch = guardRendererEpoch
        if (!owner || owner.isDestroyed()) return false
        live()

        live()
        return epoch === guardRendererEpoch && !signal.aborted
      },
      confirmAcquire: async (_proxyPort) => {
        return actionWindowAvailable()
      },
      confirmStart: async (_proxyPort) => {
        return actionWindowAvailable()
      },
      confirmSave: async (_plan, signal) => {
        const owner = window,
          live = runtimeGistContext(),
          epoch = guardRendererEpoch
        if (!owner || owner.isDestroyed()) return false
        live()

        live()
        return epoch === guardRendererEpoch && !signal.aborted
      }
    })
    cancelSubStoreOperation = () => subStore.cancel()
    let shellQuitting = false
    const restart = createRestartCoordinator({
      assertAvailable: () => {
        if (
          automaticUninstallRequested ||
          quitAfterRestore ||
          shellQuitting ||
          !window ||
          window.isDestroyed() ||
          backupService.isBusy() ||
          remoteBackup.isBusy() ||
          runtimeGist.isBusy() ||
          runtimeGistDiscovery.isBusy() ||
          overrideLibrary.isBusy() ||
          backupAccounts.isBusy() ||
          webdavBackupScheduler.isBusy() ||
          loginItem.isBusy()
        )
          throw new Error('退出、恢复或登录项操作尚未结束。')
      },
      showWindow: () => shellHost.showWindow(),
      confirm: async () => {
        const target = window,
          epoch = backupRendererEpoch
        if (!target || target.isDestroyed()) return false

        return (
          window === target &&
          !target.isDestroyed() &&
          target.isVisible() &&
          backupRendererEpoch === epoch
        )
      },
      startDrain: (pass) => {
        ordinaryQuitRequested = false
        waitToQuit(pass)
      },
      quit: () => app.quit(),
      relaunch: () => app.relaunch()
    })
    restartCoordinator = restart
    const stopTunSession = (input: unknown) => {
      requireProfileSwitchIdle()
      runtimeGist.cancel()
      if (runtimeGistSync.state().owner?.source?.kind === 'tun-managed')
        void runtimeGistSync.stop('ownerChanged')
      return tunHandoff.stop(tunSessionRequest(input))
    }
    const floatingGeometry = createWindowGeometryService({
      kind: 'floating',
      store: new RelayWindowStateStore(stateContext(), 'floating'),
      displays: () => screen.getAllDisplays(),
      primaryId: () => screen.getPrimaryDisplay().id
    })
    const floatingGeometryHost = createWindowGeometryHost({ geometry: floatingGeometry, screen })
    const themeService = createOnlineThemeService({
      local: () => localProxy.state(),
      assertAvailable: () => {
        if (
          quitAfterRestore ||
          shellQuitting ||
          !window ||
          window.isDestroyed() ||
          !window.isVisible()
        )
          throw new Error('工作区已隐藏或退出恢复正在进行。')
        const shell = shellWorkflow.state()
        if (!shell.initialized || shell.pending || shell.uncertain)
          throw new Error('请先核对窗口工作流。')
        requireCompleteIdle()
      },
      download: downloadOnlineThemes,
      confirm: async (_owner) => {
        const target = window
        if (!target || target.isDestroyed() || !target.isVisible()) return false

        return window === target && !target.isDestroyed() && target.isVisible()
      },
      invalidated: () => {
        try {
          if (window && !window.isDestroyed())
            window.webContents.send('relayShellThemesInvalidated')
        } catch {
          /* Revoked even if closing renderer is gone. */
        }
      }
    })
    onlineThemes = themeService
    const shellHost = createElectronShellHost({
      window: () => window,
      iconPath: join(nativePath(), '..', 'tray.png'),
      floating: {
        preloadPath: join(__dirname, '../preload/index.cjs'),
        rendererPath: join(__dirname, '../renderer/floating.html'),
        readTraffic: (signal) => {
          const tun = tunSession.state()
          // An owned/changing TUN failure must remain unavailable; do not label
          // ordinary traffic as if it came from the selected TUN source.
          return tun.owned ||
            tun.pending ||
            !['idle', 'prepared', 'restored', 'released'].includes(tun.phase)
            ? tunSession.readTraffic(signal)
            : localProxy.readTraffic(signal)
        },
        geometry: { ...floatingGeometryHost, resolve: () => floatingGeometry.resolve() }
      },
      canPerform: () => !automaticUninstallRequested && !quitAfterRestore && !shellQuitting,
      backgroundChosen: () => restart.backgroundChosen(),
      trafficFailure: () => shellWorkflow.reportDisplayFailure(),
      currentProxyVisibilityChanged: (visible) => trayWorkflows?.setCurrentProxyVisible(visible),
      proxyGroupsVisibilityChanged: (visible) => trayWorkflows?.setProxyGroupsVisible(visible),
      groupStyleChanged: (style) => trayWorkflows?.setGroupStyle(style),
      workflowMenuOpening: async () => {
        requireCompleteIdle()
        // These observations can invalidate the cached workflow menu. Finish
        // them before open() captures the new snapshot generation.
        await Promise.allSettled([
          ...(systemProxy.isBusy() ? [] : [systemProxy.inspect()]),
          ...(tunSession.state().pending ? [] : [tunSession.inspect()])
        ])
        await trayWorkflows?.open()
      },
      information: () => {
        const local = localProxy.state(),
          system = systemProxy.state(),
          tun = tunSession.state()
        return {
          mode:
            local.owned && !local.pending && !local.uncertain && local.phase === 'running'
              ? local.mode
              : undefined,
          systemProxy:
            !system.pending &&
            system.report?.recordID &&
            ['active', 'applied'].includes(system.report.status)
              ? true
              : !system.pending &&
                  system.report &&
                  !system.report.recordID &&
                  ['inactive', 'restored'].includes(system.report.status)
                ? false
                : undefined,
          tun:
            !tun.pending && tun.owned && tun.phase === 'active' && tun.traffic === 'forwarding'
              ? true
              : !tun.pending &&
                  !tun.owned &&
                  ['idle', 'prepared', 'restored', 'released'].includes(tun.phase)
                ? false
                : undefined
        }
      },
      directories: [
        ...[
          { label: 'Relay数据目录', path: stateContext().stateRoot },
          { label: '随包核心资源目录', path: coreRoot },
          { label: '应用日志目录', path: app.getPath('logs') }
        ].map(({ label, path }) => ({
          label,
          open: async () => {
            if (quitAfterRestore || shellQuitting) throw new Error('退出恢复正在进行。')
            await access(path)
            if (quitAfterRestore || shellQuitting) throw new Error('退出恢复正在进行。')
            const error = await shell.openPath(path)
            if (error) throw new Error('目录未能打开。')
          }
        })),
        ...[
          { label: '本次普通核心工作目录', owner: localProxy },
          { label: '本次 TUN 核心工作目录', owner: tunSession },
          {
            label: '持久核心工作目录',
            owner: ordinaryCoreOwner,
            canOpen: () => !retainedExitPending
          }
        ].map(({ label, owner, canOpen }) => ({
          label,
          capture: () => {
            if (canOpen?.() === false) return undefined
            const open = owner.captureWorkDirectory()
            if (!open) return undefined
            return async (assertAvailable: () => void) => {
              const check = (): void => {
                assertAvailable()
                if (canOpen?.() === false) throw new Error('持久代理交接正在进行。')
              }
              check()
              await open(async (path) => {
                check()
                const error = await shell.openPath(path)
                if (error) throw new Error('目录未能打开。')
              })
            }
          }
        }))
      ],
      preferences: {
        state: () => shellWorkflow.state(),
        save: async (settings, revision) => {
          if (quitAfterRestore || shellQuitting || loginItem.isBusy())
            throw new Error('退出或登录项操作尚未结束。')
          requireCompleteIdle()
          await shellWorkflow.save(settings, revision)
        },
        report: () => {
          if (window && !window.isDestroyed())
            void dialog
              .showMessageBox(window, {
                type: 'warning',
                title: '托盘操作未确认',
                message: '请在工作区核对窗口设置或目录状态；没有覆盖未知修改或自动重试。',
                buttons: ['返回工作区'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
              })
              .catch(() => {})
        }
      },
      perform: async (action) => {
        const outcome = await shellActions.perform(action)
        if (action === 'restartApp')
          return { status: outcome === 'cancelled' ? 'cancelled' : 'requested' }
        return undefined
      }
    })
    invalidateFloatingTraffic = () => shellHost.invalidateFloatingTraffic()
    const prepareSelectedTun = async (expected?: RelayProfileSelection) => {
      await profileStartup?.cancelAndWait()
      const current = coreOwnerIntent()
      const idle = (): void => {
        current()
        requireCompleteIdle()
        if (core.isBlocking() || clashBackend.isBusy())
          throw new Error('请先结束独立核心或配置操作。')
        assertTunLocalReady()
      }
      await waitForProfileInventory(current)
      idle()
      const selection = await coreSelection.read()
      idle()
      if (!selection) throw new Error('没有可用配置，请先导入或选择配置。')
      if (expected && (selection.id !== expected.id || selection.sha256 !== expected.sha256))
        throw new Error('所选配置已变化，未启用虚拟网卡。')
      const plan = await prepareTunConfiguration(selection)
      idle()
      if (plan.profileId !== selection.id || !plan.readyForParserCheck)
        throw new Error(plan.warnings.join(' ') || '当前配置缺少本地资源，未启用虚拟网卡。')
      const checked = await completeConfiguration.check({ evidenceId: plan.evidenceId })
      idle()
      if (checked.status !== 'passed' || checked.configurationSHA256 !== plan.configurationSHA256)
        throw new Error(checked.warnings.join(' ') || '当前配置检查未通过，未启用虚拟网卡。')
      const selected = await coreSelection.read()
      idle()
      if (selected?.id !== selection.id || selected.sha256 !== selection.sha256)
        throw new Error('所选配置已变化，未启用虚拟网卡。')
      const prepared = await prepareTunSession({ evidenceId: plan.evidenceId })
      try {
        idle()
        const after = await coreSelection.read()
        idle()
        if (after?.id !== selection.id || after.sha256 !== selection.sha256)
          throw new Error('所选配置已变化，未启用虚拟网卡。')
        return prepared
      } catch (error) {
        tunSession.cancel({ evidenceId: prepared.evidenceId })
        throw error
      }
    }
    const startSelectedTun = (input: { evidenceId: string }) => {
      requireCompleteIdle()
      if (core.isBlocking() || clashBackend.isBusy())
        throw new Error('独立核心或配置操作正在进行。')
      assertTunLocalReady()
      return tunHandoff.start(input)
    }
    const cancelSelectedTun = (input: { evidenceId: string }): void => {
      requireProfileSwitchIdle()
      tunHandoff.cancel(input.evidenceId)
      tunSession.cancel(input)
    }
    const profileSwitch = createTunProfileSwitch({
      owner: () => tunSession.proxyPageOwner(),
      state: () => tunSession.state(),
      local: () => localProxy.state(),
      ordinaryRecovery: () => tunHandoff.ordinaryRecovery(),
      readSelection: () => coreSelection.read(),
      readProfile: (selection) => profileStore.read(selection),
      choose: (selection) => clashBackend.invoke('changeCurrentProfile', [selection]),
      prepare: prepareSelectedTun,
      cancel: cancelSelectedTun,
      start: startSelectedTun,
      stop: stopTunSession
    })
    const switchTunProfile = (selection: RelayProfileSelection, owner: RelayProxyPageOwner) => {
      requireProfileSwitchIdle()
      if (pendingProxyChoices.size) throw new Error('请等待当前代理操作完成后再切换配置。')
      const token = Symbol('TUN profile switch')
      switchingToken = token
      const operation = switchingContext.run(token, async () => {
        const live = coreOwnerIntent()
        await profileStartup?.cancelAndWait()
        await waitForProfileInventory(live)
        live()
        requireCompleteIdle(false, false, false, false, false, false, {
          kind: 'tun-managed',
          sessionId: owner.instanceId
        })
        if (clashBackend.isBusy() || core.isBlocking())
          throw new Error('请等待当前代理操作完成后再切换配置。')
        await profileSwitch.run(selection, owner, live)
      })
      const settled = operation.finally(() => {
        switchingToken = undefined
        notifyTun()
        notifyClash()
      })
      return trackProxyChoice(settled)
    }
    const shellActions = createShellActions({
      assertAvailable: () => {
        if (
          quitAfterRestore ||
          shellQuitting ||
          backupService.isBusy() ||
          remoteBackup.isBusy() ||
          runtimeGist.isBusy() ||
          runtimeGistDiscovery.isBusy() ||
          overrideLibrary.isBusy() ||
          backupAccounts.isBusy() ||
          webdavBackupScheduler.isBusy()
        )
          throw new Error('退出或备份恢复正在进行。')
      },
      assertIdle: async (action, sessionId) => {
        if (action === 'triggerTun' && sessionId)
          requireCompleteIdle(false, false, false, false, false, false, {
            kind: 'tun-managed',
            sessionId
          })
        else if (action === 'triggerSysProxy')
          await waitForSystemProxyReadiness(coreOwnerIntent(false, false))
        else requireCompleteIdle()
      },
      showWindow: () => shellHost.showWindow(),
      showFloatingWindow: async () => {
        await shellHost.perform('showFloatingWindow')
      },
      quit: () => app.quit(),
      restart: () => restart.request(),
      runInBackground: async () => {
        await shellHost.perform('runInBackground')
      },
      copy: (text) => clipboard.writeText(text),
      environmentFormat: () => shellWorkflow.state().settings.environmentFormat,
      notify: notifyClash,
      local: {
        state: () => localProxy.state(),
        mode: async (instanceId, mode) => {
          await localProxy.action({ action: 'mode', instanceId, mode })
        }
      },
      systemProxy: {
        ...systemProxy,
        execute: executeUserSystemProxy,
        inspect: () => readSystemProxyForClick(coreOwnerIntent(false, false)),
        prepareApply: async (report) => {
          const current = coreOwnerIntent(false, false)
          const { httpPort, mixedPort } = await ensureSystemProxyListener(current)
          const saved = await systemProxyDraft.read(current)
          current()
          await waitForSystemProxyReadiness(current)
          const prepared = await systemProxy.prepare({
            ...saved.document,
            port: systemProxyInboundPort(httpPort, mixedPort, saved.document),
            serviceIDs: report.services
              .filter((service) => service.enabled)
              .map((service) => service.id)
          })
          try {
            current()
            await waitForSystemProxyReadiness(current)
            return prepared
          } catch (error) {
            systemProxy.cancel({ evidenceId: prepared.evidenceId })
            throw error
          }
        }
      },
      tun: {
        state: () => tunSession.state(),
        inspect: () => tunSession.inspect(),
        prepare: () => prepareSelectedTun(),
        start: startSelectedTun,
        cancel: cancelSelectedTun,
        stop: stopTunSession
      }
    })
    const shellWorkflow = createRelayShellService({
      store: new RelayShellStore(stateContext()),
      host: shellHost,
      pickTrayIcon: async (assertCurrent) => {
        const owner = window
        if (!owner || owner.isDestroyed()) return undefined
        const current = (): void => {
          assertCurrent()
          if (window !== owner || owner.isDestroyed() || owner.webContents.isDestroyed())
            throw new Error('图标选择所属窗口已变化。')
        }
        current()
        const chosen = await dialog.showOpenDialog(owner, {
          title: '选择托盘PNG图标（仅加入草稿）',
          properties: ['openFile'],
          filters: [{ name: 'PNG', extensions: ['png'] }]
        })
        current()
        if (chosen.canceled) return undefined
        if (chosen.filePaths.length !== 1 || !chosen.filePaths[0].toLowerCase().endsWith('.png'))
          throw new Error('请选择一个PNG图标。')
        const path = await realpath(chosen.filePaths[0])
        current()
        const bytes = await readBinaryResource(path, false, 256 * 1024)
        current()
        return normalizeTrayPNG(bytes)
      },
      pickCSS: async () => {
        if (!window) return undefined
        const chosen = await dialog.showOpenDialog(window, {
          title: '选择CSS文件（仅导入草稿）',
          properties: ['openFile'],
          filters: [{ name: 'CSS', extensions: ['css'] }]
        })
        if (chosen.canceled || chosen.filePaths.length !== 1) return undefined
        if (!chosen.filePaths[0].toLowerCase().endsWith('.css')) throw new Error('请选择CSS文件。')
        const bytes = await readBinaryResource(await realpath(chosen.filePaths[0]), false, 8192)
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      },
      pickThemeFiles: async (assertCurrent) => {
        const owner = window
        if (!owner || owner.isDestroyed()) return undefined
        const assertOwner = (): void => {
          assertCurrent()
          if (window !== owner || owner.isDestroyed() || owner.webContents.isDestroyed())
            throw new Error('主题文件选择所属窗口已变化。')
        }
        assertOwner()
        const chosen = await dialog.showOpenDialog(owner, {
          title: '选择CSS主题方案（仅加入库草稿）',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'CSS', extensions: ['css'] }]
        })
        assertOwner()
        if (chosen.canceled) return undefined
        if (!chosen.filePaths.length || chosen.filePaths.length > 16)
          throw new Error('一次最多导入16个CSS主题方案。')
        const themes: Pick<RelayShellTheme, 'name' | 'css'>[] = []
        for (const selected of chosen.filePaths) {
          if (!selected.toLowerCase().endsWith('.css')) throw new Error('请选择CSS文件。')
          const path = await realpath(selected)
          assertOwner()
          const bytes = await readBinaryResource(path, false, 8192)
          assertOwner()
          const css = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          const header = css.startsWith('/*')
            ? css.split('\n')[0].replace('/*', '').replace('*/', '').trim()
            : ''
          themes.push({ name: (header || basename(selected)).normalize('NFC'), css })
        }
        return themes
      },
      notify: () => {
        shellHost.refreshMenu()
        if (window && !window.isDestroyed()) window.webContents.send('relayShellUpdated')
        notifyUIPreferences()
      }
    })
    trayWorkflows = createTrayWorkflows({
      showCurrentProxyInTray: shellWorkflow.state().settings.showCurrentProxyInTray,
      proxyInTray: shellWorkflow.state().settings.proxyInTray,
      trayProxyGroupStyle: shellWorkflow.state().settings.trayProxyGroupStyle,
      local: () => localProxy.state(),
      assertIdle: () => requireSystemProxyIdle(),
      publish: (items) => shellHost.setWorkflowMenu(items),
      load: async () => {
        const state = localProxy.state()
        if (state.owned) {
          if (!state.instanceId) throw new Error('本次实例身份未确认。')
          const refreshed = await localProxy.action({
            action: 'refresh',
            instanceId: state.instanceId
          })
          if (refreshed.status !== 'refreshed') throw new Error('本次实例状态未确认。')
          if (window && !window.isDestroyed()) window.webContents.send('groupsUpdated')
        }
        const inventory = await profileStore.list()
        const selection: unknown = await clashBackend.invoke('getProfileConfig', [])
        const selectedId =
          selection &&
          typeof selection === 'object' &&
          'current' in selection &&
          typeof selection.current === 'string'
            ? selection.current
            : undefined
        return { local: localProxy.state(), profiles: inventory.profiles, selectedId }
      },
      chooseProfile: async (selection) => {
        const owner = tunSession.proxyPageOwner()
        if (owner) {
          shellHost.showWindow()
          return switchTunProfile(selection, owner)
        }
        await profileStartup?.cancelAndWait()
        requireCompleteIdle()
        shellHost.showWindow()
        const current = coreOwnerIntent()
        current()
        await profileStore.read(selection)
        current()
        const before = localProxy.state()
        if (
          before.pending ||
          before.uncertain ||
          (before.owned
            ? before.phase !== 'running' || before.traffic !== 'listening'
            : !relayProxyCanPrepare(before))
        )
          throw new Error('当前核心状态需要核对，未切换配置。')
        await clashBackend.invoke('changeCurrentProfile', [selection])
        current()
        if (!before.owned) {
          requireCompleteIdle()
          const savedPlan = await localProxyPlanStore.read(current)
          const plan = await localProxy.prepare({
            profile: selection,
            ...savedPlan.document,
            lifetime: 'main'
          })
          current()
          if (!plan.canStart) throw new Error(plan.warnings.join(' ') || '当前配置或端口尚未就绪。')
          const selected = await coreSelection.read()
          current()
          if (selected?.id !== selection.id || selected.sha256 !== selection.sha256)
            throw new Error('所选配置已变化，未启动旧配置。')
          if ((await localProxyPlanStore.read(current)).revision !== savedPlan.revision)
            throw new Error('启动设置已变化，请重新操作。')
          const result = await performLocalProxyAction(
            { action: 'start', evidenceId: plan.evidenceId },
            current
          )
          if (result.status !== 'started') throw new Error('配置启动未确认。')
        }
        const after = localProxy.state()
        if (
          !after.owned ||
          after.phase !== 'running' ||
          after.traffic !== 'listening' ||
          after.pending ||
          after.uncertain ||
          after.profileId !== selection.id
        )
          throw new Error('所选配置运行状态未确认。')
      },
      chooseNode: async (choice) => {
        const { instanceId, configurationRevision, group } = choice
        requireCompleteIdle()
        const state = localProxy.state()
        if (
          state.instanceId !== instanceId ||
          state.configurationRevision !== configurationRevision
        )
          throw new Error('菜单对应的实例或配置已变化。')
        const result = await localProxy.action(
          choice.action === 'automatic'
            ? { action: 'automatic', instanceId, group }
            : { action: 'select', instanceId, group, member: choice.member }
        )
        notifyClash()
        if (result.status !== 'selected' && result.status !== 'automatic')
          throw new Error('节点选择未确认。')
      },
      report: (message) => {
        if (window && !window.isDestroyed() && !quitAfterRestore) {
          shellHost.showWindow()
          void dialog
            .showMessageBox(window, {
              type: 'warning',
              title: '托盘操作未确认',
              message,
              buttons: ['返回工作区'],
              defaultId: 0,
              cancelId: 0
            })
            .catch(() => {})
        }
      }
    })
    const loginItem = createLoginItemService({
      identity: () => ({
        supported: process.platform === 'darwin' && app.isPackaged,
        executable: app.getPath('exe')
      }),
      read: () => loginRegistration.read(),
      write: (openAtLogin) => loginRegistration.write(openAtLogin),
      assertIdle: () => {
        if (
          quitAfterRestore ||
          shellQuitting ||
          backupService.isBusy() ||
          remoteBackup.isBusy() ||
          runtimeGist.isBusy() ||
          runtimeGistDiscovery.isBusy() ||
          overrideLibrary.isBusy() ||
          backupAccounts.isBusy() ||
          webdavBackupScheduler.isBusy() ||
          shellWorkflow.isBusy()
        )
          throw new Error('退出、备份或窗口设置操作尚未结束。')
      },
      confirm: async (_enabled) => {
        return actionWindowAvailable()
      }
    })
    const geometry = createWindowGeometryService({
      store: new RelayWindowStateStore(stateContext()),
      displays: () => screen.getAllDisplays(),
      primaryId: () => screen.getPrimaryDisplay().id
    })
    const geometryHost = createWindowGeometryHost({ geometry, screen })
    const backupStore = new RelayBackupStore(stateContext(), {
      moveExclusive: (request) => backupMoveNative(nativePath(), stateContext(), request),
      publishExclusive: (request) => backupPublishNative(nativePath(), stateContext(), request),
      publishFile: (request) => backupFileNative(nativePath(), stateContext(), request)
    })
    const legacyRelayMigration = createLegacyRelayMigration({ home: stateContext().home })
    let remoteRestoreDelegated = false
    const backupService = createBackupService({
      store: backupStore,
      assertKeyExportIdle: () => {
        if (
          quitAfterRestore ||
          shellQuitting ||
          remoteBackup.isBusy() ||
          runtimeGist.isBusy() ||
          runtimeGistDiscovery.isBusy() ||
          overrideLibrary.isBusy() ||
          runtimeGistSync.isBusy() ||
          webdavDirectory.isBusy() ||
          backupAccounts.isBusy() ||
          webdavBackupScheduler.isBusy()
        )
          throw new Error('退出或远程备份操作尚未结束。')
      },
      confirmKeyExport: async () => {
        return actionWindowAvailable()
      },
      writeKeyExport: async (bytes, isCurrent) => {
        if (!window) return false
        const selected = await dialog.showSaveDialog(window, {
          title: '保存新AGE私钥（请选择不存在的新文件名）',
          defaultPath: 'Relay-age-identity.txt',
          filters: [{ name: 'AGE私钥', extensions: ['txt'] }]
        })
        if (selected.canceled || !selected.filePath) return false
        if (!isCurrent() || quitAfterRestore || shellQuitting) return false
        await writeBackupKeyFile(selected.filePath, bytes)
        return true
      },
      afterRestore: async () => {
        invalidateSimpleRenderer()
        if (!restartCoordinator?.isFinalQuitInProgress()) restartCoordinator?.quitCancelled()
        onlineThemes?.cancel()
        webdavDirectory.cancel()
        runtimeGistDiscovery.invalidate()
        overrideLibrary.invalidate()
        await runtimeGistSync.stop('restored')
        await webdavBackupScheduler.dataRestored()
        backupAccounts.dataRestored()
        updates.cancel()
        geometryHost.invalidate()
        floatingGeometryHost.invalidate()
        completeConfiguration.cancel()
        await Promise.all([
          sourceScheduler.requestClose(),
          pluginScheduler.requestClose(),
          geoOrigins.requestClose(),
          geoScheduler.requestClose()
        ])
        remoteBackup.cancel()
        runtimeGist.cancel()
        subscriptions.clear()
        subscriptionSources.clear()
        providers.clear()
        resources.clear()
        profiles.clear()
        profileRuntime.clear()
        core.invalidatePending()
        localProxy.clear()
        tunSession.invalidatePending()
        variantService.cancelPreparation()
        edge.clear()
        recovery.clear()
        systemProxy.clear()
        configurationEdit.invalidateRuntimeCache()
        clashBackend.invalidateSelection()
        code.clear()
        artifacts.clear()
        diagnostics.clear()
        coreRecordRecovery.clear()
        await simple.afterRestore()
        await publication.afterRestore()
        await uiPreferences.initialize()
        await reloadAppLogSize()
        await shellWorkflow.initialize(false)
        if (window && !window.isDestroyed()) window.webContents.send('relayDataRestored')
        notifyClash()
      },
      assertIdle: () => {
        if (runtimeGistSync.isBusy() && !backupService.isBusy())
          throw new Error('运行配置自动同步尚未结束，请先停止同步再执行备份恢复。')
        if (webdavDirectory.isBusy() && !backupService.isBusy())
          throw new Error('WebDAV目录操作尚未结束。')
        requireCompleteIdle(false, true, false, remoteRestoreDelegated)
        if (
          updateWorkflowsBlocking() ||
          appUpdateBlocks() ||
          (!maintenanceAssertion && (!!maintenance?.isBusy() || localPreferencesBusy())) ||
          (!ownedResetAssertion && ownedResetService.isBlocking()) ||
          plugins.isBlocking() ||
          subStore.isBlocking() ||
          shellWorkflow.isBusy() ||
          loginItem.isBusy() ||
          trayWorkflows?.isBusy() ||
          geometryHost.state().pending ||
          floatingGeometryHost.state().pending ||
          (!remoteRestoreDelegated && (core.isBlocking() || localProxy.isBlocking())) ||
          clashBackend.isBusy()
        )
          throw new Error('请先结束本次核心或窗口设置操作，再执行备份恢复。')
      },
      assertLegacyRelayInspectionIdle: () => {
        if (runtimeGistSync.isBusy() || webdavDirectory.isBusy())
          throw new Error('请先结束运行配置同步或WebDAV目录操作。')
        const tun = tunSession.state(),
          source: RelayRuntimeGistSource | undefined =
            tun.owned &&
            !tun.pending &&
            tun.phase === 'active' &&
            tun.traffic === 'forwarding' &&
            tun.sessionId
              ? { kind: 'tun-managed', sessionId: tun.sessionId }
              : undefined
        requireCompleteIdle(false, true, false, false, false, false, source)
        if (
          shellQuitting ||
          subStore.isBlocking() ||
          core.state().pending ||
          localProxy.state().pending ||
          shellWorkflow.isBusy() ||
          loginItem.isBusy() ||
          trayWorkflows?.isBusy() ||
          geometryHost.state().pending ||
          floatingGeometryHost.state().pending ||
          clashBackend.isBusy()
        )
          throw new Error('请先结束核心、窗口或退出操作，再只读检查旧配置。')
      },
      pickImport: async (kind) => {
        if (!window) return undefined
        const selected = await dialog.showOpenDialog(window, {
          title: kind === 'legacy' ? '选择旧版Clash Party ZIP（仅检查迁移）' : '选择Relay私有备份',
          properties: ['openFile'],
          filters: [
            { name: kind === 'legacy' ? '旧版Clash Party备份' : 'Relay备份', extensions: ['zip'] }
          ]
        })
        if (selected.canceled || selected.filePaths.length !== 1) return undefined
        return readBinaryResource(await realpath(selected.filePaths[0]))
      },
      writeExport: async (bytes, isCurrent) => {
        if (!window || quitAfterRestore || shellQuitting) return false
        const selected = await dialog.showSaveDialog(window, {
          title: '导出Relay私有备份',
          defaultPath: 'Relay-private-backup.zip',
          filters: [{ name: 'Relay备份', extensions: ['zip'] }]
        })
        if (
          selected.canceled ||
          !selected.filePath ||
          !isCurrent() ||
          quitAfterRestore ||
          shellQuitting
        )
          return false
        await atomicWriteFile(selected.filePath, bytes, { mode: 0o600 })
        return true
      },
      confirmExport: async (_summary) => {
        return actionWindowAvailable()
      },
      prepareLegacyArchive: (bytes, baseline, proxyPort, signal) =>
        prepareLegacyMigrationRecord(
          stateContext(),
          bytes,
          baseline,
          proxyPort,
          signal,
          (request) => backupFileNative(nativePath(), stateContext(), request)
        ),
      confirmLegacyRelayInspect: async (_origin) => {
        if (!window) return false
        const recheck = runtimeGistContext()
        recheck()

        recheck()
        return true
      },
      inspectLegacyRelay: (request, signal) => legacyRelayMigration.inspect(request, signal),
      cancelLegacyRelayInspection: () => legacyRelayMigration.cancel(),
      prepareLegacyRelayArchive: (request, baseline, signal) =>
        prepareLegacyRelayMigrationRecord(
          stateContext(),
          baseline,
          signal,
          (file) => backupFileNative(nativePath(), stateContext(), file),
          (temporaryHome) =>
            legacyRelayMigration.prepare(request, { baseline, temporaryHome, signal })
        ),
      confirmRestore: async (_plan, migration) => {
        if (!actionWindowAvailable()) return false
        const relay = migration?.format === 'relay-legacy-profiles-v1' ? migration : undefined
        const recheckRelay = relay ? runtimeGistContext() : undefined
        recheckRelay?.()

        recheckRelay?.()
        return true
      },
      confirmRecovery: async (_plan) => {
        return actionWindowAvailable()
      }
    })
    let preparingBackupAccount: 'remote' | 'runtime' | undefined
    const remoteBackup = createRemoteBackupService({
      store: backupStore,
      prepareArchive: async (bytes, signal) => {
        remoteRestoreDelegated = true
        try {
          return await backupService.prepareArchive(bytes, signal)
        } finally {
          remoteRestoreDelegated = false
        }
      },
      prepareLegacyArchive: async (bytes, proxyPort, signal, sourceGuard) => {
        remoteRestoreDelegated = true
        try {
          return await backupService.prepareLegacyArchive(bytes, proxyPort, signal, sourceGuard)
        } finally {
          remoteRestoreDelegated = false
        }
      },
      assertIdle: () => {
        if (runtimeGistSync.isBusy()) throw new Error('运行配置自动同步尚未结束。')
        if (webdavDirectory.isBusy()) throw new Error('WebDAV目录操作尚未结束。')
        requireCompleteIdle(false, false, false, true, false, preparingBackupAccount === 'remote')
        if (
          subStore.isBlocking() ||
          core.state().pending ||
          localProxy.state().pending ||
          shellWorkflow.isBusy() ||
          loginItem.isBusy() ||
          trayWorkflows?.isBusy() ||
          clashBackend.isBusy()
        )
          throw new Error('请先结束核心、Sub-Store或窗口设置操作。')
      },
      confirmTransfer: async (_plan) => {
        return actionWindowAvailable()
      }
    })
    const runtimeGistContext = (requireVisible = true): (() => void) => {
      const owner = window,
        epoch = backupRendererEpoch,
        frame = (() => {
          try {
            return owner?.webContents.isDestroyed() ? undefined : owner?.webContents.mainFrame
          } catch {
            return undefined
          }
        })()
      return () => {
        try {
          if (
            owner &&
            frame &&
            window === owner &&
            !owner.isDestroyed() &&
            !owner.webContents.isDestroyed() &&
            (!requireVisible || owner.isVisible()) &&
            owner.webContents.mainFrame === frame &&
            backupRendererEpoch === epoch &&
            !quitAfterRestore &&
            !shellQuitting &&
            !coreOwnerBlocks()
          )
            return
        } catch {
          /* A destroyed or replaced frame is not a live authority. */
        }
        throw new Error('本次界面授权已失效。')
      }
    }
    const simpleHandlers = (event: Electron.IpcMainInvokeEvent) =>
      createSimpleHandlers({
        service: simple,
        profiles,
        authorize: () => {
          trusted(event)
          const assert = runtimeGistContext()
          return {
            isCurrent: () => {
              try {
                assert()
                return true
              } catch {
                return false
              }
            }
          }
        },
        assertIdle: () => {
          try {
            requireSubscriptionFinished()
            if (
              profiles.isBusy() ||
              simple.isBusy() ||
              runtimeGistSync.isBusy() ||
              webdavDirectory.isBusy()
            )
              throw new Error()
          } catch {
            throw new SimpleFailure('busy')
          }
        }
      })
    const publicationHandlers = (event: Electron.IpcMainInvokeEvent) =>
      createSimplePublicationHandlers({
        service: publication,
        authorize: () => {
          trusted(event)
          const assert = runtimeGistContext()
          return {
            isCurrent: () => {
              try {
                assert()
                return true
              } catch {
                return false
              }
            }
          }
        },
        assertOtherActorsIdle: () => {
          try {
            requireSubscriptionActorsFinished()
            if (
              profiles.isBusy() ||
              simple.isBusy() ||
              runtimeGistSync.isBusy() ||
              webdavDirectory.isBusy()
            )
              throw new Error()
          } catch {
            throw new SimpleFailure('busy')
          }
        }
      })
    const legacyRemoteContext = (input: unknown): (() => void) | undefined =>
      input &&
      typeof input === 'object' &&
      'archiveFormat' in input &&
      input.archiveFormat === 'legacy-zip'
        ? runtimeGistContext()
        : undefined
    const runtimeGist = createRuntimeGistService({
      assertRuntime: (expected) => {
        if (expected.source?.kind === 'tun-managed') {
          if (tunSession.state().sessionId !== expected.source.sessionId)
            throw new Error('本次TUN运行来源已变化。')
          tunSession.assertRuntime(expected)
          return
        }
        const current = localProxy.state(),
          expectedRuntime: unknown = JSON.parse(expected.configuration)
        if (
          !current.owned ||
          current.pending ||
          current.phase !== 'running' ||
          current.instanceId !== expected.instanceId ||
          current.configurationRevision !== expected.revision ||
          current.httpPort !== expected.proxyPort ||
          !plainConfigurationMap(expectedRuntime) ||
          (expectedRuntime.mode !== 'rule' &&
            expectedRuntime.mode !== 'global' &&
            expectedRuntime.mode !== 'direct') ||
          current.mode !== expectedRuntime.mode ||
          current.traffic === 'inactive'
        )
          throw new Error('本次自有运行配置在核对期间已变化。')
      },
      readRuntime: async (signal, source, expectedProxyPort) => {
        if (signal.aborted) throw new Error('已取消运行配置读取。')
        if (source?.kind === 'tun-managed') {
          if (tunSession.state().sessionId !== source.sessionId)
            throw new Error('本次TUN运行来源已变化。')
          const captured = await tunSession.captureRuntime(expectedProxyPort, signal)
          if (
            captured.status !== 'captured' ||
            captured.capture.snapshot.instanceId !== source.sessionId
          )
            throw new Error('没有支持读取且监听归属已确认的本次TUN运行配置。')
          return captured.capture.snapshot
        }
        const live = await localProxy.inspectLive()
        const current = localProxy.state()
        const revision = current.configurationRevision
        if (
          signal.aborted ||
          !live ||
          !revision ||
          !current.httpPort ||
          current.instanceId !== live.instanceId
        )
          throw new Error('没有已确认运行的本次本地代理配置。')
        return {
          instanceId: live.instanceId,
          revision,
          configuration: JSON.stringify(live.runtime, null, 2) + '\n',
          proxyPort: current.httpPort
        }
      },
      assertIdle: (source) => {
        if (runtimeGistSync.isBusy() || runtimeGistSync.state().enabled)
          throw new Error('请先停止运行配置自动同步，再准备或执行手动上传。')
        if (webdavDirectory.isBusy()) throw new Error('WebDAV目录操作尚未结束。')
        requireCompleteIdle(
          false,
          false,
          false,
          false,
          true,
          preparingBackupAccount === 'runtime',
          source
        )
        if (
          shellQuitting ||
          subStore.isBlocking() ||
          core.state().pending ||
          localProxy.state().pending ||
          shellWorkflow.isBusy() ||
          loginItem.isBusy() ||
          trayWorkflows?.isBusy() ||
          clashBackend.isBusy()
        )
          throw new Error('请先结束核心、窗口或退出操作。')
      },
      confirm: async (_plan) => {
        return actionWindowAvailable()
      }
    })
    const backupAccountsStore = new RelayBackupAccountsStore(stateContext(), {
      crypto: {
        available: async () => safeStorage.isEncryptionAvailable(),
        encrypt: async (text) => safeStorage.encryptString(text),
        decrypt: async (bytes) => safeStorage.decryptString(bytes)
      },
      createDirectory: async (request) =>
        (
          await backupFileNative(nativePath(), stateContext(), {
            namespace: 'backup-account',
            id: request.id,
            directoryIdentity: request.stateIdentity,
            name: '',
            directory: true,
            mode: 0o700,
            bytes: ''
          })
        ).identity,
      publish: async (request) => {
        await backupFileNative(nativePath(), stateContext(), {
          namespace: 'backup-account',
          id: request.id,
          directoryIdentity: request.directoryIdentity,
          name: request.name,
          mode: 0o600,
          bytes: request.bytes.toString('base64')
        })
      }
    })
    const webdavReceipts = new RelayWebdavReceiptStore(stateContext(), {
      createDirectory: async (request) =>
        (
          await backupFileNative(nativePath(), stateContext(), {
            namespace: 'backup-receipt',
            id: request.id,
            directoryIdentity: request.stateIdentity,
            name: '',
            directory: true,
            mode: 0o700,
            bytes: ''
          })
        ).identity,
      publish: async (request) => {
        await backupFileNative(nativePath(), stateContext(), {
          namespace: 'backup-receipt',
          id: request.id,
          directoryIdentity: request.directoryIdentity,
          name: request.name,
          mode: 0o600,
          bytes: request.bytes.toString('base64')
        })
      }
    })
    const backupAccounts = createBackupAccountsService({
      store: backupAccountsStore,
      assertListIdle: () => {
        if (!canRunWebdavBackup() || webdavBackupScheduler.isBusy())
          throw new Error('请先结束正在处理的数据或定时备份操作，再读取备份账号。')
      },
      assertIdle: () => {
        if (runtimeGistSync.isBusy()) throw new Error('运行配置自动同步尚未结束。')
        if (webdavDirectory.isBusy()) throw new Error('WebDAV目录操作尚未结束。')
        requireCompleteIdle(false, false, false, false, false, true)
        if (
          shellQuitting ||
          subStore.isBlocking() ||
          core.state().pending ||
          localProxy.state().pending ||
          shellWorkflow.isBusy() ||
          loginItem.isBusy() ||
          trayWorkflows?.isBusy() ||
          clashBackend.isBusy()
        )
          throw new Error('请先结束核心、窗口或退出操作。')
      },
      assertRuntimeIdle: (source) => {
        if (runtimeGistSync.isBusy() || runtimeGistSync.state().enabled)
          throw new Error('请先停止运行配置自动同步，再准备手动上传。')
        if (webdavDirectory.isBusy()) throw new Error('WebDAV目录操作尚未结束。')
        requireCompleteIdle(false, false, false, false, false, true, source)
        if (
          shellQuitting ||
          subStore.isBlocking() ||
          core.state().pending ||
          localProxy.state().pending ||
          shellWorkflow.isBusy() ||
          loginItem.isBusy() ||
          trayWorkflows?.isBusy() ||
          clashBackend.isBusy()
        )
          throw new Error('请先结束核心、窗口或退出操作。')
      },
      prepareRemote: async (request, recheck, assertContext) => {
        preparingBackupAccount = 'remote'
        try {
          return assertContext
            ? await remoteBackup.prepare(request, recheck, assertContext)
            : await remoteBackup.prepare(request, recheck)
        } finally {
          preparingBackupAccount = undefined
        }
      },
      prepareRuntime: async (request, recheck, assertContext) => {
        preparingBackupAccount = 'runtime'
        try {
          return await runtimeGist.prepare(request, recheck, assertContext)
        } finally {
          preparingBackupAccount = undefined
        }
      },
      cancelRemote: () => remoteBackup.cancel(),
      cancelRuntime: () => runtimeGist.cancel()
    })
    const runtimeGistDiscovery = createRuntimeGistDiscoveryService({
      store: backupAccountsStore,
      assertIdle: () => {
        if (!canRunWebdavBackup(false, false, true) || webdavBackupScheduler.isBusy())
          throw new Error('请先结束正在处理的数据、核心转换或备份操作，再查找运行Gist候选。')
      },
      confirm: async (_plan) => {
        return actionWindowAvailable()
      }
    })
    const canRunWebdavBackup = (
      allowRuntimeSync = false,
      allowDirectory = false,
      allowRuntimeDiscovery = false,
      allowOverrideLibrary = false,
      allowGeoOrigins = false
    ): boolean => {
      const coreState = core.state(),
        proxy = localProxy.state(),
        tun = tunSession.state()
      return (
        !automaticUninstallRequested &&
        !subStoreNetworkBusy &&
        !isolatedProbes?.isBlocking() &&
        !quitAfterRestore &&
        !shellQuitting &&
        !updateWorkflowsBlocking() &&
        !(configurationEdit.isBusy() || simple.isBusy() || publication.isBusy()) &&
        !plugins.isBusy() &&
        !pluginScheduler.isBusy() &&
        !remoteBackup.isBusy() &&
        !runtimeGist.isBusy() &&
        (allowRuntimeDiscovery || !runtimeGistDiscovery.isBusy()) &&
        (allowOverrideLibrary || !overrideLibrary.isBusy()) &&
        (allowRuntimeSync || !runtimeGistSync.isBusy()) &&
        (allowDirectory || !webdavDirectory.isBusy()) &&
        !backupAccounts.isBusy() &&
        !backupService.isBusy() &&
        !sourceScheduler.isBusy() &&
        !subscriptionSources.isBusy() &&
        !subscriptions.isBusy() &&
        !providers.isBusy() &&
        !resources.isBusy() &&
        (allowGeoOrigins || !geoOrigins.isBusy()) &&
        !geoScheduler.isBusy() &&
        !edge.isBusy() &&
        !desktop.isBlocking() &&
        !code.isApplying() &&
        !recovery.isRestoring() &&
        !profiles.isBusy() &&
        !profileRuntime.isBusy() &&
        !completeConfiguration.isBusy() &&
        !coreRecordRecovery.isBusy() &&
        !systemProxy.isBusy() &&
        !variantService.isBusy() &&
        !subStore.isBlocking() &&
        !shellWorkflow.isBusy() &&
        !loginItem.isBusy() &&
        !trayWorkflows?.isBusy() &&
        !geometryHost.state().pending &&
        !floatingGeometryHost.state().pending &&
        !clashBackend.isBusy() &&
        !coreState.pending &&
        !coreState.uncertain &&
        (!coreState.owned || coreState.phase === 'running') &&
        !proxy.pending &&
        !proxy.uncertain &&
        (!proxy.owned || (proxy.phase === 'running' && proxy.traffic === 'listening')) &&
        !tun.pending &&
        tun.phase !== 'uncertain' &&
        (!tun.owned || (tun.phase === 'active' && tun.traffic === 'forwarding'))
      )
    }
    const webdavBackupScheduler = createWebdavBackupScheduler({
      accounts: backupAccountsStore,
      backups: backupStore,
      receipts: webdavReceipts,
      canRun: canRunWebdavBackup,
      authorize: async (scope) => {
        const ownerWindow = window,
          rendererEpoch = backupRendererEpoch,
          frame = (() => {
            try {
              return ownerWindow?.webContents.isDestroyed()
                ? undefined
                : ownerWindow?.webContents.mainFrame
            } catch {
              return undefined
            }
          })()
        let revoked = false
        const isLive = (): boolean => {
          try {
            return (
              !revoked &&
              !!ownerWindow &&
              !!frame &&
              window === ownerWindow &&
              !ownerWindow.isDestroyed() &&
              !ownerWindow.webContents.isDestroyed() &&
              ownerWindow.isVisible() &&
              ownerWindow.webContents.mainFrame === frame &&
              backupRendererEpoch === rendererEpoch &&
              !quitAfterRestore &&
              !shellQuitting
            )
          } catch {
            return false
          }
        }
        if (!ownerWindow || !isLive() || !canRunWebdavBackup()) return undefined
        const retention = scope.retention,
          recorded = retention?.kind === 'recorded-owned'
        if (scope.delete !== !!retention || recorded !== !!scope.history) return undefined
        const permission = structuredClone(scope)

        if (!isLive() || !canRunWebdavBackup()) return undefined
        const live = (signal: AbortSignal): void => {
          if (
            signal.aborted ||
            !isLive() ||
            !canRunWebdavBackup() ||
            Intl.DateTimeFormat().resolvedOptions().timeZone !== permission.timeZone
          )
            throw new Error('本次定时备份授权已失效。')
        }
        return {
          permission: structuredClone(permission),
          isLive,
          async credential(signal: AbortSignal) {
            live(signal)
            const selected = { id: permission.id, revision: permission.revision }
            const before = await backupAccountsStore.read(selected)
            live(signal)
            if (!matchesWebdavBackupAccount(before, permission))
              throw new Error('定时备份账号已变化。')
            const credential = await backupAccountsStore.credential(selected)
            live(signal)
            const after = await backupAccountsStore.read(selected)
            live(signal)
            if (
              !matchesWebdavBackupAccount(credential.account, permission) ||
              !matchesWebdavBackupAccount(after, permission)
            )
              throw new Error('定时备份账号或凭据范围已变化。')
            return credential
          },
          revoke: () => {
            revoked = true
          }
        }
      }
    })
    const canRunRuntimeGistSync = (): boolean =>
      canRunWebdavBackup(true) && !webdavBackupScheduler.isBusy()
    const runtimeGistSync = createRuntimeGistSyncService({
      accounts: backupAccountsStore,
      captureRuntime: async (signal, source, expectedProxyPort) => {
        if (source?.kind !== 'tun-managed') return localProxy.captureRuntime(signal)
        if (tunSession.state().sessionId !== source.sessionId) return { status: 'unavailable' }
        const captured = await tunSession.captureRuntime(expectedProxyPort, signal)
        return captured.status === 'captured' &&
          captured.capture.snapshot.instanceId !== source.sessionId
          ? { status: 'unavailable' }
          : captured
      },
      canRun: canRunRuntimeGistSync,
      authorize: async (scope) => {
        const ownerWindow = window,
          rendererEpoch = backupRendererEpoch,
          frame = (() => {
            try {
              return ownerWindow?.webContents.isDestroyed()
                ? undefined
                : ownerWindow?.webContents.mainFrame
            } catch {
              return undefined
            }
          })()
        let revoked = false
        const isLive = (): boolean => {
          try {
            return (
              !revoked &&
              !!ownerWindow &&
              !!frame &&
              window === ownerWindow &&
              !ownerWindow.isDestroyed() &&
              !ownerWindow.webContents.isDestroyed() &&
              ownerWindow.isVisible() &&
              ownerWindow.webContents.mainFrame === frame &&
              backupRendererEpoch === rendererEpoch &&
              !quitAfterRestore &&
              !shellQuitting
            )
          } catch {
            return false
          }
        }
        if (!ownerWindow || !isLive() || !canRunRuntimeGistSync()) return undefined
        const permission = structuredClone(scope)

        if (!isLive() || !canRunRuntimeGistSync()) return undefined
        const live = (signal: AbortSignal): void => {
          if (signal.aborted || !isLive()) throw new Error('本次自动同步授权已失效。')
        }
        return {
          permission: structuredClone(permission),
          isLive,
          async credential(signal: AbortSignal) {
            live(signal)
            const selected = { id: permission.id, revision: permission.revision },
              before = await backupAccountsStore.read(selected)
            live(signal)
            if (!matchesRuntimeGistSyncAccount(before, permission))
              throw new Error('自动同步账号已变化。')
            const credential = await backupAccountsStore.credential(selected)
            live(signal)
            const after = await backupAccountsStore.read(selected)
            live(signal)
            if (
              !matchesRuntimeGistSyncAccount(credential.account, permission) ||
              !matchesRuntimeGistSyncAccount(after, permission)
            )
              throw new Error('自动同步账号或凭据范围已变化。')
            return credential
          },
          revoke: () => {
            revoked = true
          }
        }
      }
    })
    const webdavDirectory = createWebdavDirectoryService({
      accounts: backupAccountsStore,
      assertIdle: () => {
        if (!canRunWebdavBackup(false, true) || webdavBackupScheduler.isBusy())
          throw new Error('请先结束正在处理的数据或备份操作，再检查或创建WebDAV目录。')
      },
      confirm: async (_plan) => {
        const ownerWindow = window,
          rendererEpoch = backupRendererEpoch
        const live = (): boolean => {
          try {
            return (
              !!ownerWindow &&
              window === ownerWindow &&
              !ownerWindow.isDestroyed() &&
              !ownerWindow.webContents.isDestroyed() &&
              ownerWindow.isVisible() &&
              backupRendererEpoch === rendererEpoch &&
              !quitAfterRestore &&
              !shellQuitting
            )
          } catch {
            return false
          }
        }
        if (!ownerWindow || !live()) return false

        return live()
      }
    })
    const onRuntimeGistSuspend = (): void => runtimeGist.cancel()
    const onBackupSuspend = (): void => {
      appUpdates?.cancel()
      if (!restartCoordinator?.isFinalQuitInProgress()) restartCoordinator?.quitCancelled()
      onlineThemes?.cancel()
      invalidateRendererEpochs()
      invalidateSimpleRenderer()
      tunSession.invalidateRules()
      tunSession.invalidateResources()
      void geoOrigins.requestClose()
      void runtimeGistSync.stop('suspended')
      webdavDirectory.cancel()
      runtimeGistDiscovery.invalidate()
      overrideLibrary.invalidate()
      backupService.invalidatePending()
      backupAccounts.cancel()
      void webdavBackupScheduler.suspend()
    }
    powerMonitor.on('suspend', onRuntimeGistSuspend)
    powerMonitor.on('suspend', onBackupSuspend)
    const settleNoLaunchCoreOwnerReferences = (): void => {
      if (!ordinaryCoreOwner.noLaunchRetirementPending() || localProxy.state().pending) return
      if (localProxy.state().owned) localProxy.acknowledgeRetiredPersistentOwner()
      ordinaryCoreOwner.acknowledgeNoLaunchRetirement()
    }
    const coreOwnerIntent = (
      finalQuit = false,
      requireVisible = true,
      currentEpoch = () => backupRendererEpoch
    ): (() => void) => {
      const owner = window,
        epoch = currentEpoch(),
        frame = owner?.webContents.mainFrame
      return () => {
        if (
          !owner ||
          !frame ||
          owner !== window ||
          owner.isDestroyed() ||
          owner.webContents.isDestroyed() ||
          (requireVisible && !owner.isVisible()) ||
          owner.webContents.mainFrame !== frame ||
          epoch !== currentEpoch() ||
          (!finalQuit && (quitAfterRestore || shellQuitting))
        )
          throw new Error('持久代理的本次界面授权已失效。')
      }
    }
    const assertCoreOwnerSideIdle = async (live: () => void, deadOwner = false): Promise<void> => {
      const synchronous = (): void => {
        live()
        const previous = retainedExitAssertion
        retainedExitAssertion = true
        try {
          requireCompleteIdle()
          if (
            core.isBlocking() ||
            scopedCLI?.isBlocking() ||
            subStore.isBlocking() ||
            desktop.isBlocking() ||
            systemProxy.isBlocking() ||
            tunSession.isBlocking() ||
            library.isBusy() ||
            localProxy.state().pending ||
            (localProxy.state().uncertain &&
              !(deadOwner && localProxy.state().lifetime === 'persistent')) ||
            clashBackend.isBusy() ||
            shellWorkflow.isBusy() ||
            loginItem.isBusy() ||
            trayWorkflows?.isBusy() ||
            runtimeGistSync.state().enabled ||
            sourceScheduler.state().entries.some((entry) => entry.enabled) ||
            pluginScheduler.state().entries.some((entry) => entry.enabled) ||
            geoScheduler.state().entries.some((entry) => entry.enabled) ||
            webdavBackupScheduler.state().entries.some((entry) => entry.enabled)
          )
            throw new Error('有活动会话、自动任务或写入者，不能无损交接退出；请通过原入口处理。')
        } finally {
          retainedExitAssertion = previous
        }
      }
      synchronous()
      if (
        !(await inspectOtherAuxiliaryOwnedActorsIdle(stateContext())) ||
        (await new RelayBackupStore(stateContext()).unresolved()).length
      )
        throw new Error('存在未收尾的独立Core/CLI/备份记录。')
      live()
      const installed = await readTunInstallation('core-managed')
      if (!installed) throw new Error('尚无只读TUN事实来源，保留Main。')
      const system = await systemProxy.inspect()
      live()
      const readiness = await desktopReadinessNative(nativePath(), stateContext())
      live()
      const native = await inspectTunNative(installed)
      live()
      const guard = await guardManagement?.inspectActivity()
      live()
      const desk = desktop.state(),
        sub = await subStore.inspect(),
        tun = tunSession.state()
      if (
        system.recordID ||
        system.canRestore ||
        !['inactive', 'restored'].includes(system.status) ||
        system.services.some(
          (service) =>
            service.enabled && (service.http || service.https || service.socks || service.pac)
        ) ||
        systemProxy.state().pacServersRetained ||
        readiness.records.length !== 2 ||
        new Set(readiness.records.map((record) => record.source)).size !== 2 ||
        readiness.records.some((record) => record.state !== 'missing' || record.phase !== 'none') ||
        desk.host !== 'absent' ||
        desk.uncertain ||
        desk.pending ||
        (desk.snapshot &&
          (desk.snapshot.phase !== 'idle' || desk.snapshot.hasRecord || desk.snapshot.busy)) ||
        native.helper.identity !== 'authenticated' ||
        native.network.state !== 'observed' ||
        native.network.existingTunnel !== 'none' ||
        tun.owned ||
        tun.pending ||
        !['idle', 'restored', 'prepared', 'released'].includes(tun.phase) ||
        guard !== 'inactive' ||
        sub.recovery ||
        sub.pid ||
        sub.pending ||
        ['running', 'starting', 'stopping', 'uncertain'].includes(sub.phase)
      )
        throw new Error('网络/恢复归属不是明确空闲，不能退出并保留Core。')
      synchronous()
    }
    const confirmCoreOwner = async (
      live: () => void,
      action: 'detach' | 'reattach' | 'stop' | 'archive' | 'finalize'
    ): Promise<boolean> => {
      live()
      const owner = window
      if (!owner) return false
      if (action === 'finalize') {
        const state = ordinaryCoreOwner.state()
        if (state.phase !== 'closed' || !state.canFinalize)
          throw new Error('尚无已接回的实际退出事实，请先明确检查。')

        live()
        return true
      }
      if (action === 'archive') {
        live()
        return true
      }

      live()
      return true
    }
    const quitWithoutCore = async (): Promise<ReturnType<typeof ordinaryCoreOwner.state>> => {
      if (retainedExitPending || !ordinaryCoreOwner.state().canDetach)
        throw new Error('只有未来持久owner的明确运行实例可以交接退出；现有Main子Core不迁移。')
      const live = coreOwnerIntent()
      retainedExitPending = true
      try {
        await assertCoreOwnerSideIdle(live)
        if (!(await confirmCoreOwner(live, 'detach'))) return ordinaryCoreOwner.state()
        live()
        const pass = await ordinaryCoreOwner.detach(live, () => assertCoreOwnerSideIdle(live))
        // Commit is already durable. Failure/cancel below retains detached state;
        // it must never enter the ordinary quit drain or call localProxy.stop.
        localProxy.cancelTraffic()
        trafficHistory?.invalidate()
        await flushWindowGeometryForExit(backupStore, geometryHost, floatingGeometryHost)
        await library.whenIdle()
        await trafficHistory?.requestClose()
        await ordinaryCoreOwner.verifyCommitted(pass, live)
        live()
        if (!ordinaryCoreOwner.committed(pass)) throw new Error('持久交接事实已变化，保留Main。')
        retainedExitPassLive = coreOwnerIntent(true)
        retainedExitPass = Object.freeze(pass)
        ordinaryCoreOwner.unrefCommitted()
        app.quit()
        return ordinaryCoreOwner.state()
      } finally {
        retainedExitPending = false
      }
    }
    const admitsRetainedQuit = (): boolean => {
      try {
        retainedExitPassLive?.()
        return (
          !!retainedExitPassLive &&
          !!retainedExitPass &&
          ordinaryCoreOwner.committed(retainedExitPass)
        )
      } catch {
        return false
      }
    }
    app.on('before-quit', (event) => {
      if (admitsRetainedQuit()) {
        shellQuitting = true
        queueMicrotask(() => {
          if (event.defaultPrevented) recoverCancelledQuit()
        })
        return
      }
      if (
        retainedExitPending ||
        ordinaryCoreOwner.isOperating() ||
        ordinaryCoreOwner.retained() ||
        (ordinaryCoreOwner.isBlocking() && !ordinaryCoreOwner.ownsLocalInstance())
      ) {
        event.preventDefault()
        retainedExitPass = undefined
        shellHost.showWindow()
        return
      }
      appUpdates?.cancel()
      maintenance?.cancel()
      ownedResetService.invalidate()
      const kind = restart.beforeQuit()
      if (kind === 'ordinary') ordinaryQuitRequested = true
      const generation = restart.state().generation
      let drainingHere = false
      queueMicrotask(() => {
        if (!drainingHere && event.defaultPrevented) recoverCancelledQuit(generation)
      })
      onlineThemes?.cancel()
      trafficHistory?.invalidate()
      geometryHost.capture()
      floatingGeometryHost.capture()
      shellQuitting = true
      // Do not interrupt an admitted backup restore; its drain retires Simple.
      if (!backupService.isBusy()) invalidateSimpleRenderer()
      tunSession.invalidateRules()
      tunSession.invalidateResources()
      geoOrigins.cancel()
      if (
        (automaticUninstallRequested && !finalQuitPassedSystemProxy) ||
        (geometryHost.state().writable &&
          (geometryHost.state().dirty || geometryHost.state().pending)) ||
        (floatingGeometryHost.state().writable &&
          (floatingGeometryHost.state().dirty || floatingGeometryHost.state().pending)) ||
        updates.isBusy() ||
        extendedWorkflowBusy() ||
        !!appUpdates?.isBusy() ||
        (!maintenanceAssertion && (!!maintenance?.isBusy() || localPreferencesBusy())) ||
        (!ownedResetAssertion && ownedResetService.isBusy()) ||
        plugins.isBlocking() ||
        pluginScheduler.isBlocking() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy() ||
        runtimeGistDiscovery.isBusy() ||
        overrideLibrary.isBusy() ||
        runtimeGistSync.isBusy() ||
        webdavDirectory.isBusy() ||
        backupAccounts.isBusy() ||
        webdavBackupScheduler.isBusy() ||
        configurationEdit.isBusy() ||
        simple.isBusy() ||
        publication.isBusy() ||
        subStore.isBlocking() ||
        backupService.isBusy() ||
        shellWorkflow.isBusy() ||
        isolatedProbes?.isBlocking() ||
        library.isBusy() ||
        trafficHistory?.isBlocking() ||
        loginItem.isBusy() ||
        trayWorkflows?.isBusy() ||
        variantService.isBusy() ||
        recovery.isRestoring() ||
        code.isApplying() ||
        desktop.isBlocking() ||
        edge.isBusy() ||
        core.isBlocking() ||
        profiles.isBusy() ||
        subscriptions.isBusy() ||
        providers.isBusy() ||
        subscriptionSources.isBusy() ||
        sourceScheduler.isBusy() ||
        resources.isBusy() ||
        geoOrigins.isBusy() ||
        geoScheduler.isBusy() ||
        profileRuntime.isBusy() ||
        completeConfiguration.isBusy() ||
        coreRecordRecovery.isBusy() ||
        clashBackend.isBusy() ||
        terminalCLI?.isBlocking() ||
        localProxy.isBlocking() ||
        tunSession.isBlocking() ||
        (!finalQuitPassedSystemProxy && systemProxy.isBlocking())
      ) {
        event.preventDefault()
        drainingHere = true
        shellQuitting = false
        waitToQuit()
      }
    })
    app.on('will-quit', (event) => {
      const generation = restart.state().generation
      queueMicrotask(() => {
        if (event.defaultPrevented) recoverCancelledQuit(generation)
      })
    })
    app.on('quit', (_event, exitCode) => {
      // Cleanup is best effort on final exit only; a cancelled quit must keep
      // the live channel. Stale discovery files cannot authenticate a dead peer.
      void browserBinding.dispose()
      disposeAppUpdateIPC?.()
      if (restart.onFinalQuit(exitCode) === 'schedule-failed')
        console.error('Relay重新打开未能安排；没有自动重试。')
    })
    const artifacts = createArtifactService({
      configuration: (input) => previewNative(nativePath(), input),
      simulation: () => simulateNative(nativePath()),
      edgeProfile: () => edgeProfileNative(nativePath()),
      guardPlan: (node, evidenceId) => diagnostics.guardPlan(node, evidenceId),
      readPreferences: () => readPreferencesNative(nativePath(), stateContext()),
      savePreferences: (preferences, revision) => {
        requireSubscriptionFinished()
        if (edge.isBusy()) throw new Error('Edge 操作尚未结束。')
        if (desktop.isBlocking()) throw new Error('桌面登录或恢复尚未结束。')
        if (code.isApplying() || recovery.isRestoring()) throw new Error('配置或恢复事务尚未结束。')
        code.clear()
        return savePreferencesNative(nativePath(), { preferences, revision }, stateContext())
      },
      handoff: async () => {
        try {
          const content = await readFile(runtime.handoffDocument, 'utf8')
          if (Buffer.byteLength(content) > 1048576) throw new Error()
          return content
        } catch {
          throw new Error('内置交接文档不可用，请检查资源打包。')
        }
      },
      copy: (content) => clipboard.writeText(content),
      chooseSave: async (filename) => {
        if (!window) return undefined
        const result = await dialog.showSaveDialog(window, {
          title: '导出生成文本（不应用配置）',
          defaultPath: filename,
          buttonLabel: '导出文本',
          properties: ['showOverwriteConfirmation']
        })
        return result.canceled ? undefined : result.filePath
      },
      write: (destination, content) => atomicWriteFile(destination, content, { mode: 0o600 })
    })
    const special = new Set([
      ...RELAY_UI_PREFERENCES_CHANNELS,
      'relayOpenUpstreamReference',
      ...RELAY_MAINTENANCE_CHANNELS,
      ...RELAY_OWNED_RESET_CHANNELS,
      ...RELAY_SIMPLE_CHANNELS,
      ...RELAY_SIMPLE_SOURCE_CHANNELS,
      ...RELAY_SIMPLE_CONFIGURATION_CHANNELS,
      ...RELAY_SIMPLE_PUBLICATION_CHANNELS,
      'relayStatus',
      'relayGuardReadiness',
      'relayGuardManagementState',
      'relayGuardManagementAction',
      'relayGuardScopedCLIState',
      'relayGuardScopedCLILaunch',
      'relayGuardScopedCLIStop',
      'relayGuardScopedStorage',
      'relayCoreState',
      'relayCorePrepare',
      'relayCoreAction',
      'relayProfilePrepare',
      'relayProfileNewPrepare',
      'relayProfileExport',
      'relayProfileNodesRead',
      'relayProfileNodesPrepare',
      'relayProfileGroupsRead',
      'relayProfileGroupSelect',
      'relayProfileGroupsPrepare',
      'relayProfileRulesRead',
      'relayProfileRulesPrepare',
      'relayProfileRuleProvidersRead',
      'relayProfileRuleProvidersPrepare',
      'relayProfileRuleSnapshotPrepare',
      'relayProfileSave',
      'relayProfileList',
      'relayLibraryList',
      'relayLibraryChange',
      'relaySubscriptionPrepare',
      'relaySubscriptionDownload',
      'relaySubscriptionSave',
      'relaySubscriptionCancel',
      'relaySubscriptionState',
      'relayResourceList',
      'relayResourcePreview',
      'relayResourcePrepare',
      'relayResourceAcquire',
      'relayResourceCheck',
      'relayResourceCancel',
      'relayResourceState',
      'relayGeoScheduleState',
      'relayGeoScheduleArm',
      'relayGeoScheduleDisarm',
      'relayGeoOriginList',
      'relayGeoOriginRead',
      'relayGeoOriginSave',
      'relayGeoOriginFetch',
      'relayGeoOriginState',
      'relayGeoOriginCancel',

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
      'relayProfileRuntimePrepare',
      'relayProfileRuntimeCheck',
      'relayCompleteConfigurationPrepare',
      'relayCompleteConfigurationCheck',
      'relayCompleteConfigurationCancel',
      'relayTunStatus',
      'relayTunConfigurationPrepare',
      'relayTunPrepare',
      'relayTunStart',
      'relayTunProfileSwitch',
      'relayTunCancel',
      'relayTunStop',
      'relayTunRecoverOrdinary',
      'relayTunInspect',
      'relayTunRulesRead',
      'relayTunRuleChange',
      'relayTunResourcesRead',
      'relayTunResourceReplace',
      'relayTunRuleProvidersRead',
      'relayTunRuleProviderReplace',
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
      'relayConfigEditRead',
      'relayConfigEditSave',
      'relayConfigEditClear',
      'relayConfigEditPreview',
      'relayConfigEditPrepare',
      'relayUpdateState',
      'relayUpdatePrepare',
      'relayUpdateExecute',
      'relayUpdateCancel',
      'relayUpdateRemove',
      'relayUpdateImportVariant',
      'relayUpdateApplySubStore',
      'relayPluginScheduleState',
      'relayPluginScheduleArm',
      'relayPluginScheduleDisarm',
      'relayPluginState',
      'relayPluginPreview',
      'relayPluginPreviewFile',
      'relayPluginPreviewOpened',
      'relayPluginOpenedPending',
      'relayPluginInstall',
      'relayPluginLogin',
      'relayPluginUpdate',
      'relayPluginRediscover',
      'relayPluginSaveProfile',
      'relayPluginRemove',
      'relayPluginCancel',
      'relaySubStoreRecover',
      'relaySubStoreState',
      'relaySubStoreAcquire',
      'relaySubStoreAdvancedAcquire',
      'relaySubStoreAdvancedStart',
      'relaySubStoreStart',
      'relaySubStoreStop',
      'relaySubStoreOpen',
      'relaySubStoreList',
      'relaySubStoreConvert',
      'relaySubStoreSave',
      'relaySubStoreCancel',
      'relayBackupRemotePrepare',
      'relayBackupRemoteExecute',
      'relayBackupRemoteCancel',
      'relayRuntimeGistPrepare',
      'relayRuntimeGistExecute',
      'relayRuntimeGistCancel',
      'relayRuntimeGistDiscoveryPrepare',
      'relayRuntimeGistDiscoveryExecute',
      'relayRuntimeGistDiscoveryCancel',
      'relayRuntimeGistSyncState',
      'relayRuntimeGistSyncArm',
      'relayRuntimeGistSyncStop',
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
      'relayBackupExport',
      'relayBackupKeyExport',
      'relayBackupImportPrepare',
      'relayBackupLegacyPrepare',
      'relayBackupLegacyRelayInspect',
      'relayBackupLegacyRelayPrepare',
      'relayBackupRestore',
      'relayBackupCancel',
      'relayBackupRecoveryList',
      'relayBackupRecoveryPrepare',
      'relayBackupRecoveryCommit',
      'relayBackupRecoveryCancel',
      'checkAutoRun',
      'enableAutoRun',
      'disableAutoRun',
      'queryTrafficUsageOverview',
      'queryTrafficUsageBreakdown',
      'importTrafficUsage',
      'clearTrafficUsage',
      'relayTrafficHistoryState',
      'relayTrafficHistoryReadTun',
      'relayTrafficHistoryRecord',
      'relayTrafficHistoryStop',
      'relayTrafficHistoryRetry',
      'relayTrafficHistoryImportAuthorize',
      'relayShellCSSImport',
      'relayShellThemeFilesImport',
      'relayShellTrayIconImport',
      'getTrayTrafficStyle',
      'relayTrayTrafficFrame',
      'relayShellState',
      'relayShellInitialize',
      'relayShellSave',
      'relayShellAction',
      'relayVariantState',
      'relayVariantPrepare',
      'relayVariantExecute',
      'relayVariantSelect',
      'relayVariantRestore',
      'relayVariantRemove',
      'relayProviderResourceList',
      'relayCoreOwnerState',
      'relayCoreOwnerAction',
      'quitWithoutCore',
      'relayProxyPageOwner',
      'relayLocalProxyState',
      ...RELAY_LOCAL_PROXY_PLAN_CHANNELS,
      'relayLocalProxyPrepare',
      'relayLocalProxyAction',
      'relaySmartTools',
      'relayLocalProxyReloadPrepare',
      'relayLocalProxyReload',
      'relayDedicatedInspect',
      'relayIsolatedProbeTargets',
      'relayIsolatedProbePrepare',
      'relayIsolatedProbeRun',
      'relayIsolatedProbeCancel',
      'relayIsolatedProbeCleanup',
      'relayIsolatedProbeState',
      'relayConnections',
      'relayConnectionAppInfo',
      'relayLogs',
      'relayLogSnapshot',
      'relayRuntimeInfo',
      'relayCoreLifecycleState',
      'relayCoreLifecycleCheck',
      'relayCoreRecordPrepare',
      'relayCoreRecordArchive',
      'relaySystemProxyDraftRead',
      'relaySystemProxyDraftSave',
      'relaySystemProxyInspect',
      'relayEnsureSystemProxyListener',
      'relaySystemProxyPrepare',
      'relaySystemProxyRestorePrepare',
      'relaySystemProxyExecute',
      'relaySystemProxyState',
      'relaySystemProxyCancel',
      'relayPreview',
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
      'relayEdgeEntryOpen',
      'relaunchApp',
      'quitApp',
      'openDevTools'
    ])
    const proxyPageOwner = () => {
      const tun = tunSession.proxyPageOwner()
      if (tun) return tun
      const state = localProxy.state()
      if (
        tunSession.isBlocking() ||
        !state.owned ||
        state.pending ||
        state.uncertain ||
        state.phase !== 'running' ||
        state.traffic !== 'listening' ||
        !state.instanceId ||
        !state.configurationRevision ||
        !state.profileId ||
        !state.mode
      )
        return undefined
      return {
        kind: 'ordinary' as const,
        instanceId: state.instanceId,
        configurationRevision: state.configurationRevision,
        profileId: state.profileId,
        mode: state.mode
      }
    }
    const matchesPageOwner = (owner: RelayProxyPageOwner | undefined, expected: unknown): boolean =>
      !!owner &&
      plainConfigurationMap(expected) &&
      Object.keys(owner).length === Object.keys(expected).length &&
      Object.entries(owner).every(([key, value]) => expected[key] === value)
    ipcMain.handle('relayTunProfileSwitch', (event, ...args: unknown[]) => {
      trusted(event)
      const input = args[0]
      if (
        args.length !== 1 ||
        !plainConfigurationMap(input) ||
        Object.keys(input).sort().join(',') !== 'owner,profile' ||
        !plainConfigurationMap(input.owner)
      )
        throw new Error('请选择要切换的配置及当前虚拟网卡会话。')
      const owner = tunSession.proxyPageOwner()
      if (!owner || !matchesPageOwner(owner, input.owner))
        throw new Error('虚拟网卡会话已变化，请刷新代理组。')
      return switchTunProfile(profileSelection(input.profile), owner)
    })
    ipcMain.handle('relayProxyPageOwner', (event, ...args) => {
      trusted(event)
      if (args.length) throw new Error('代理组会话查询不接受参数。')
      return proxyPageOwner()
    })
    for (const channel of relayUpstreamChannels) {
      if (special.has(channel)) continue
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        trusted(event)
        if (clashBackend.handles(channel)) {
          if (['mihomoGroups', 'mihomoChangeProxy', 'mihomoUnfixedProxy'].includes(channel)) {
            const supplied = args.at(-1)
            if (plainConfigurationMap(supplied)) {
              const owner = proxyPageOwner()
              if (
                !owner ||
                !Object.entries(owner).every(([k, v]) => supplied[k] === v) ||
                tunHandoff.isBusy()
              )
                throw new Error('代理核心已切换，请刷新节点列表。')
              args.pop()
              if (owner.kind === 'tun-managed') {
                if (
                  channel === 'mihomoGroups' &&
                  args.length <= 1 &&
                  (args[0] === undefined || typeof args[0] === 'boolean')
                )
                  return tunSession.proxyGroups(args[0] === true)
                if (quitAfterRestore || shellQuitting)
                  throw new Error('退出期间不能切换 TUN 节点。')
                requireProfileSwitchIdle()
                const [group, member] = args
                const validName = (value: unknown): value is string =>
                  typeof value === 'string' &&
                  value.length > 0 &&
                  Buffer.byteLength(value) <= 1024 &&
                  !/\p{Cc}/u.test(value)
                if (!validName(group)) throw new Error('代理组名称无效。')
                const change =
                  channel === 'mihomoChangeProxy' && args.length === 2 && validName(member)
                    ? tunSession.changeProxy({ action: 'select', group, member })
                    : channel === 'mihomoUnfixedProxy' && args.length === 1
                      ? tunSession.changeProxy({ action: 'automatic', group })
                      : undefined
                if (!change) throw new Error('无效的代理组选取操作。')
                return trackProxyChoice(
                  change.then(async () => {
                    const current = proxyPageOwner()
                    if (
                      current?.instanceId === owner.instanceId &&
                      current.configurationRevision === owner.configurationRevision
                    )
                      await startupPreferences.select(
                        owner.profileId,
                        group,
                        channel === 'mihomoChangeProxy' && typeof member === 'string'
                          ? member
                          : undefined
                      )
                    if (window && !window.isDestroyed()) window.webContents.send('groupsUpdated')
                  })
                )
              }
            }
          }
          if (channel === 'changeCurrentProfile') {
            requireProfileSwitchIdle()
            const owner = tunSession.proxyPageOwner()
            if (owner && args.length === 1)
              return switchTunProfile(profileSelection(args[0]), owner)
            const pending = profileStartup?.cancelAndWait()
            if (pending)
              return pending.then(() => {
                trusted(event)
                requireCompleteIdle()
                return clashBackend.invoke(channel, args)
              })
          }
          if (
            [
              'changeCurrentProfile',
              'patchControledMihomoConfig',
              'patchMihomoConfig',
              'mihomoChangeProxy',
              'mihomoUnfixedProxy',
              'mihomoProxyDelay',
              'mihomoCloseConnection',
              'mihomoCloseAllConnections'
            ].includes(channel)
          )
            requireCompleteIdle()
          return clashBackend.invoke(channel, args)
        }
        if (args.length > 1) throw new Error('未接入的接口不接受额外参数。')
        return backend(channel, args[0])
      })
    }
    const confirmLocalMaintenance = async (): Promise<boolean> => {
      const owner = window,
        live = runtimeGistContext()
      live()
      if (!owner) return false

      live()
      return true
    }
    const assertMaintenanceIdle = (): void => {
      const previous = maintenanceAssertion
      maintenanceAssertion = true
      try {
        requireCompleteIdle()
      } finally {
        maintenanceAssertion = previous
      }
    }
    maintenance = createMaintenanceService({
      store: new RelayMaintenanceStore(stateContext()),
      inspectPreferences: () => uiPreferences.inspect(),
      savePreferences: async (value, revision, assertCurrent) => {
        await uiPreferences.initialize(assertCurrent)
        return uiPreferences.save(value, revision, assertCurrent)
      },
      assertIdle: assertMaintenanceIdle,
      confirm: async (_plan) => confirmLocalMaintenance(),
      confirmReveal: async () => confirmLocalMaintenance(),
      clearRendererCache: async () => {
        if (session.defaultSession.getStoragePath() !== app.getPath('sessionData'))
          throw new Error('当前Chromium会话归属未确认。')
        await session.defaultSession.clearCache()
      },
      revealHeapDirectory: async (path) => {
        const error = await shell.openPath(path)
        if (error) throw new Error('目录打开未确认。')
      }
    })
    const maintenanceService = maintenance
    ipcMain.handle('relayMaintenanceState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('维护状态不接受参数。')
      return maintenanceService.state()
    })
    ipcMain.handle('relayMaintenancePrepare', (event, input: unknown) => {
      trusted(event)
      return maintenanceService.prepare(input, runtimeGistContext())
    })
    ipcMain.handle('relayMaintenanceExecute', (event, input: unknown) => {
      trusted(event)
      return maintenanceService.execute(input, runtimeGistContext())
    })
    ipcMain.handle('relayMaintenanceCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消维护不接受参数。')
      maintenanceService.cancel()
      return { status: 'cancel-requested' }
    })
    ipcMain.handle('relayMaintenanceRevealHeap', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('查看固定目录不接受路径。')
      return maintenanceService.revealHeap(runtimeGistContext())
    })
    preferenceBackupAccess = {
      isBusy: () => backupService.isBusy(),
      whenIdle: () => backupService.whenIdle()
    }
    preferenceWriteBarriers.appUpdate = () => appUpdates?.isBlocking() ?? true
    preferenceWriteBarriers.ownedReset = () => ownedResetService.isBlocking()
    // Bind only real Main service instances before Renderer requests begin.
    if (preferenceNotifyPending) notifyUIPreferences()
    const publicUIPreferencesContext = (): (() => void) => {
      const live = runtimeGistContext()
      return () => {
        live()
        if (
          !preferenceBackupAccess ||
          preferenceBackupAccess.isBusy() ||
          maintenance?.isBusy() ||
          preferenceWriteBarriers.appUpdate() ||
          preferenceWriteBarriers.ownedReset()
        )
          throw new Error('请先结束备份、整套数据维护或应用安装事务，再读取或保存界面偏好。')
      }
    }
    ipcMain.handle('relayOpenUpstreamReference', (event, input: unknown) => {
      trusted(event)
      const reference = relayUpstreamReferences.find(({ id }) => id === input)
      if (!reference) throw new Error('上游参考链接无效。')
      return shell.openExternal(reference.url)
    })
    ipcMain.handle('relayUIPreferencesState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('本地偏好读取不接受参数。')
      return uiPreferences.state()
    })
    ipcMain.handle('relayUIPreferencesRead', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('本地偏好读取不接受参数。')
      if (maintenance?.isBusy()) throw new Error('本地维护尚未结束。')
      return uiPreferences.initialize(publicUIPreferencesContext())
    })
    ipcMain.handle('relayUIPreferencesSave', (event, input: unknown) => {
      trusted(event)
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'revision,value'
      )
        throw new Error('本地偏好保存参数无效。')
      const request = input as Record<string, unknown>
      if (maintenance?.isBusy()) throw new Error('本地维护尚未结束。')
      return uiPreferences.save(request.value, request.revision, publicUIPreferencesContext())
    })
    ipcMain.handle('relayAppLogSizeRead', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('应用日志偏好读取不接受参数。')
      return uiPreferences.readAppLogSize(publicUIPreferencesContext())
    })
    ipcMain.handle('relayAppLogSizeSave', (event, input: unknown) => {
      trusted(event)
      return uiPreferences.saveAppLogSize(input, publicUIPreferencesContext(), async () => {
        if ((await backupStore.unresolved()).length)
          throw new Error('备份恢复状态未确认，请先完成恢复核对。')
      })
    })
    ipcMain.handle('relayWorkspaceVisible', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('窗口可见状态不接受参数。')
      return !!window?.isVisible() && !quitAfterRestore && !shellQuitting
    })
    ipcMain.handle('relayStatus', (event): RelayStatus => {
      trusted(event)
      const owner = ordinaryCoreOwner.state()
      return {
        name: 'Relay',
        version: app.getVersion(),
        upstream: 'Clash Party v2.0.4',
        mode: 'preview',
        coreRunning:
          core.state().phase === 'running' ||
          localProxy.state().traffic === 'listening' ||
          tunSession.state().traffic === 'forwarding' ||
          (owner.hasRecord && ['ready', 'detached'].includes(owner.phase))
            ? true
            : core.state().owned ||
                localProxy.state().owned ||
                tunSession.state().owned ||
                owner.hasRecord ||
                ordinaryCoreOwner.isBlocking()
              ? null
              : false,
        normalBackendReady: false,
        networkChangesAllowed: false,
        systemProxyStatus: systemProxy.state().report?.status ?? 'unobserved',
        nativeReady: nativeReady(nativePath()),
        guardEnabled: false
      }
    })
    ipcMain.handle('relayPreview', (event, input: unknown) => {
      trusted(event)
      return previewNative(nativePath(), input)
    })
    ipcMain.handle('relayGuardScopedCLIState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('受限 CLI 状态不接受参数。')
      if (!scopedCLI) throw new Error('受限 CLI 服务尚未初始化。')
      return scopedCLI.state()
    })
    ipcMain.handle('relayGuardScopedCLILaunch', (event, input: unknown) => {
      trusted(event)
      const epoch = guardRendererEpoch,
        live = runtimeGistContext()
      if (!scopedCLI) throw new Error('受限 CLI 服务尚未初始化。')
      return scopedCLI.launch(input, () => {
        trusted(event)
        live()
        if (epoch !== guardRendererEpoch || quitAfterRestore)
          throw new Error('本次受限启动意图已失效。')
      })
    })
    ipcMain.handle('relayGuardScopedStorage', (event, input: unknown) => {
      trusted(event)
      const epoch = guardRendererEpoch,
        live = runtimeGistContext()
      if (!scopedCLI) throw new Error('受限 CLI 服务尚未初始化。')
      return scopedCLI.storageAction(input, () => {
        trusted(event)
        live()
        if (epoch !== guardRendererEpoch || quitAfterRestore)
          throw new Error('本次私有磁盘意图已失效。')
      })
    })
    ipcMain.handle('relayGuardScopedCLIStop', async (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('停止仅处理本次 CLI，不接受 PID 或路径。')
      if (!scopedCLI) throw new Error('受限 CLI 服务尚未初始化。')
      await scopedCLI.stop()
      if (!scopedCLI) throw new Error('受限 CLI 服务尚未初始化。')
      return scopedCLI.state()
    })
    ipcMain.handle('relayGuardManagementState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('过滤管理状态不接受参数。')
      if (!guardManagement) throw new Error('过滤管理尚未初始化。')
      return guardManagement.state()
    })
    ipcMain.handle('relayGuardManagementAction', (event, input: unknown) => {
      trusted(event)
      const epoch = guardRendererEpoch
      const assertCurrent = (): void => {
        trusted(event)
        if (epoch !== guardRendererEpoch || quitAfterRestore)
          throw new Error('本次过滤操作的页面意图已失效。')
      }
      if (!guardManagement) throw new Error('过滤管理尚未初始化。')
      return guardManagement.action(input, assertCurrent)
    })
    ipcMain.handle('relayGuardReadiness', (event, input: unknown) => {
      trusted(event)
      return guardReadiness.read(input)
    })
    ipcMain.handle('relayCoreState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('核心状态不接受参数。')
      return core.state()
    })
    ipcMain.handle('relayCorePrepare', (event, input: unknown) => {
      trusted(event)
      requireIndependentOperationIdle()
      if (tunSession.isBlocking()) throw new Error('请先结束本次TUN会话。')
      if (quitAfterRestore) throw new Error('退出恢复正在进行。')
      if (backupService.isBusy() || remoteBackup.isBusy() || runtimeGist.isBusy())
        throw new Error('备份或恢复操作尚未结束。')
      if (variantService.isBusy()) throw new Error('变体操作尚未结束。')
      return core.prepare(input)
    })
    ipcMain.handle('relayCoreAction', (event, input: unknown) => {
      trusted(event)
      if (
        configurationEdit.isBusy() ||
        simple.isBusy() ||
        publication.isBusy() ||
        updateWorkflowsBlocking() ||
        appUpdateBlocks() ||
        (!maintenanceAssertion && (!!maintenance?.isBusy() || localPreferencesBusy())) ||
        (!ownedResetAssertion && ownedResetService.isBlocking()) ||
        plugins.isBusy() ||
        pluginScheduler.isBusy()
      )
        throw new Error('请先结束配置编辑、插件或更新操作。')
      if (tunSession.isBlocking()) throw new Error('请先结束本次TUN会话。')
      if (backupService.isBusy() || remoteBackup.isBusy() || runtimeGist.isBusy())
        throw new Error('备份或恢复操作尚未结束。')
      if (variantService.isBusy()) throw new Error('变体操作尚未结束。')
      const action = validateCoreAction(input)
      if (quitAfterRestore && action.action === 'start') throw new Error('退出恢复正在进行。')
      if (
        action.action === 'start' &&
        (desktop.isBlocking() ||
          code.isApplying() ||
          recovery.isRestoring() ||
          edge.isBusy() ||
          subscriptions.isBusy() ||
          providers.isBusy() ||
          subscriptionSources.isBusy() ||
          sourceScheduler.isBusy() ||
          resources.isBusy() ||
          geoOrigins.isBusy() ||
          geoScheduler.isBusy() ||
          localProxy.isBlocking())
      )
        throw new Error('请先结束当前桌面或配置操作。')
      return core.action(action)
    })
    ipcMain.handle('relaySimplePublicationState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) return { status: 'invalid' }
      return publicationHandlers(event).relaySimplePublicationState()
    })
    ipcMain.handle('relaySimplePublicationPrepare', (event, input: unknown) =>
      publicationHandlers(event).relaySimplePublicationPrepare(input)
    )
    ipcMain.handle('relaySimplePublicationConfirm', (event, input: unknown) =>
      publicationHandlers(event).relaySimplePublicationConfirm(input)
    )
    ipcMain.handle('relaySimplePublicationRecover', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) return { status: 'invalid' }
      return publicationHandlers(event).relaySimplePublicationRecover()
    })
    ipcMain.handle('relaySimplePublicationAbandon', (event, input: unknown) =>
      publicationHandlers(event).relaySimplePublicationAbandon(input)
    )
    ipcMain.handle('relaySimpleReadConfigurationBinding', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) return { status: 'invalid' }
      return simpleHandlers(event).relaySimpleReadConfigurationBinding()
    })
    ipcMain.handle('relaySimpleSaveConfigurationBinding', (event, input: unknown) =>
      simpleHandlers(event).relaySimpleSaveConfigurationBinding(input)
    )
    ipcMain.handle('relaySimpleReadSourceBindings', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) return { status: 'invalid' }
      return simpleHandlers(event).relaySimpleReadSourceBindings()
    })
    ipcMain.handle('relaySimpleSaveSourceBinding', (event, input: unknown) =>
      simpleHandlers(event).relaySimpleSaveSourceBinding(input)
    )
    ipcMain.handle('relaySimpleReadEditableDraft', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) return { status: 'invalid' }
      return simpleHandlers(event).relaySimpleReadEditableDraft()
    })
    ipcMain.handle('relaySimpleSaveModule', (event, input: unknown) =>
      simpleHandlers(event).relaySimpleSaveModule(input)
    )
    ipcMain.handle('relaySimplePreview', (event, input: unknown) =>
      simpleHandlers(event).relaySimplePreview(input)
    )
    ipcMain.handle('relaySimplePrepareProfile', (event, input: unknown) =>
      simpleHandlers(event).relaySimplePrepareProfile(input)
    )
    ipcMain.handle('relaySimpleRecover', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) return { status: 'invalid' }
      return simpleHandlers(event).relaySimpleRecover()
    })
    ipcMain.handle('relayProfilePrepare', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.prepare(input)
    })
    ipcMain.handle('relayProfileNewPrepare', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.prepareNew(input)
    })
    ipcMain.handle('relayProfileExport', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.export(input)
    })
    ipcMain.handle('relayProfileNodesRead', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.readNodes(input)
    })
    ipcMain.handle('relayProfileNodesPrepare', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.prepareNodeEdit(input)
    })
    ipcMain.handle('relayProfileGroupsRead', async (event, input: unknown) => {
      trusted(event)
      const owner = tunSession.proxyPageOwner()
      requireSubscriptionFinished(
        false,
        false,
        false,
        false,
        false,
        owner ? { kind: 'tun-managed', sessionId: owner.instanceId } : undefined
      )
      const snapshot = await profiles.readGroups(input)
      const selectors = await startupPreferences
        .selectors(snapshot.profile.id)
        .catch(() => undefined)
      trusted(event)
      if (!selectors) return snapshot
      return {
        ...snapshot,
        savedSelectors: [...selectors].filter(([group, member]) =>
          canSelectCachedGroupMember(snapshot, group, member)
        )
      }
    })
    let savingCachedGroup = false
    ipcMain.handle('relayProfileGroupSelect', async (event, input: unknown) => {
      trusted(event)
      if (
        !plainConfigurationMap(input) ||
        !['group,member,profile', 'group,member,owner,profile'].includes(
          Object.keys(input).sort().join(',')
        )
      )
        throw new Error('请选择已保存配置中的代理组和成员。')
      const selection = profileSelection(input.profile)
      const sourceOwner = 'owner' in input ? proxyPageOwner() : undefined
      if (
        'owner' in input &&
        (!sourceOwner ||
          sourceOwner.profileId === selection.id ||
          !matchesPageOwner(sourceOwner, input.owner))
      )
        throw new Error('运行配置已变化，请重新选择节点。')
      requireCompleteIdle(
        false,
        false,
        false,
        false,
        false,
        false,
        sourceOwner?.kind === 'tun-managed'
          ? { kind: 'tun-managed', sessionId: sourceOwner.instanceId }
          : undefined
      )
      const { group, member } = input
      if (
        typeof group !== 'string' ||
        typeof member !== 'string' ||
        !group ||
        !member ||
        group.length > 512 ||
        member.length > 512
      )
        throw new Error('代理组或成员无效。')
      if (savingCachedGroup) throw new Error('请等待当前节点选择保存完成。')
      const live = coreOwnerIntent(),
        version = clashBackend.selectionVersion()
      const current = (): void => {
        trusted(event)
        live()
        const tun = tunSession.state()
        if (
          version === undefined ||
          clashBackend.selectionVersion() !== version ||
          core.isBlocking() ||
          tunHandoff.isBusy() ||
          tunHandoff.ordinaryRecovery() ||
          (sourceOwner
            ? !matchesPageOwner(proxyPageOwner(), sourceOwner)
            : !relayProxyCanPrepare(localProxy.state()) ||
              ordinaryCoreOwner.isBlocking() ||
              tun.owned ||
              tun.pending ||
              tun.traffic !== 'inactive' ||
              !['idle', 'prepared', 'released', 'restored'].includes(tun.phase))
        )
          throw new Error('代理归属或当前配置已变化，请刷新节点列表。')
      }
      const checkSelection = async (): Promise<void> => {
        current()
        const selected = await coreSelection.read()
        current()
        if (sourceOwner) {
          if (selected?.id !== sourceOwner.profileId) throw new Error('当前运行配置已变化。')
          await profileStore.read(selection)
          current()
        } else if (selected?.id !== selection.id || selected.sha256 !== selection.sha256)
          throw new Error('请先选用此配置，再选择节点。')
      }
      savingCachedGroup = true
      try {
        await checkSelection()
        const snapshot = await profiles.readGroups(selection)
        current()
        if (!canSelectCachedGroupMember(snapshot, group, member))
          throw new Error('此代理组不支持离线选择该成员。')
        await startupPreferences.select(selection.id, group, member, current, checkSelection)
        await checkSelection()
        return { group, member }
      } finally {
        savingCachedGroup = false
      }
    })
    ipcMain.handle('relayProfileGroupsPrepare', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.prepareNodeEdit(input, 'groups')
    })
    ipcMain.handle('relayProfileRulesRead', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.readRules(input)
    })
    ipcMain.handle('relayProfileRulesPrepare', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.prepareRules(input)
    })
    ipcMain.handle('relayProfileRuleProvidersRead', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.readRuleProviders(input)
    })
    ipcMain.handle('relayProfileRuleProvidersPrepare', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.prepareRuleProviders(input)
    })
    ipcMain.handle('relayProfileRuleSnapshotPrepare', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.prepareRuleSnapshot(input)
    })
    ipcMain.handle('relayProfileSave', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return profiles.save(input)
    })
    ipcMain.handle('relayLibraryList', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('库列表不接受参数。')
      return library.list()
    })
    ipcMain.handle('relayLibraryChange', (event, input: unknown) => {
      const current = (): void => {
        trusted(event)
        requireCompleteIdle()
        if (shellQuitting || subscriptionSources.state().preparedId)
          throw new Error('请先结束退出或本次来源准备。')
      }
      current()
      if (library.isBusy()) throw new Error('库显示设置正在保存。')
      return library.change(input, current)
    })
    const listVisibleProfiles = async (current: () => void, input?: unknown) => {
      const report = await profiles.list(input)
      current()
      try {
        return {
          ...report,
          profiles: await library.view('profile', report.profiles, tunSession.state().owned)
        }
      } catch {
        return {
          ...report,
          warnings: [...report.warnings, '库显示设置未确认，当前为原始条目列表；未删除任何资料。']
        }
      }
    }
    ipcMain.handle('relayProfileList', (event, input: unknown) => {
      trusted(event)
      return listVisibleProfiles(() => trusted(event), input)
    })
    ipcMain.handle('relayProfileRuntimePrepare', (event, input: unknown) => {
      trusted(event)
      requireIndependentOperationIdle()
      if (completeConfiguration.isBusy()) throw new Error('完整配置操作尚未结束。')
      return profileRuntime.prepare(input)
    })
    const requireSubscriptionIdle = (): void => {
      requireIndependentOperationIdle()
      if (backupService.isBusy() || remoteBackup.isBusy() || runtimeGist.isBusy())
        throw new Error('备份或恢复操作尚未结束。')
      if (
        quitAfterRestore ||
        edge.isBusy() ||
        desktop.isBlocking() ||
        code.isApplying() ||
        recovery.isRestoring() ||
        profiles.isBusy() ||
        providers.isBusy() ||
        subscriptionSources.isBusy() ||
        sourceScheduler.isBusy() ||
        resources.isBusy() ||
        geoOrigins.isBusy() ||
        geoScheduler.isBusy() ||
        completeConfiguration.isBusy() ||
        coreRecordRecovery.isBusy() ||
        systemProxy.isBusy()
      )
        throw new Error('请先结束退出确认、桌面或配置操作。')
    }
    ipcMain.handle('relaySubscriptionPrepare', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionIdle()
      return subscriptions.prepare(input)
    })
    ipcMain.handle('relaySubscriptionDownload', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionIdle()
      return subscriptions.download(input)
    })
    ipcMain.handle('relaySubscriptionSave', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionIdle()
      return subscriptions.save(input)
    })
    ipcMain.handle('relaySubscriptionCancel', (event, input: unknown) => {
      trusted(event)
      return subscriptions.cancel(input)
    })
    ipcMain.handle('relaySubscriptionState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('订阅缓存状态不接受参数。')
      return subscriptions.state()
    })
    const requireProviderIdle = (): void => {
      requireIndependentOperationIdle()
      if (backupService.isBusy() || remoteBackup.isBusy() || runtimeGist.isBusy())
        throw new Error('备份或恢复操作尚未结束。')
      if (
        quitAfterRestore ||
        subscriptions.isBusy() ||
        subscriptionSources.isBusy() ||
        sourceScheduler.isBusy() ||
        resources.isBusy() ||
        geoOrigins.isBusy() ||
        geoScheduler.isBusy() ||
        edge.isBusy() ||
        desktop.isBlocking() ||
        code.isApplying() ||
        recovery.isRestoring() ||
        profiles.isBusy() ||
        completeConfiguration.isBusy() ||
        coreRecordRecovery.isBusy() ||
        systemProxy.isBusy()
      )
        throw new Error('请先结束退出、订阅、桌面或配置操作。')
    }
    const requireSourceIdle = (): void => {
      if (sourceScheduler.isBusy()) throw new Error('来源调度操作尚未结束。')
      requireProviderIdle()
      if (providers.isBusy()) throw new Error('提供者操作尚未结束。')
    }
    const requireResourceIdle = (): void => {
      requireIndependentOperationIdle()
      if (backupService.isBusy() || remoteBackup.isBusy() || runtimeGist.isBusy())
        throw new Error('备份或恢复操作尚未结束。')
      if (variantService.isBusy()) throw new Error('变体操作尚未结束。')
      if (
        quitAfterRestore ||
        subscriptions.isBusy() ||
        subscriptionSources.isBusy() ||
        sourceScheduler.isBusy() ||
        providers.isBusy() ||
        edge.isBusy() ||
        desktop.isBlocking() ||
        code.isApplying() ||
        recovery.isRestoring() ||
        profiles.isBusy() ||
        profileRuntime.isBusy() ||
        completeConfiguration.isBusy() ||
        coreRecordRecovery.isBusy() ||
        systemProxy.isBusy()
      )
        throw new Error('请先结束订阅、配置、桌面或其他检查操作。')
    }
    const requireGeoOriginIdle = (): void => {
      if (webdavBackupScheduler.isBusy() || !canRunWebdavBackup(false, false, false, false, true))
        throw new Error('请先结束地理来源、配置、备份或其他在途操作。')
    }
    ipcMain.handle('relayGeoScheduleState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('地理调度状态不接受参数。')
      return geoScheduler.state()
    })
    ipcMain.handle('relayGeoScheduleArm', (event, input: unknown) => {
      trusted(event)
      const request = geoScheduleArmRequest(input),
        live = runtimeGistContext()
      requireGeoOriginIdle()
      live()
      return geoScheduler.arm(request, live)
    })
    ipcMain.handle('relayGeoScheduleDisarm', (event, input: unknown) => {
      trusted(event)
      return geoScheduler.disarm(input)
    })
    ipcMain.handle('relayGeoOriginList', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('地理来源列表不接受参数。')
      requireGeoOriginIdle()
      return geoOrigins.list(runtimeGistContext())
    })
    ipcMain.handle('relayGeoOriginRead', (event, input: unknown) => {
      trusted(event)
      requireGeoOriginIdle()
      return geoOrigins.read(input, runtimeGistContext())
    })
    ipcMain.handle('relayGeoOriginSave', (event, input: unknown) => {
      trusted(event)
      requireGeoOriginIdle()
      return geoOrigins.save(input, runtimeGistContext())
    })
    ipcMain.handle('relayGeoOriginFetch', (event, input: unknown) => {
      trusted(event)
      requireGeoOriginIdle()
      return geoOrigins.fetch(input, runtimeGistContext())
    })
    ipcMain.handle('relayGeoOriginState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('地理来源缓存状态不接受参数。')
      return geoOrigins.state()
    })
    ipcMain.handle('relayGeoOriginCancel', async (event, input: unknown) => {
      trusted(event)
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).join(',') !== 'operationId' ||
        !('operationId' in input) ||
        typeof input.operationId !== 'string' ||
        !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.operationId)
      )
        throw new Error('取消只接受本次地理来源operationId。')
      if (geoOrigins.cancel(input.operationId)) await geoOrigins.whenIdle()
    })
    ipcMain.handle('relayResourceList', (event, input: unknown) => {
      trusted(event)
      requireResourceIdle()
      if (input !== undefined) throw new Error('资源列表不接受参数。')
      return resources.list()
    })
    ipcMain.handle('relayResourcePreview', (event, input: unknown) => {
      trusted(event)
      requireResourceIdle()
      return resources.preview(input, runtimeGistContext())
    })
    ipcMain.handle('relayResourcePrepare', (event, input: unknown) => {
      trusted(event)
      requireResourceIdle()
      return resources.prepare(input)
    })
    ipcMain.handle('relayResourceAcquire', (event, input: unknown) => {
      trusted(event)
      requireResourceIdle()
      return resources.acquire(input)
    })
    ipcMain.handle('relayResourceCheck', (event, input: unknown) => {
      trusted(event)
      requireResourceIdle()
      return resources.check(input)
    })
    ipcMain.handle('relayResourceCancel', (event, input: unknown) => {
      trusted(event)
      return resources.cancel(input)
    })
    ipcMain.handle('relayResourceState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('资源缓存状态不接受参数。')
      return resources.state()
    })
    ipcMain.handle('relaySourceScheduleState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('调度缓存状态不接受参数。')
      return sourceScheduler.state()
    })
    ipcMain.handle('relaySourceScheduleArm', async (event, input: unknown) => {
      const current = (): void => {
        trusted(event)
        requireSourceIdle()
        if (library.isBusy()) throw new Error('库显示设置正在保存。')
      }
      current()
      const selection = sourceSelection(input),
        catalog = await library.list()
      current()
      if (
        !catalog.items.some(
          (item) =>
            item.kind === 'source' &&
            item.id === selection.id &&
            item.revision === selection.revision &&
            !item.hidden
        )
      )
        throw new Error('来源已移出库或发生变化，请先恢复并重新读取。')
      return sourceScheduler.arm(input)
    })
    ipcMain.handle('relaySourceScheduleDisarm', (event, input: unknown) => {
      trusted(event)
      return sourceScheduler.disarm(input)
    })
    ipcMain.handle('relaySourceList', async (event, input: unknown) => {
      trusted(event)
      requireSourceIdle()
      if (input !== undefined) throw new Error('来源列表不接受参数。')
      const report = await subscriptionSources.list()
      trusted(event)
      try {
        return { ...report, sources: await library.view('source', report.sources) }
      } catch {
        return {
          ...report,
          warnings: [...report.warnings, '库显示设置未确认，当前为原始条目列表；未删除任何资料。']
        }
      }
    })
    ipcMain.handle('relaySourceRegisterPrepare', (event, input: unknown) => {
      trusted(event)
      requireSourceIdle()
      return subscriptionSources.prepareRegistration(input)
    })
    ipcMain.handle('relaySourceUpdatePrepare', (event, input: unknown) => {
      trusted(event)
      requireSourceIdle()
      return subscriptionSources.prepareUpdate(input)
    })
    ipcMain.handle('relaySourceRestorePrepare', (event, input: unknown) => {
      trusted(event)
      requireSourceIdle()
      return subscriptionSources.prepareRestore(input)
    })
    ipcMain.handle('relaySourceExecute', (event, input: unknown) => {
      trusted(event)
      requireSourceIdle()
      return subscriptionSources.execute(input)
    })
    ipcMain.handle('relaySourceCancel', (event, input: unknown) => {
      trusted(event)
      return subscriptionSources.cancel(input)
    })
    ipcMain.handle('relaySourceState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('来源状态不接受参数。')
      return subscriptionSources.state()
    })
    ipcMain.handle('relayProvidersInspect', (event, input: unknown) => {
      trusted(event)
      requireProviderIdle()
      return providers.inspect(input)
    })
    ipcMain.handle('relayProviderPrepare', (event, input: unknown) => {
      trusted(event)
      requireProviderIdle()
      return providers.prepare(input)
    })
    ipcMain.handle('relayProviderAcquire', (event, input: unknown) => {
      trusted(event)
      requireProviderIdle()
      return providers.acquire(input)
    })
    ipcMain.handle('relayProviderBatchPrepare', (event, input: unknown) => {
      trusted(event)
      requireProviderIdle()
      return providers.prepareBatch(input)
    })
    ipcMain.handle('relayProviderBatchAcquire', (event, input: unknown) => {
      trusted(event)
      requireProviderIdle()
      return providers.acquireBatch(input)
    })
    ipcMain.handle('relayProviderSnapshotPrepare', (event, input: unknown) => {
      trusted(event)
      requireProviderIdle()
      return providers.prepareSnapshot(input)
    })
    ipcMain.handle('relayProviderSnapshotSave', (event, input: unknown) => {
      trusted(event)
      requireProviderIdle()
      return providers.saveSnapshot(input)
    })
    ipcMain.handle('relayProviderCancel', (event, input: unknown) => {
      trusted(event)
      return providers.cancel(input)
    })
    ipcMain.handle('relayProviderState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('提供者缓存状态不接受参数。')
      return providers.state()
    })
    ipcMain.handle('relayProfileRuntimeCheck', (event, input: unknown) => {
      trusted(event)
      requireIndependentOperationIdle()
      if (variantService.isBusy()) throw new Error('变体操作尚未结束。')
      if (completeConfiguration.isBusy()) throw new Error('完整配置操作尚未结束。')
      if (resources.isBusy() || geoOrigins.isBusy() || geoScheduler.isBusy())
        throw new Error('资源检查尚未结束。')
      return profileRuntime.check(input)
    })
    const requireCompleteIdle = (
      allowVariant = false,
      allowBackup = false,
      allowUpdates = false,
      allowRemote = false,
      allowRuntimeGist = false,
      allowBackupAccounts = false,
      runtimeSource?: RelayRuntimeGistSource,
      allowGuard = false,
      probePermit?: typeof isolatedProbePermit,
      subStorePermit?: typeof subStoreNetworkPermit
    ): void => {
      requireProfileSwitchIdle()
      if (tunHandoff.isBusy()) throw new Error('核心切换正在进行。')
      if (!allowGuard && guardManagement?.isBlocking())
        throw new Error('系统过滤或受限会话尚未收尾。')
      requireSubscriptionFinished(
        allowBackup,
        allowUpdates,
        allowRemote,
        allowRuntimeGist,
        allowBackupAccounts,
        runtimeSource,
        probePermit,
        subStorePermit
      )
      if (!allowVariant && variantService.isBusy()) throw new Error('变体操作尚未结束。')
      if (
        (quitAfterRestore && !(allowBackup && backupService.isBusy())) ||
        profileRuntime.isBusy() ||
        profiles.isBusy() ||
        edge.isBusy() ||
        desktop.isBlocking() ||
        code.isApplying() ||
        recovery.isRestoring()
      )
        throw new Error('请先结束退出、桌面或配置操作。')
    }
    assertResetRuntimeIdle = (): void => {
      const previous = ownedResetAssertion
      ownedResetAssertion = true
      try {
        requireCompleteIdle()
        if (
          core.isBlocking() ||
          localProxy.isBlocking() ||
          subStore.isBlocking() ||
          library.isBusy()
        )
          throw new Error('请先通过原有入口结束并核实自有运行事务。')
      } finally {
        ownedResetAssertion = previous
      }
    }
    ipcMain.handle('relayCoreOwnerState', async (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('持久代理状态不接受参数。')
      await ordinaryCoreOwner.refreshPresence()
      settleNoLaunchCoreOwnerReferences()
      return ordinaryCoreOwner.state()
    })
    ipcMain.handle('relayCoreOwnerAction', async (event, input: unknown) => {
      trusted(event)
      const action = coreOwnerAction(input),
        live = coreOwnerIntent()
      if (retainedExitPending) throw new Error('持久代理交接正在进行。')
      if (localProxy.state().pending) throw new Error('Local proxy operation pending')
      if (action === 'inspect') {
        try {
          await ordinaryCoreOwner.connect()
        } catch {
          await ordinaryCoreOwner.inspectRecovery()
        }
        settleNoLaunchCoreOwnerReferences()
        return ordinaryCoreOwner.state()
      }
      if (action === 'archive') {
        await ordinaryCoreOwner.inspectRecovery()
        if (!ordinaryCoreOwner.state().canArchive) throw new Error('No complete dead-owner proof')
        const target = ordinaryCoreOwner.captureArchiveIntent(),
          current = (): void => {
            live()
            target()
          }
        await assertCoreOwnerSideIdle(current, true)
        if (!(await confirmCoreOwner(current, 'archive'))) return ordinaryCoreOwner.state()
        await assertCoreOwnerSideIdle(current, true)
        const localOwned =
          ordinaryCoreOwner.ownsLocalInstance() && localProxy.state().lifetime === 'persistent'
        await ordinaryCoreOwner.archive(current)
        if (localOwned) localProxy.acknowledgeArchivedPersistentOwner()
        await assertCoreOwnerSideIdle(live, true)
        return ordinaryCoreOwner.state()
      }
      const target =
          action === 'finalize' && !ordinaryCoreOwner.state().attached
            ? ordinaryCoreOwner.captureRetirementIntent()
            : ordinaryCoreOwner.captureControlIntent(),
        current = (): void => {
          live()
          target()
        }
      current()
      if (!(await confirmCoreOwner(current, action))) return ordinaryCoreOwner.state()
      current()
      if (action === 'reattach') {
        await ordinaryCoreOwner.reattach(current)
        return ordinaryCoreOwner.state()
      }
      if (action === 'finalize') {
        if (ordinaryCoreOwner.state().phase !== 'closed' || !ordinaryCoreOwner.state().canFinalize)
          throw new Error('No actual closed primary')
        if (!ordinaryCoreOwner.state().attached) {
          const localOwned = ordinaryCoreOwner.ownsLocalInstance() && localProxy.state().owned
          await ordinaryCoreOwner.retireClosedBridges(current)
          if (localOwned) localProxy.acknowledgeRetiredPersistentOwner()
        } else if (ordinaryCoreOwner.ownsLocalInstance() && localProxy.state().owned) {
          const finalized = await localProxy.finalizePersistentOwner()
          if (finalized.status !== 'stopped') throw new Error('Persistent finalization uncertain')
        } else await ordinaryCoreOwner.finalizeRelease(current)
        return ordinaryCoreOwner.state()
      }
      // A committed stop remains true after a renderer change. The release
      // still requires the same Native's actual child-exit/held-lease proof.
      if (ordinaryCoreOwner.ownsLocalInstance() && localProxy.state().owned) {
        const stopped = await localProxy.finishPersistentOwner()
        if (stopped.status !== 'stopped') throw new Error('Persistent cleanup uncertain')
      } else {
        await guardManagement?.beforeRuntimeMutation()
        await scopedCLI?.beforeRuntimeMutation()
        current()
        await ordinaryCoreOwner.stop()
        await ordinaryCoreOwner.release()
      }
      return ordinaryCoreOwner.state()
    })
    ipcMain.handle('quitWithoutCore', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('保留Core退出不接受参数。')
      return quitWithoutCore()
    })
    ipcMain.handle('relayOwnedResetState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('整套数据维护状态不接受参数。')
      return ownedResetService.state()
    })
    ipcMain.handle('relayOwnedResetAction', (event, input: unknown) => {
      trusted(event)
      return ownedResetService.action(input, runtimeGistContext())
    })
    ipcMain.handle('relayProviderResourceList', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('提供者缓存列表不接受参数。')
      requireCompleteIdle()
      return providerStore.list()
    })
    ipcMain.handle('relayConfigEditRead', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('读取配置编辑文档不接受参数。')
      return configurationEdit.read()
    })
    ipcMain.handle('relayConfigEditSave', (event, input: unknown) => {
      trusted(event)
      requireIndependentOperationIdle()
      if (
        backupService.isBusy() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy() ||
        runtimeGistDiscovery.isBusy() ||
        overrideLibrary.isBusy() ||
        quitAfterRestore
      )
        throw new Error('备份或退出恢复正在进行。')
      if (subscriptionSources.isBusy() || sourceScheduler.isBusy())
        throw new Error('订阅来源操作尚未结束。')
      return configurationEdit.saveChecked(input)
    })
    ipcMain.handle('relayConfigEditClear', (event, input: unknown) => {
      trusted(event)
      requireIndependentOperationIdle()
      if (
        backupService.isBusy() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy() ||
        runtimeGistDiscovery.isBusy() ||
        overrideLibrary.isBusy() ||
        quitAfterRestore
      )
        throw new Error('备份或退出恢复正在进行。')
      if (subscriptionSources.isBusy() || sourceScheduler.isBusy())
        throw new Error('订阅来源操作尚未结束。')
      return configurationEdit.clearChecked(input)
    })
    ipcMain.handle('relayConfigEditPreview', (event, input: unknown) => {
      trusted(event)
      requireIndependentOperationIdle()
      return configurationEdit.preview(input)
    })
    ipcMain.handle('relayConfigEditPrepare', (event, input: unknown) => {
      trusted(event)
      requireCompleteIdle()
      return configurationEdit.prepare(input)
    })
    ipcMain.handle('relayTunConfigurationPrepare', (event, input: unknown) => {
      trusted(event)
      if (plainConfigurationMap(input) && Object.hasOwn(input, 'intent')) {
        if (Object.keys(input).sort().join(',') !== 'intent,profile' || input.intent !== 'enable')
          throw new Error('TUN配置只接受明确启用操作和配置身份。')
        return prepareTunConfiguration(input.profile, true)
      }
      return prepareTunConfiguration(input)
    })
    ipcMain.handle('relayVariantState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('变体状态不接受参数。')
      return variantService.state()
    })
    ipcMain.handle('relayVariantPrepare', async (event, input: unknown) => {
      trusted(event)
      variantService.cancelPreparation()
      const request = variantImportRequest(input)
      requireCompleteIdle()
      if (core.isBlocking() || localProxy.isBlocking()) throw new Error('请先结束本次核心运行。')
      if (!window) throw new Error('主窗口不可用。')
      const selected = await dialog.showOpenDialog(window, {
        title: '选择变体资源',
        properties: ['openFile']
      })
      if (selected.canceled || selected.filePaths.length !== 1) return undefined
      return variantService.prepareAcquire({
        ...request,
        sourcePath: await realpath(selected.filePaths[0])
      })
    })
    ipcMain.handle('relayVariantExecute', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('变体获取执行不接受参数。')
      return variantService.executeAcquire()
    })
    ipcMain.handle('relayVariantSelect', (event, input: unknown) => {
      trusted(event)
      return variantService.select(input)
    })
    ipcMain.handle('relayVariantRestore', (event, input: unknown) => {
      trusted(event)
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !('kind' in input) ||
        !['core', 'smart'].includes((input as { kind: string }).kind)
      )
        throw new Error('变体恢复参数无效。')
      return variantService.restore((input as { kind: 'core' | 'smart' }).kind)
    })
    ipcMain.handle('relayVariantRemove', (event, input: unknown) => {
      trusted(event)
      return variantService.remove(input)
    })
    ipcMain.handle('relayCompleteConfigurationPrepare', (event, input: unknown) => {
      trusted(event)
      requireCompleteIdle()
      if (variantService.isBusy()) throw new Error('变体操作尚未结束。')
      return completeConfiguration.prepare(input)
    })
    ipcMain.handle('relayCompleteConfigurationCheck', (event, input: unknown) => {
      trusted(event)
      requireCompleteIdle()
      return completeConfiguration.check(input)
    })
    ipcMain.handle('relayCompleteConfigurationCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消完整配置操作不接受参数。')
      completeConfiguration.cancel()
      tunSession.invalidatePending()
    })
    ipcMain.handle('relayTunStatus', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('TUN状态读取不接受参数。')
      return tunStatus()
    })
    const prepareTunSession = async (input: unknown) => {
      const request = tunEvidenceRequest(input)
      requireCompleteIdle()
      if (core.isBlocking() || clashBackend.isBusy()) throw new Error('请先结束本次独立核心。')
      assertTunLocalReady()
      const installed = await readTunInstallation('core-managed')
      if (!installed) throw new Error('Mihomo自管TUN权限组件尚未安装，当前不能启用。')
      const native = await inspectTunNative(installed)
      if (native.helper.state !== 'ready')
        throw new Error('TUN权限辅助尚未通过认证或执行器未就绪。')
      const checked = await completeConfiguration.takeChecked(request)
      if (!!checked.execution !== !!installed.executionCore)
        throw new Error('完整检查与execution-v2受托组件不匹配，请重新检查或安装配套组件。')
      const preparedState =
        checked.execution?.profile === 'smart'
          ? await smartStateStore.prepare(
              checked.profileId,
              smartStateCollectsCSV(checked.configuration)
            )
          : undefined
      const execution = checked.execution
        ? encodeCheckedTunExecutionV2(checked.execution, preparedState?.receipt)
        : undefined
      tunExecution = execution
        ? {
            ...execution,
            recheck: async () => {
              await checked.recheck()
              await preparedState?.recheck()
            },
            ...(preparedState
              ? {
                  smartState: {
                    prepared: preparedState,
                    store: smartStateStore
                  }
                }
              : {})
          }
        : undefined
      const evidence = {
        configurationExpiresAt: checked.expiresAt,
        configuration: checked.configuration,
        assets: checked.assets,
        pins: checked.pins,
        parser: checked.parser,
        helper: native.helper,
        network: native.network,
        expectedHelperSHA256: installed.helperSHA256,
        expectedCoreSHA256: installed.coreSHA256,
        ...(execution ? { checkedExecution: execution } : {}),
        currentUID: process.getuid?.() ?? 0
      }
      tunInstallation = installed
      tunObservation = native
      const handoff = tunConfigurationHandoffs.get(request.evidenceId)
      tunCandidate = {
        fixedGroups: handoff?.fixedGroups,
        ...(handoff && !handoff.instanceId
          ? { readSavedSelectors: () => startupPreferences.selectors(checked.profileId) }
          : {}),
        profileId: checked.profileId,
        evidence,
        recheck: async () => {
          try {
            await checked.recheck()
          } catch (error) {
            throw new TunStartFailure(
              error instanceof CheckedConfigurationFailure ? error.code : 'checked-source'
            )
          }
          if (tunHost) {
            try {
              if ((await tunHost.inspect()).phase === 'unknown')
                throw new TunStartFailure('owned-host-inspection')
            } catch {
              throw new TunStartFailure('owned-host-inspection')
            }
          } else {
            let fresh: TunNativeInspection
            try {
              fresh = await inspectTunNative(installed)
            } catch {
              throw new TunStartFailure('native-inspection')
            }
            if (JSON.stringify(fresh.baseline) !== JSON.stringify(native.baseline))
              throw new TunStartFailure('native-baseline')
            if (fresh.helper.revision !== native.helper.revision)
              throw new TunStartFailure('native-installation')
            if (fresh.network.existingTunnel !== 'none')
              throw new TunStartFailure('existing-tunnel')
          }
        }
      }
      const prepared = await tunSession.prepare({
        configurationSHA256: checked.configurationSHA256,
        bundleSHA256: checked.bundleSHA256
      })
      if (handoff) tunHandoff.remember(prepared.evidenceId, handoff)
      else if (localProxy.state().owned) throw new Error('普通代理切换凭据已失效，请重新准备。')
      return prepared
    }
    ipcMain.handle('relayTunPrepare', (event, input: unknown) => {
      trusted(event)
      return prepareTunSession(input)
    })
    ipcMain.handle('relayTunStart', (event, input: unknown) => {
      trusted(event)
      return startSelectedTun(tunEvidenceRequest(input))
    })
    ipcMain.handle('relayTunCancel', (event, input: unknown) => {
      trusted(event)
      return cancelSelectedTun(tunEvidenceRequest(input))
    })
    ipcMain.handle('relayTunStop', (event, input: unknown) => {
      trusted(event)
      return stopTunSession(input)
    })
    ipcMain.handle('relayTunRecoverOrdinary', (event, input: unknown) => {
      trusted(event)
      requireProfileSwitchIdle()
      const current = coreOwnerIntent()
      current()
      return tunHandoff.recoverOrdinary(tunSessionRequest(input))
    })
    ipcMain.handle('relayTunInspect', (event, input: unknown) => {
      trusted(event)
      return tunSession.inspect(input)
    })
    ipcMain.handle('relayTunRulesRead', (event, input: unknown) => {
      trusted(event)
      const request = tunRulesReadRequest(input),
        assertContext = runtimeGistContext()
      requireCompleteIdle(false, false, false, false, false, false, {
        kind: 'tun-managed',
        sessionId: request.sessionId
      })
      assertContext()
      return tunSession.readRules(request, assertContext)
    })
    ipcMain.handle('relayTunRuleChange', (event, input: unknown) => {
      trusted(event)
      const request = tunRuleChangeRequest(input),
        assertContext = runtimeGistContext()
      requireCompleteIdle(false, false, false, false, false, false, {
        kind: 'tun-managed',
        sessionId: request.sessionId
      })
      assertContext()
      return tunSession.changeRule(request, assertContext)
    })
    ipcMain.handle('relayTunResourcesRead', (event, input: unknown) => {
      trusted(event)
      const request = tunResourceReadRequest(input),
        assertContext = runtimeGistContext()
      requireCompleteIdle(false, false, false, false, false, false, {
        kind: 'tun-managed',
        sessionId: request.sessionId
      })
      assertContext()
      return tunSession.readResources(request, assertContext)
    })
    ipcMain.handle('relayTunResourceReplace', (event, input: unknown) => {
      trusted(event)
      const request = tunResourceReplaceRequest(input),
        assertContext = runtimeGistContext()
      requireCompleteIdle(false, false, false, false, false, false, {
        kind: 'tun-managed',
        sessionId: request.sessionId
      })
      assertContext()
      return tunSession.replaceResource(request, assertContext)
    })
    ipcMain.handle('relayTunRuleProvidersRead', (event, input: unknown) => {
      trusted(event)
      const request = tunRuleProvidersReadRequest(input),
        assertContext = runtimeGistContext()
      requireCompleteIdle(false, false, false, false, false, false, {
        kind: 'tun-managed',
        sessionId: request.sessionId
      })
      assertContext()
      return tunSession.readRuleProviders(request, assertContext)
    })
    ipcMain.handle('relayTunRuleProviderReplace', (event, input: unknown) => {
      trusted(event)
      const request = tunRuleProviderReplaceRequest(input),
        assertContext = runtimeGistContext()
      requireCompleteIdle(false, false, false, false, false, false, {
        kind: 'tun-managed',
        sessionId: request.sessionId
      })
      assertContext()
      return tunSession.replaceRuleProvider(request, assertContext)
    })
    ipcMain.handle('relayCoreRecordPrepare', (event, input: unknown) => {
      trusted(event)
      requireCompleteIdle()
      return coreRecordRecovery.prepare(input)
    })
    ipcMain.handle('relaySystemProxyDraftRead', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('系统代理默认设置读取不接受参数。')
      return systemProxyDraft.read(publicUIPreferencesContext())
    })
    ipcMain.handle('relayLocalProxyPlanRead', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('启动设置读取不接受参数。')
      return localProxyPlanStore.read(publicUIPreferencesContext())
    })
    ipcMain.handle('relayLocalProxyPlanSave', async (event, input: unknown) => {
      trusted(event)
      await profileStartup?.cancelAndWait()
      trusted(event)
      requireCompleteIdle()
      if (clashBackend.isBusy()) throw new Error('配置选择尚未结束，请等待后再修改启动设置。')
      localProxy.invalidatePending()
      return localProxyPlanStore.save(input, publicUIPreferencesContext(), async () => {
        if ((await backupStore.unresolved()).length)
          throw new Error('备份恢复状态未确认，请先完成恢复核对。')
      })
    })
    ipcMain.handle('relaySystemProxyDraftSave', (event, input: unknown) => {
      trusted(event)
      return systemProxyDraft.save(input, publicUIPreferencesContext(), async () => {
        if ((await backupStore.unresolved()).length)
          throw new Error('备份恢复状态未确认，请先完成恢复核对。')
      })
    })
    const waitForProfileInventory = async (current: () => void): Promise<boolean> => {
      // First paint also persists the sidebar layout. Let presentation preferences
      // and read-only inventories settle; network/configuration writes still reject.
      let waited = false
      while (
        uiPreferences.isBusy() ||
        profiles.isReading() ||
        subscriptionSources.isListing() ||
        systemProxy.isInspecting() ||
        systemProxyDraft.isReading() ||
        localProxyPlanStore.isReading()
      ) {
        current()
        waited = true
        await Promise.all([
          ...(uiPreferences.isBusy() ? [uiPreferences.whenIdle()] : []),
          ...(profiles.isReading() ? [profiles.whenIdle()] : []),
          ...(subscriptionSources.isListing() ? [subscriptionSources.whenIdle()] : []),
          ...(systemProxy.isInspecting() ? [systemProxy.whenIdle()] : []),
          ...(systemProxyDraft.isReading() ? [systemProxyDraft.whenIdle()] : []),
          ...(localProxyPlanStore.isReading() ? [localProxyPlanStore.whenIdle()] : [])
        ])
      }
      current()
      return waited
    }

    const waitForSystemProxyReadiness = async (current: () => void): Promise<void> => {
      current()
      await profileStartup?.whenIdle()
      await systemProxy.whenIdle()
      await waitForProfileInventory(current)
      current()
      requireSystemProxyIdle()
    }
    let inspection: { epoch: number; result: ReturnType<typeof systemProxy.inspect> } | undefined
    const readSystemProxyForClick = async (checkCaller: () => void) => {
      checkCaller()
      // Hiding a window does not change the proxy status being read. Keep
      // this shared observation independent of the caller that started it.
      if (inspection?.epoch !== systemProxyReadEpoch) {
        const live = coreOwnerIntent(false, false, () => systemProxyReadEpoch)
        inspection = {
          epoch: systemProxyReadEpoch,
          result: (async () => {
            await waitForSystemProxyReadiness(live)
            live()
            const report = await systemProxy.inspect()
            live()
            return report
          })()
        }
      }
      const read = inspection
      try {
        const report = await read.result
        checkCaller()
        return report
      } finally {
        if (inspection === read) inspection = undefined
      }
    }
    const ensureSystemProxyListener = async (current = coreOwnerIntent(false, false)) => {
      await waitForSystemProxyReadiness(current)
      const tun = tunSession.state()
      if (tun.owned) {
        await tunSession.inspect()
        current()
        return tunSession.systemProxyListener(tun.sessionId)
      }
      if (
        tun.pending ||
        !['idle', 'prepared', 'released', 'restored'].includes(tun.phase) ||
        tun.traffic !== 'inactive'
      )
        throw new Error('虚拟网卡状态需要核对。')
      if (!localProxy.state().owned) {
        if (!profileStartup) throw new Error('启动服务尚未就绪。')
        await profileStartup.startOnClick(current)
      }
      current()
      const state = localProxy.state()
      if (
        !state.owned ||
        state.pending ||
        state.uncertain ||
        state.phase !== 'running' ||
        state.traffic !== 'listening' ||
        !state.httpPort
      )
        throw new Error('当前代理的监听未确认。')
      return { httpPort: state.httpPort, mixedPort: state.ports?.mixed }
    }
    ipcMain.handle('relayEnsureSystemProxyListener', (event, ...args: unknown[]) => {
      trusted(event)
      if (args.length > 1 || args[0] !== undefined) throw new Error('系统代理启动不接受参数。')
      const live = coreOwnerIntent()
      return ensureSystemProxyListener(() => {
        trusted(event)
        live()
      })
    })
    ipcMain.handle('relaySystemProxyInspect', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('系统代理检查不接受参数。')
      return readSystemProxyForClick(() => trusted(event))
    })
    ipcMain.handle('relaySystemProxyPrepare', async (event, input: unknown) => {
      trusted(event)
      const live = coreOwnerIntent()
      await waitForSystemProxyReadiness(() => {
        trusted(event)
        live()
      })
      return systemProxy.prepare(input)
    })
    ipcMain.handle('relaySystemProxyRestorePrepare', async (event, input: unknown) => {
      trusted(event)
      const live = coreOwnerIntent()
      await waitForSystemProxyReadiness(() => {
        trusted(event)
        live()
      })
      return systemProxy.prepareRestore(input)
    })
    ipcMain.handle('relaySystemProxyExecute', async (event, input: unknown) => {
      trusted(event)
      const live = coreOwnerIntent()
      await waitForSystemProxyReadiness(() => {
        trusted(event)
        live()
      })
      return executeUserSystemProxy(input)
    })
    ipcMain.handle('relaySystemProxyState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('系统代理缓存状态不接受参数。')
      return systemProxy.state()
    })
    ipcMain.handle('relaySystemProxyCancel', (event, input: unknown) => {
      trusted(event)
      return systemProxy.cancel(input)
    })
    ipcMain.handle('relayCoreRecordArchive', (event, input: unknown) => {
      trusted(event)
      requireCompleteIdle()
      return coreRecordRecovery.archive(input)
    })
    ipcMain.handle('relayCoreLifecycleCheck', async (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('生命周期复核不接受参数。')
      if (quitAfterRestore) throw new Error('退出操作尚未结束。')
      await coreLifecycle.recheck()
      return coreLifecycle.state()
    })
    ipcMain.handle('relayCoreLifecycleState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('生命周期状态不接受参数。')
      return coreLifecycle.state()
    })
    ipcMain.handle('relaySmartTools', async (event, raw: unknown) => {
      trusted(event)
      const request = smartToolsRequest(raw)
      const confirmClear = async (_inspection: SmartToolsInspection): Promise<boolean> => {
        return actionWindowAvailable() && !quitAfterRestore
      }
      return request.target === 'ordinary'
        ? localProxy.smartTools(request, confirmClear)
        : tunSession.smartTools(request, confirmClear)
    })
    ipcMain.handle('relayLocalProxyState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('本地代理缓存状态不接受参数。')
      return localProxy.state()
    })
    ipcMain.handle('relayDedicatedInspect', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)))
        throw new Error('专用监听关联检查参数无效。')
      const request = input as { claudeCodePort?: number } | undefined
      if (request && Object.keys(request).some((key) => key !== 'claudeCodePort'))
        throw new Error('关联检查只接受Code端口。')
      if (
        request &&
        request.claudeCodePort !== undefined &&
        (typeof request.claudeCodePort !== 'number' ||
          !Number.isInteger(request.claudeCodePort) ||
          request.claudeCodePort < 1024 ||
          request.claudeCodePort > 65535)
      )
        throw new Error('Claude Code 端口参数无效。')
      return aiClients.inspect(request)
    })
    const historyService = trafficHistory
    if (!historyService) throw new Error('历史服务尚未初始化。')
    const historyCaller = (event: Electron.IpcMainInvokeEvent): void => {
      trusted(event)
      if (quitAfterRestore || shellQuitting) throw new Error('退出期间不能操作流量历史。')
    }
    ipcMain.handle('relayTrafficHistoryState', (event, input: unknown) => {
      historyCaller(event)
      if (input !== undefined) throw new Error('历史状态不接受参数。')
      return historyService.state()
    })
    ipcMain.handle('relayTrafficHistoryReadTun', async (event, input: unknown) => {
      historyCaller(event)
      if (input !== undefined) throw new Error('TUN历史读取不接受参数。')
      const ticket = historyService.ticket()
      if (ticket?.owner.kind !== 'tun-managed')
        throw new Error('请先明确允许本次TUN实例的连接历史。')
      const snapshot = await tunSession.readConnections(new AbortController().signal)
      historyCaller(event)
      if (!snapshot) throw new Error('本次TUN连接历史能力不可用；没有使用汇总数据代替。')
      const before = historyService.state().sampledSnapshots
      historyService.observe(
        ticket,
        {
          connections: snapshot.snapshot.connections ? [...snapshot.snapshot.connections] : [],
          upload: snapshot.snapshot.uploadTotal,
          download: snapshot.snapshot.downloadTotal
        },
        snapshot.owner
      )
      await historyService.whenIdle()
      const state = historyService.state()
      if (
        state.sampledSnapshots === before ||
        state.writeRecoveryRequired ||
        state.clearRecoveryRequired
      )
        throw new Error('本次TUN历史保存未确认。')
      return state
    })
    ipcMain.handle('relayTrafficHistoryRecord', async (event, input: unknown) => {
      historyCaller(event)
      await historyService.authorize('record', () => historyCaller(event), input)
      return historyService.state()
    })
    ipcMain.handle('relayTrafficHistoryStop', async (event, input: unknown) => {
      historyCaller(event)
      if (input !== undefined) throw new Error('历史停用不接受参数。')
      await historyService.stop('已停止记录；不会停止核心或已有连接。')
      return historyService.state()
    })
    ipcMain.handle('relayTrafficHistoryRetry', async (event, input: unknown) => {
      historyCaller(event)
      if (input !== undefined) throw new Error('历史写入恢复不接受参数。')
      if (await historyService.authorize('retry', () => historyCaller(event)))
        await historyService.retry()
      return historyService.state()
    })
    ipcMain.handle('relayTrafficHistoryImportAuthorize', (event, input: unknown) => {
      historyCaller(event)
      if (input !== undefined) throw new Error('历史迁移授权不接受参数。')
      return historyService.authorize('import', () => historyCaller(event))
    })
    ipcMain.handle('queryTrafficUsageOverview', (event, ...args: unknown[]) => {
      historyCaller(event)
      if (args.length !== 4) throw new Error('历史概览参数无效。')
      return historyService.overview(args[0], args[1], args[2], args[3])
    })
    ipcMain.handle('queryTrafficUsageBreakdown', (event, ...args: unknown[]) => {
      historyCaller(event)
      if (args.length !== 1) throw new Error('历史明细参数无效。')
      return historyService.breakdown(args[0])
    })
    ipcMain.handle('importTrafficUsage', (event, ...args: unknown[]) => {
      historyCaller(event)
      if (args.length !== 1) throw new Error('历史迁移参数无效。')
      return historyService.import(args[0])
    })
    ipcMain.handle('clearTrafficUsage', async (event, input: unknown) => {
      historyCaller(event)
      if (input !== undefined) throw new Error('历史清空不接受参数。')
      if (!(await historyService.authorize('clear', () => historyCaller(event))))
        throw new Error('已取消清空历史，未改动统计数据。')
      await historyService.clear()
    })
    const probeService = isolatedProbes
    if (!probeService) throw new Error('独立探测服务尚未接通。')
    const probeCaller = (event: Electron.IpcMainInvokeEvent): (() => void) => {
      const live = runtimeGistContext(),
        epoch = guardRendererEpoch
      const current = (): void => {
        trusted(event)
        live()
        if (epoch !== guardRendererEpoch) throw new Error('本次独立探测页面意图已失效。')
        if (shellQuitting || quitAfterRestore) throw new Error('退出期间不能启动独立探测。')
        requireCompleteIdle(
          false,
          false,
          false,
          false,
          false,
          false,
          undefined,
          false,
          isolatedProbePermit
        )
      }
      current()
      return current
    }
    ipcMain.handle('relayIsolatedProbeTargets', (event, input: unknown) => {
      const current = probeCaller(event)
      return probeService.targets(input, current)
    })
    ipcMain.handle('relayIsolatedProbePrepare', (event, input: unknown) => {
      const current = probeCaller(event)
      return probeService.prepare(input, current)
    })
    ipcMain.handle('relayIsolatedProbeRun', async (event, input: unknown) => {
      const current = probeCaller(event)
      const gone = (): void => probeService.invalidate()
      event.sender.once('destroyed', gone)
      try {
        return await probeService.run(input, current)
      } finally {
        event.sender.removeListener('destroyed', gone)
      }
    })
    ipcMain.handle('relayIsolatedProbeCancel', (event, input: unknown) => {
      trusted(event)
      return probeService.cancel(input)
    })
    ipcMain.handle('relayIsolatedProbeCleanup', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('独立探测收尾不接受参数。')
      return probeService.cleanup(probeCaller(event))
    })
    ipcMain.handle('relayIsolatedProbeState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('独立探测状态不接受参数。')
      // The Sub-Store actor still positively owns its own allocation window;
      // do not classify that actor's not-yet-published directory as an orphan.
      return subStoreNetworkBusy ? probeService.state() : probeService.refreshState()
    })
    ipcMain.handle('relayConnectionAppInfo', (event, input: unknown) => {
      const current = (): void => {
        trusted(event)
        if (quitAfterRestore || shellQuitting) throw new Error('退出期间不能读取应用图标。')
      }
      current()
      if (!connectionAppInfo) throw new Error('应用图标读取尚未就绪。')
      return connectionAppInfo.read(input, current)
    })
    ipcMain.handle('relayConnections', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('连接快照不接受参数。')
      return readObservedConnections()
    })
    ipcMain.handle('relayLogs', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('日志只读缓冲不接受参数。')
      return localProxy.logs()
    })
    ipcMain.handle('relayLogSnapshot', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('日志快照不接受参数。')
      return localProxy.logSnapshot()
    })
    ipcMain.handle('relayRuntimeInfo', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('运行时信息快照不接受参数。')
      return runtimeInfo.inspect()
    })
    ipcMain.handle('relayLocalProxyPrepare', (event, input: unknown) => {
      trusted(event)
      const prepare = async () => {
        trusted(event)
        requireCompleteIdle()
        if (variantService.isBusy()) throw new Error('变体操作尚未结束。')
        const request = localProxyPrepare(input)
        const plan = await localProxyPlanStore.read(publicUIPreferencesContext())
        const requestedPlan = localProxyPlan({
          httpPort: request.httpPort,
          ...(request.ports ? { ports: request.ports } : {}),
          resolverMode: request.resolverMode,
          ...(request.dedicated ? { dedicated: request.dedicated } : {})
        })
        if (JSON.stringify(requestedPlan) !== JSON.stringify(plan.document))
          throw new Error('请先保存本次启动设置，再启动代理。')
        requireCompleteIdle()
        return localProxy.prepare(input)
      }
      const pending = profileStartup?.cancelAndWait()
      return pending ? pending.then(prepare) : prepare()
    })
    ipcMain.handle('relayLocalProxyReloadPrepare', (event, input: unknown) => {
      trusted(event)
      requireCompleteIdle()
      return localProxy.prepareReload(input)
    })
    ipcMain.handle('relayLocalProxyReload', (event, input: unknown) => {
      trusted(event)
      requireCompleteIdle()
      return localProxy.reload(input).then((result) => {
        notifyClash()
        return result
      })
    })
    const performLocalProxyAction = (input: unknown, startupContext?: () => void) => {
      requireProfileSwitchIdle()
      if (tunHandoff.isBusy()) throw new Error('核心切换正在进行。')
      if (
        configurationEdit.isBusy() ||
        simple.isBusy() ||
        publication.isBusy() ||
        updateWorkflowsBlocking() ||
        appUpdateBlocks() ||
        (!maintenanceAssertion && (!!maintenance?.isBusy() || localPreferencesBusy())) ||
        (!ownedResetAssertion && ownedResetService.isBlocking()) ||
        plugins.isBusy() ||
        pluginScheduler.isBusy()
      )
        throw new Error('请先结束配置编辑、插件或更新操作。')
      if (backupService.isBusy() || remoteBackup.isBusy() || runtimeGist.isBusy())
        throw new Error('备份或恢复操作尚未结束。')
      if (variantService.isBusy()) throw new Error('变体操作尚未结束。')
      if (systemProxy.isBusy()) throw new Error('系统代理事务尚未结束，不能改变本次代理实例。')
      const action = localProxyAction(input)
      if (action.action === 'stop') void runtimeGistSync.stop('ownerChanged')
      if (quitAfterRestore && !['stop', 'refresh'].includes(action.action))
        throw new Error('退出恢复正在进行。')
      if (
        action.action === 'start' &&
        (core.isBlocking() ||
          desktop.isBlocking() ||
          code.isApplying() ||
          recovery.isRestoring() ||
          edge.isBusy() ||
          subscriptions.isBusy() ||
          providers.isBusy() ||
          subscriptionSources.isBusy() ||
          sourceScheduler.isBusy() ||
          resources.isBusy() ||
          geoOrigins.isBusy() ||
          geoScheduler.isBusy() ||
          completeConfiguration.isBusy() ||
          coreRecordRecovery.isBusy() ||
          systemProxy.isBusy())
      )
        throw new Error('请先结束当前核心、桌面或配置操作。')
      const isRuleAction = action.action === 'rules' || action.action === 'rule'
      const pageContext =
        isRuleAction || action.action === 'start' ? runtimeGistContext(!startupContext) : undefined
      const assertContext = pageContext
        ? (): void => {
            pageContext()
            startupContext?.()
          }
        : undefined
      if (assertContext) {
        requireCompleteIdle()
        assertContext()
      }
      const operation = assertContext
        ? localProxy.action(action, assertContext)
        : localProxy.action(action)
      return operation.then((result) => {
        notifyClash()
        if (result.status === 'started' && window && !window.isDestroyed())
          window.webContents.send('core-started')
        return result
      })
    }
    ipcMain.handle('relayLocalProxyAction', (event, input: unknown) => {
      trusted(event)
      const action = localProxyAction(input)
      const pending =
        action.action === 'start' || action.action === 'stop'
          ? profileStartup?.cancelAndWait()
          : undefined
      return pending
        ? pending.then(() => {
            trusted(event)
            return performLocalProxyAction(input)
          })
        : performLocalProxyAction(input)
    })
    profileStartup = createProfileStartup({
      waitForPorts: waitForTunPlanPorts,
      onStarted: (current) =>
        applyStartupSystemProxy(
          {
            enabled: async () => (await startupPreferences.read()).systemProxy,
            local: () => localProxy.state(),
            inspect: async () => {
              await systemProxy.whenIdle()
              current()
              return systemProxy.inspect()
            },
            draft: async () => (await systemProxyDraft.read(current)).document,
            prepare: systemProxy.prepare,
            execute: systemProxy.execute,
            cancel: systemProxy.cancel
          },
          current
        ),
      readSelection: () => coreSelection.read(),
      readPlan: () => localProxyPlanStore.read(),
      resolveSelection: async (current) => {
        await preserveDedicatedPin(current)
        return coreSelection.readPreferred()
      },
      state: () => localProxy.state(),
      context: coreOwnerIntent,
      waitForInventory: waitForProfileInventory,
      selectOnClick: async (current) => {
        const selected = await coreSelection.readPreferred()
        current()
        if (selected) return selected
        const inventory = await profileStore.list()
        current()
        const first = inventory.profiles[0]
        if (!first) return undefined
        const selection = { id: first.id, sha256: first.sha256 }
        await waitForProfileInventory(current)
        current()
        requireCompleteIdle()
        // Use the ordinary selection path for its persisted identity, pin and UI notifications.
        await clashBackend.invoke('changeCurrentProfile', [selection])
        current()
        return selection
      },
      prepare: (input) => {
        requireCompleteIdle()
        return localProxy.prepare(input)
      },
      start: (evidenceId, current) =>
        performLocalProxyAction({ action: 'start', evidenceId }, current),
      invalidate: () => localProxy.invalidatePending()
    })
    ipcMain.handle('relayGenerate', (event, input: unknown) => {
      trusted(event)
      return artifacts.generate(input)
    })
    ipcMain.handle('relayArtifactAction', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      return artifacts.action(input)
    })
    ipcMain.handle('relayDiagnose', (event, input: unknown) => {
      trusted(event)
      return diagnostics.observe(input)
    })
    ipcMain.handle('relayReadPreferences', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('读取偏好不接受路径或参数。')
      return readPreferencesNative(nativePath(), stateContext())
    })
    ipcMain.handle('relaySavePreferences', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      if (edge.isBusy()) throw new Error('Edge 操作尚未结束。')
      if (desktop.isBlocking()) throw new Error('桌面登录或恢复尚未结束。')
      if (code.isApplying() || recovery.isRestoring()) throw new Error('配置或恢复事务尚未结束。')
      code.clear()
      return savePreferencesNative(nativePath(), input, stateContext())
    })
    ipcMain.handle('relayRecoveryStatus', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('恢复信息不接受路径或参数。')
      return recovery.inventory()
    })
    ipcMain.handle('relayBackupDirectoryOpen', (event, input: unknown) => {
      trusted(event)
      if (code.isApplying() || recovery.isRestoring()) throw new Error('配置或恢复事务尚未结束。')
      return openBackupDirectory(stateContext(), input, (path) => shell.openPath(path))
    })
    ipcMain.handle('relayDesktopReadiness', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('桌面检查不接受路径、地址或参数。')
      if (code.isApplying() || recovery.isRestoring()) throw new Error('配置或恢复事务尚未结束。')
      return desktopReadinessNative(nativePath(), stateContext())
    })
    ipcMain.handle('relayDesktopState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('会话状态不接受参数。')
      return desktop.state()
    })
    ipcMain.handle('relayDesktopAction', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      if (edge.isBusy()) throw new Error('Edge 操作尚未结束。')
      if (code.isApplying() || recovery.isRestoring()) throw new Error('配置或恢复事务尚未结束。')
      return desktop.action(input).then((result) => {
        if (result.status !== 'cancelled') {
          code.clear()
          recovery.clear()
          diagnostics.clear()
          artifacts.clear()
          edge.clear()
        }
        return result
      })
    })
    ipcMain.handle('relayEdgeInspect', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('Edge 检查不接受路径或参数。')
      return edge.inspect()
    })
    const requireEdgeIdle = (): void => {
      requireSubscriptionFinished()
      if (desktop.isBlocking() || code.isApplying() || recovery.isRestoring())
        throw new Error('桌面会话、配置或恢复事务尚未结束。')
    }
    const clearAfterEdge = <T extends { status: string }>(result: T): T => {
      if (result.status !== 'cancelled') {
        code.clear()
        recovery.clear()
        diagnostics.clear()
        artifacts.clear()
      }
      return result
    }
    ipcMain.handle('relayEdgeProfileOpen', (event, input: unknown) => {
      trusted(event)
      requireEdgeIdle()
      return edge.openProfile(input).then(clearAfterEdge)
    })
    ipcMain.handle('relayEdgeEntryOpen', (event, input: unknown) => {
      trusted(event)
      requireEdgeIdle()
      return edge.openEntry(input).then(clearAfterEdge)
    })
    ipcMain.handle('relayRecoveryPreflight', (event, input: unknown) => {
      trusted(event)
      return recovery.inspect(input)
    })
    ipcMain.handle('relayRecoveryRestore', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      if (edge.isBusy()) throw new Error('Edge 操作尚未结束。')
      if (desktop.isBlocking()) throw new Error('桌面登录或恢复尚未结束。')
      if (code.isApplying()) throw new Error('Code 配置事务尚未结束。')
      return recovery.restore(input).then((result) => {
        if (result.status !== 'cancelled') {
          artifacts.clear()
          diagnostics.clear()
          code.clear()
        }
        return result
      })
    })
    ipcMain.handle('relayCodePrepare', (event, input: unknown) => {
      trusted(event)
      if (desktop.isBlocking()) throw new Error('桌面登录或恢复尚未结束。')
      if (recovery.isRestoring()) throw new Error('恢复确认或事务尚未结束。')
      return code.prepare(input)
    })
    ipcMain.handle('relayCodeApply', (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      if (edge.isBusy()) throw new Error('Edge 操作尚未结束。')
      if (desktop.isBlocking()) throw new Error('桌面登录或恢复尚未结束。')
      if (recovery.isRestoring()) throw new Error('恢复确认或事务尚未结束。')
      return code.apply(input).then((result) => {
        if (result.status !== 'cancelled') {
          artifacts.clear()
          diagnostics.clear()
          recovery.clear()
        }
        return result
      })
    })
    ipcMain.handle('relayBrowserOpen', async (event, input: unknown) => {
      trusted(event)
      requireSubscriptionFinished()
      if (edge.isBusy()) throw new Error('Edge 操作尚未结束。')
      if (desktop.isBlocking()) throw new Error('桌面登录或恢复尚未结束。')
      if (input !== undefined) throw new Error('打开入口不接受路径、地址或参数。')
      if (recovery.isRestoring() || code.isApplying()) throw new Error('配置或恢复事务尚未结束。')
      code.clear()
      if (!browserBindingReady) throw new Error('Relay专用浏览器入口未就绪，请重新打开Relay。')
      await aiClients.ownedBrowserBinding()
      return openRelayBrowser(runtime.browserExecutable)
    })
    disposeAppUpdateIPC = registerAppUpdateIPC(ipcMain, trusted, appUpdates)
    ipcMain.handle('relayUpdateState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('更新状态不接受参数。')
      return updates.state()
    })
    ipcMain.handle('relayUpdatePrepare', (event, input: unknown) => {
      trusted(event)
      return updates.prepare(input)
    })
    ipcMain.handle('relayUpdateExecute', (event, input: unknown) => {
      trusted(event)
      return updates.execute(input)
    })
    ipcMain.handle('relayUpdateApplySubStore', (event, input: unknown) => {
      trusted(event)
      return updates.applySubStore(input)
    })
    ipcMain.handle('relayUpdateImportVariant', (event, input: unknown) => {
      trusted(event)
      return updates.importVariant(input)
    })
    ipcMain.handle('relayUpdateRemove', (event, input: unknown) => {
      trusted(event)
      return updates.remove(input)
    })
    ipcMain.handle('relayUpdateCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消不接受参数。')
      updates.cancel()
    })
    const requirePluginIdle = (): void => {
      if (
        quitAfterRestore ||
        backupService.isBusy() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy()
      )
        throw new Error('退出或备份恢复正在进行。')
      requireCompleteIdle()
    }
    ipcMain.handle('relayPluginScheduleState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('调度状态不接受参数。')
      return pluginScheduler.state()
    })
    ipcMain.handle('relayPluginScheduleArm', (event, input: unknown) => {
      trusted(event)
      requirePluginIdle()
      return pluginScheduler.arm(input)
    })
    ipcMain.handle('relayPluginScheduleDisarm', (event, input: unknown) => {
      trusted(event)
      return pluginScheduler.disarm(input)
    })
    ipcMain.handle('relayPluginState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('插件列表不接受参数。')
      return plugins.state()
    })
    ipcMain.handle('relayPluginOpenedPending', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('待处理CPX状态不接受参数。')
      return descriptorInbox.hasPending()
    })
    ipcMain.handle('relayPluginPreviewOpened', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('待处理CPX不接受渲染进程路径或参数。')
      requirePluginIdle()
      return plugins.previewOpenedFile()
    })
    ipcMain.handle('relayPluginPreviewFile', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('本地CPX选择器不接受渲染进程路径或参数。')
      requirePluginIdle()
      return plugins.previewFile()
    })
    ipcMain.handle('relayPluginPreview', (event, input: unknown) => {
      trusted(event)
      if (typeof input === 'string') return plugins.preview(input)
      requirePluginIdle()
      return plugins.previewRemote(input)
    })
    ipcMain.handle('relayPluginInstall', (event, input: unknown) => {
      trusted(event)
      requirePluginIdle()
      return plugins.install(input)
    })
    ipcMain.handle('relayPluginLogin', (event, input: unknown) => {
      trusted(event)
      requirePluginIdle()
      return plugins.login(input)
    })
    ipcMain.handle('relayPluginRediscover', (event, input: unknown) => {
      trusted(event)
      requirePluginIdle()
      return plugins.rediscover(input)
    })
    ipcMain.handle('relayPluginUpdate', (event, input: unknown) => {
      trusted(event)
      requirePluginIdle()
      return plugins.update(input)
    })
    ipcMain.handle('relayPluginSaveProfile', (event, input: unknown) => {
      trusted(event)
      requirePluginIdle()
      return plugins.saveProfile(input)
    })
    ipcMain.handle('relayPluginRemove', (event, input: unknown) => {
      trusted(event)
      requirePluginIdle()
      return plugins.remove(input)
    })
    ipcMain.handle('relayPluginCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消不接受参数。')
      return plugins.cancel()
    })
    const requireSubStoreIdle = (): void => {
      if (
        quitAfterRestore ||
        backupService.isBusy() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy()
      )
        throw new Error('退出或备份恢复正在进行。')
      requireCompleteIdle(
        false,
        false,
        false,
        false,
        false,
        false,
        undefined,
        false,
        undefined,
        subStoreNetworkPermit
      )
    }
    ipcMain.handle('relaySubStoreState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('状态读取不接受参数。')
      return subStore.inspect()
    })
    const subStoreIntent = (event: Electron.IpcMainInvokeEvent): (() => void) => {
      const live = runtimeGistContext(),
        epoch = guardRendererEpoch
      const current = (): void => {
        trusted(event)
        live()
        if (epoch !== guardRendererEpoch) throw new Error('本次Sub-Store页面意图已失效。')
        requireSubStoreIdle()
      }
      current()
      return current
    }
    ipcMain.handle('relaySubStoreAdvancedAcquire', (event, input: unknown) =>
      subStore.advancedAcquire(input, subStoreIntent(event))
    )
    ipcMain.handle('relaySubStoreAdvancedStart', (event, input: unknown) =>
      subStore.advancedStart(input, subStoreIntent(event))
    )
    ipcMain.handle('relaySubStoreAcquire', (event, input: unknown) => {
      trusted(event)
      requireSubStoreIdle()
      void input
      throw new Error('请改为选择保存的静态节点，使用Sub-Store独立出口。')
    })
    ipcMain.handle('relaySubStoreStart', (event, input: unknown) => {
      trusted(event)
      requireSubStoreIdle()
      void input
      throw new Error('请改为选择保存的静态节点，使用Sub-Store独立出口。')
    })
    ipcMain.handle('relaySubStoreStop', async (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('停止只接受本次服务。')
      ++subStoreWindowEpoch
      subStoreWindow?.destroy()
      subStoreWindow = undefined
      return subStore.stop()
    })
    ipcMain.handle('relaySubStoreOpen', async (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('打开不接受任意地址。')
      requireSubStoreIdle()
      if (!subStore.frontendURL()) throw new Error('本次Sub-Store尚未就绪。')
      if (subStoreWindow && !subStoreWindow.isDestroyed()) {
        subStoreWindow.show()
        subStoreWindow.focus()
        return
      }
      if (!subStoreOpening) {
        const epoch = subStoreWindowEpoch
        subStoreOpening = openSubStoreWindow(subStore)
          .then((opened) => {
            if (epoch !== subStoreWindowEpoch || !subStore.frontendURL()) {
              opened.destroy()
              throw new Error('服务在打开期间已结束。')
            }
            subStoreWindow = opened
            return opened
          })
          .finally(() => {
            subStoreOpening = undefined
          })
      }
      await subStoreOpening
    })
    ipcMain.handle('relaySubStoreRecover', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('归档只接受本次旧会话记录。')
      requireSubStoreIdle()
      return subStore.recover(subStoreIntent(event))
    })
    ipcMain.handle('relaySubStoreList', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('列表不接受参数。')
      requireSubStoreIdle()
      return subStore.list()
    })
    ipcMain.handle('relaySubStoreConvert', (event, input: unknown) => {
      trusted(event)
      requireSubStoreIdle()
      return subStore.prepareConversion(input)
    })
    ipcMain.handle('relaySubStoreSave', (event, input: unknown) => {
      trusted(event)
      requireSubStoreIdle()
      return subStore.saveConversion(input, subStoreIntent(event))
    })
    ipcMain.handle('relaySubStoreCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消不接受参数。')
      subStore.cancel()
    })
    ipcMain.handle('relayOverrideLibraryList', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('覆写库列表不接受参数。')
      return overrideLibrary.list()
    })
    ipcMain.handle('relayOverrideLibraryRead', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.read(input)
    })
    ipcMain.handle('relayOverrideLibraryCreate', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.create(input)
    })
    ipcMain.handle('relayOverrideLibrarySaveMetadata', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.saveMetadata(input)
    })
    ipcMain.handle('relayOverrideLibrarySaveBody', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.saveBody(input)
    })
    ipcMain.handle('relayOverrideLibraryRemove', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.remove(input)
    })
    ipcMain.handle('relayOverrideLibraryBindingsRead', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.bindings(input)
    })
    ipcMain.handle('relayOverrideLibraryBind', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.bind(input)
    })
    ipcMain.handle('relayOverrideLibraryRefresh', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.refresh(input)
    })
    ipcMain.handle('relayOverrideLibraryOrder', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.order(input)
    })
    ipcMain.handle('relayOverrideLibraryFetchExecute', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.fetchExecute(input)
    })
    ipcMain.handle('relayOverrideLibraryFetchPrepare', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.fetchPrepare(input, runtimeGistContext())
    })
    ipcMain.handle('relayOverrideLibraryFetchCancel', (event, input: unknown) => {
      trusted(event)
      return overrideLibrary.fetchCancel(input) ? overrideLibrary.whenIdle() : undefined
    })
    ipcMain.handle('relayBackupRemotePrepare', (event, input: unknown) => {
      trusted(event)
      const context = legacyRemoteContext(input)
      return context ? remoteBackup.prepare(input, undefined, context) : remoteBackup.prepare(input)
    })
    ipcMain.handle('relayBackupRemoteExecute', (event, input: unknown) => {
      trusted(event)
      return remoteBackup.execute(input)
    })
    ipcMain.handle('relayBackupRemoteCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消不接受参数。')
      remoteBackup.cancel()
    })
    ipcMain.handle('relayRuntimeGistPrepare', (event, input: unknown) => {
      trusted(event)
      return runtimeGist.prepare(input, undefined, runtimeGistContext())
    })
    ipcMain.handle('relayRuntimeGistExecute', (event, input: unknown) => {
      trusted(event)
      return runtimeGist.execute(input)
    })
    ipcMain.handle('relayRuntimeGistCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消不接受参数。')
      runtimeGist.cancel()
    })
    ipcMain.handle('relayRuntimeGistDiscoveryPrepare', (event, input: unknown) => {
      trusted(event)
      return runtimeGistDiscovery.prepare(input, runtimeGistContext())
    })
    ipcMain.handle('relayRuntimeGistDiscoveryExecute', (event, input: unknown) => {
      trusted(event)
      return runtimeGistDiscovery.execute(input)
    })
    ipcMain.handle('relayRuntimeGistDiscoveryCancel', (event, input: unknown) => {
      trusted(event)
      return runtimeGistDiscovery.cancel(input) ? runtimeGistDiscovery.whenIdle() : undefined
    })
    ipcMain.handle('relayRuntimeGistSyncState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('自动同步状态不接受参数。')
      return runtimeGistSync.state()
    })
    ipcMain.handle('relayRuntimeGistSyncArm', (event, input: unknown) => {
      trusted(event)
      return runtimeGistSync.arm(input)
    })
    ipcMain.handle('relayRuntimeGistSyncStop', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('停用自动同步不接受参数。')
      return runtimeGistSync.stop('stopped')
    })
    ipcMain.handle('relayBackupExport', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('导出不接受参数。')
      return backupService.export()
    })
    ipcMain.handle('relayBackupAccountList', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('备份账号列表不接受参数。')
      return backupAccounts.list()
    })
    ipcMain.handle('relayBackupAccountSave', (event, input: unknown) => {
      trusted(event)
      return backupAccounts.save(input).then(async (account) => {
        webdavDirectory.cancel()
        runtimeGistDiscovery.invalidate()
        overrideLibrary.invalidate()
        if (runtimeGistSync.state().account?.id === account.id)
          await runtimeGistSync.stop('accountChanged')
        await webdavBackupScheduler.accountChanged({ id: account.id })
        return account
      })
    })
    ipcMain.handle('relayBackupAccountDisable', (event, input: unknown) => {
      trusted(event)
      return backupAccounts.disable(input).then(async (account) => {
        webdavDirectory.cancel()
        runtimeGistDiscovery.invalidate()
        overrideLibrary.invalidate()
        if (runtimeGistSync.state().account?.id === account.id)
          await runtimeGistSync.stop('accountChanged')
        await webdavBackupScheduler.accountChanged({ id: account.id })
        return account
      })
    })
    ipcMain.handle('relayBackupAccountPrepareRemote', (event, input: unknown) => {
      trusted(event)
      const context = legacyRemoteContext(input)
      return context
        ? backupAccounts.prepareRemote(input, context)
        : backupAccounts.prepareRemote(input)
    })
    ipcMain.handle('relayBackupAccountPrepareRuntime', (event, input: unknown) => {
      trusted(event)
      if (runtimeGistSync.isBusy() || runtimeGistSync.state().enabled)
        throw new Error('请先停止运行配置自动同步，再准备手动上传。')
      return backupAccounts.prepareRuntime(input, runtimeGistContext())
    })
    ipcMain.handle('relayBackupScheduleState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('定时备份状态不接受参数。')
      return webdavBackupScheduler.state()
    })
    ipcMain.handle('relayBackupScheduleArm', (event, input: unknown) => {
      trusted(event)
      if (!canRunWebdavBackup())
        throw new Error('请先结束正在处理的数据或核心转换操作，再开启本次定时备份。')
      return webdavBackupScheduler.arm(input, runtimeGistContext())
    })
    ipcMain.handle('relayBackupScheduleStop', (event, input: unknown) => {
      trusted(event)
      return webdavBackupScheduler.disarm(input)
    })
    ipcMain.handle('relayBackupDirectoryPrepare', (event, input: unknown) => {
      trusted(event)
      const ownerWindow = window,
        rendererEpoch = backupRendererEpoch,
        frame = (() => {
          try {
            return ownerWindow?.webContents.isDestroyed()
              ? undefined
              : ownerWindow?.webContents.mainFrame
          } catch {
            return undefined
          }
        })()
      const recheck = (): void => {
        let live = false
        try {
          live =
            !!ownerWindow &&
            !!frame &&
            window === ownerWindow &&
            !ownerWindow.isDestroyed() &&
            !ownerWindow.webContents.isDestroyed() &&
            ownerWindow.isVisible() &&
            ownerWindow.webContents.mainFrame === frame &&
            backupRendererEpoch === rendererEpoch &&
            !quitAfterRestore &&
            !shellQuitting
        } catch {
          /* A closing document cannot retain a pending creation capability. */
        }
        if (!live) throw new Error('本次WebDAV目录界面授权已失效。')
      }
      return webdavDirectory.prepare(input, recheck)
    })
    ipcMain.handle('relayBackupDirectoryExecute', (event, input: unknown) => {
      trusted(event)
      return webdavDirectory.execute(input)
    })
    ipcMain.handle('relayBackupDirectoryCancel', (event, input: unknown) => {
      trusted(event)
      const { evidenceId } = webdavDirectoryEvidence(input)
      if (webdavDirectory.cancel(evidenceId)) return webdavDirectory.whenIdle()
      return undefined
    })
    ipcMain.handle('relayBackupRecoveryList', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('恢复记录列表不接受参数。')
      requireIndependentOperationIdle()
      return backupService.listRecoveryRecords()
    })
    ipcMain.handle('relayBackupLegacyPrepare', (event, input: unknown) => {
      trusted(event)
      return backupService.prepareLegacyImport(input)
    })
    ipcMain.handle('relayBackupLegacyRelayInspect', (event, input: unknown) => {
      trusted(event)
      return backupService.inspectLegacyRelay(input, runtimeGistContext())
    })
    ipcMain.handle('relayBackupLegacyRelayPrepare', (event, input: unknown) => {
      trusted(event)
      return backupService.prepareLegacyRelayImport(input)
    })
    ipcMain.handle('relayBackupRecoveryPrepare', (event, input: unknown) => {
      trusted(event)
      return backupService.prepareRecovery(input)
    })
    ipcMain.handle('relayBackupRecoveryCommit', (event, input: unknown) => {
      trusted(event)
      runtimeGistDiscovery.invalidate()
      overrideLibrary.invalidate()
      return Promise.all([
        runtimeGistSync.stop('restored'),
        webdavDirectory.requestClose(),
        geoOrigins.requestClose(),
        geoScheduler.requestClose(),
        runtimeGistDiscovery.whenIdle(),
        overrideLibrary.whenIdle()
      ]).then(() => backupService.commitRecovery(input))
    })
    ipcMain.handle('relayBackupRecoveryCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消不接受参数。')
      backupService.cancel()
    })
    ipcMain.handle('relayBackupKeyExport', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('密钥生成只接受原生确认和文件选择，不接受参数。')
      return backupService.exportKey()
    })
    ipcMain.handle('relayBackupImportPrepare', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('导入只接受系统文件选择。')
      return backupService.prepareImport()
    })
    ipcMain.handle('relayBackupRestore', (event, input: unknown) => {
      trusted(event)
      runtimeGistDiscovery.invalidate()
      overrideLibrary.invalidate()
      return Promise.all([
        runtimeGistSync.stop('restored'),
        webdavDirectory.requestClose(),
        geoOrigins.requestClose(),
        geoScheduler.requestClose(),
        runtimeGistDiscovery.whenIdle(),
        overrideLibrary.whenIdle()
      ]).then(() => backupService.restore(input))
    })
    ipcMain.handle('relayBackupCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消不接受参数。')
      backupService.cancel()
    })
    ipcMain.handle('checkAutoRun', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('登录项读取不接受参数。')
      return loginItem.read()
    })
    ipcMain.handle('enableAutoRun', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('登录项更改不接受路径、参数或授权标记。')
      return loginItem.set(true)
    })
    ipcMain.handle('disableAutoRun', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('登录项更改不接受路径、参数或授权标记。')
      return loginItem.set(false)
    })
    ipcMain.handle('relayShellThemesAcquire', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined)
        throw new Error('在线主题只接受固定官方来源，不接受URL、端口或正文。')
      return themeService.acquire()
    })
    ipcMain.handle('relayShellThemesDraft', (event, input: unknown) => {
      trusted(event)
      return themeService.draft(input)
    })
    ipcMain.handle('relayShellThemesCancel', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('取消主题获取不接受参数。')
      themeService.cancel()
    })
    ipcMain.handle('getTrayTrafficStyle', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('托盘样式读取不接受参数。')
      return shellHost.trayTrafficStyle()
    })
    ipcMain.handle('relayTrayTrafficFrame', (event, input: unknown) => {
      trusted(event)
      if (!quitAfterRestore && !shellQuitting) shellHost.receiveTrayTrafficFrame(input)
    })
    ipcMain.handle('relayShellTrayIconImport', (event, input: unknown) => {
      const current = (): void => {
        trusted(event)
        if (loginItem.isBusy() || shellQuitting || quitAfterRestore)
          throw new Error('登录项或退出操作尚未结束。')
      }
      current()
      if (input !== undefined) throw new Error('图标导入仅使用本次文件选择器，不接受路径或正文。')
      requireCompleteIdle()
      return shellWorkflow.importTrayIcon(current)
    })
    ipcMain.handle('relayShellThemeFilesImport', (event, input: unknown) => {
      const assertCurrent = (): void => {
        trusted(event)
        if (loginItem.isBusy() || shellQuitting || quitAfterRestore)
          throw new Error('登录项或退出操作尚未结束。')
      }
      assertCurrent()
      if (input !== undefined) throw new Error('主题导入只使用系统文件选择器，不接受路径或正文。')
      requireCompleteIdle()
      return shellWorkflow.importThemeFiles(assertCurrent)
    })
    ipcMain.handle('relayShellCSSImport', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('CSS导入只使用系统文件选择器，不接受路径或正文。')
      requireCompleteIdle()
      if (loginItem.isBusy() || shellQuitting) throw new Error('登录项或退出操作尚未结束。')
      return shellWorkflow.importCSS()
    })
    ipcMain.handle('relayShellState', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('窗口状态不接受参数。')
      return shellWorkflow.state()
    })
    ipcMain.handle('relayShellInitialize', (event, input: unknown) => {
      trusted(event)
      if (
        quitAfterRestore ||
        backupService.isBusy() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy() ||
        runtimeGistDiscovery.isBusy() ||
        overrideLibrary.isBusy() ||
        backupAccounts.isBusy() ||
        webdavBackupScheduler.isBusy() ||
        loginItem.isBusy()
      )
        throw new Error('退出、备份恢复或登录项操作正在进行。')
      if (input !== undefined) throw new Error('恢复窗口工作流不接受参数。')
      return shellWorkflow.initialize(false)
    })
    ipcMain.handle('relayShellSave', (event, input: unknown) => {
      trusted(event)
      if (
        quitAfterRestore ||
        backupService.isBusy() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy() ||
        runtimeGistDiscovery.isBusy() ||
        overrideLibrary.isBusy() ||
        backupAccounts.isBusy() ||
        webdavBackupScheduler.isBusy() ||
        loginItem.isBusy()
      )
        throw new Error('退出或备份恢复正在进行。')
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'revision,settings'
      )
        throw new Error('窗口设置消息无效。')
      const request = input as { settings: unknown; revision: unknown }
      return shellWorkflow.save(request.settings, request.revision)
    })
    ipcMain.handle('relayShellAction', (event, input: unknown) => {
      trusted(event)
      return shellWorkflow.perform(input)
    })
    ipcMain.handle('relaunchApp', (event, input: unknown) => {
      trusted(event)
      if (input !== undefined) throw new Error('重启不接受路径、参数或授权标记。')
      return shellWorkflow.perform('restartApp')
    })
    ipcMain.handle('quitApp', (event) => {
      trusted(event)
      app.quit()
    })
    ipcMain.handle('openDevTools', (event) => {
      trusted(event)
      window?.webContents.openDevTools({ mode: 'detach' })
    })
    const clearCustomCSS = async (): Promise<void> => {
      if (automaticUninstallRequested || quitAfterRestore || shellQuitting || loginItem.isBusy())
        throw new Error('退出或登录项操作尚未结束。')
      requireCompleteIdle()
      const record = shellWorkflow.state()
      await shellWorkflow.save({ ...record.settings, customCSS: '' }, record.revision)
      shellHost.showWindow()
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Relay',
          submenu: [
            { role: 'about' },
            {
              label: '重启Relay…',
              click: () => {
                void shellWorkflow.perform('restartApp').catch(() => {
                  shellHost.showWindow()
                  if (window && !window.isDestroyed())
                    void dialog
                      .showMessageBox(window, {
                        type: 'warning',
                        title: '重启未确认',
                        message: '请先完成当前操作后重新明确请求；没有安排自动重试。',
                        buttons: ['返回工作区'],
                        defaultId: 0,
                        cancelId: 0
                      })
                      .catch(() => {})
                })
              }
            },
            {
              label: '打开开发者工具',
              click: () => window?.webContents.openDevTools({ mode: 'detach' })
            },
            {
              label: '清除自定义界面样式',
              click: () => {
                void clearCustomCSS().catch(() => {
                  shellHost.showWindow()
                  if (window && !window.isDestroyed())
                    void dialog
                      .showMessageBox(window, {
                        type: 'warning',
                        title: '界面样式恢复未确认',
                        message: '请等待当前操作结束后重试；没有覆盖未知修改。',
                        buttons: ['返回'],
                        defaultId: 0,
                        cancelId: 0
                      })
                      .catch(() => {})
                })
              }
            },
            { type: 'separator' },
            { role: 'quit' }
          ]
        },
        { role: 'editMenu' },
        { role: 'windowMenu' }
      ])
    )
    await floatingGeometryHost.restore()
    for (const warning of floatingGeometryHost.state().warnings) console.warn(warning)
    const restoredGeometry = await geometryHost.restore()
    for (const warning of geometryHost.state().warnings) console.warn(warning)
    window = new BrowserWindow({
      title: 'Relay',
      show: false,
      acceptFirstMouse: process.platform === 'darwin',
      frame: startupWindowPreferences.useWindowFrame,
      ...(startupWindowPreferences.useWindowFrame
        ? {}
        : { titleBarStyle: 'hidden' as const, titleBarOverlay: { height: 47 } }),
      ...restoredGeometry.bounds,
      minWidth: restoredGeometry.minWidth,
      minHeight: restoredGeometry.minHeight,
      backgroundColor: '#f7f8fa',
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const page = join(__dirname, '../renderer/index.html')
    window.webContents.on('will-prevent-unload', () => {
      // preventDefault here would override the renderer's refusal to close.
      recoverCancelledQuit()
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (url.split('#')[0] !== pathToFileURL(page).href) event.preventDefault()
    })
    const notifyBackupPreparationsInvalidated = (): void => {
      try {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send('relayBackupPreparationsInvalidated')
      } catch {
        // Authority is already revoked even if the closing renderer is gone.
      }
    }
    window.on('hide', () => {
      scopedCLI?.invalidateStorageIntent()
      invalidateSubStoreNetwork()
      isolatedProbes?.invalidate()
      providers.invalidateBatch()
      if (!restartCoordinator?.isFinalQuitInProgress()) restartCoordinator?.quitCancelled()
      onlineThemes?.cancel()
      ++backupRendererEpoch
      invalidateSimpleRenderer(startupContentReady || startupRequested)
      tunSession.invalidateRules()
      tunSession.invalidateInteractiveResources()
      geoOrigins.cancelInteractive()
      void runtimeGistSync.stop('hidden')
      webdavDirectory.cancel()
      runtimeGistDiscovery.invalidate()
      overrideLibrary.invalidate()
      backupAccounts.cancel()
      backupService.invalidatePending()
      void webdavBackupScheduler.requestClose()
      notifyBackupPreparationsInvalidated()
    })
    window.on('close', (event) => {
      scopedCLI?.invalidateStorageIntent()
      if (admitsRetainedQuit()) {
        queueMicrotask(() => {
          if (event.defaultPrevented) recoverCancelledQuit()
        })
        return
      }
      if (
        retainedExitPending ||
        ordinaryCoreOwner.isOperating() ||
        ordinaryCoreOwner.retained() ||
        (ordinaryCoreOwner.isBlocking() && !ordinaryCoreOwner.ownsLocalInstance())
      ) {
        event.preventDefault()
        retainedExitPass = undefined
        shellHost.showWindow()
        return
      }
      isolatedProbes?.invalidate()
      const internalFinal = restart.isFinalQuitInProgress()
      if (!internalFinal) {
        if (!shellQuitting) restart.backgroundChosen()
        else {
          restart.ordinaryQuit()
          ordinaryQuitRequested = true
        }
      }
      const generation = restart.state().generation
      let drainingHere = false
      queueMicrotask(() => {
        if (!drainingHere && event.defaultPrevented && internalFinal)
          recoverCancelledQuit(generation)
      })
      geometryHost.capture()
      floatingGeometryHost.capture()
      // The window's close control always keeps Relay and its owned core in
      // the background. Only an explicit app/menu quit enters shutdown below.
      if (!shellQuitting && !internalFinal) {
        event.preventDefault()
        invalidateRendererEpochs()
        invalidateSimpleRenderer()
        tunSession.invalidateRules()
        tunSession.invalidateInteractiveResources()
        geoOrigins.cancelInteractive()
        void runtimeGistSync.stop('hidden')
        webdavDirectory.cancel()
        runtimeGistDiscovery.invalidate()
        overrideLibrary.invalidate()
        backupAccounts.cancel()
        backupService.invalidatePending()
        void webdavBackupScheduler.requestClose()
        notifyBackupPreparationsInvalidated()
        window?.hide()
        return
      }
      if (
        (geometryHost.state().writable &&
          (geometryHost.state().dirty || geometryHost.state().pending)) ||
        (floatingGeometryHost.state().writable &&
          (floatingGeometryHost.state().dirty || floatingGeometryHost.state().pending)) ||
        updates.isBusy() ||
        extendedWorkflowBusy() ||
        !!appUpdates?.isBusy() ||
        (!maintenanceAssertion && (!!maintenance?.isBusy() || localPreferencesBusy())) ||
        (!ownedResetAssertion && ownedResetService.isBusy()) ||
        plugins.isBlocking() ||
        pluginScheduler.isBlocking() ||
        remoteBackup.isBusy() ||
        runtimeGist.isBusy() ||
        runtimeGistDiscovery.isBusy() ||
        overrideLibrary.isBusy() ||
        runtimeGistSync.isBusy() ||
        webdavDirectory.isBusy() ||
        backupAccounts.isBusy() ||
        webdavBackupScheduler.isBusy() ||
        configurationEdit.isBusy() ||
        simple.isBusy() ||
        publication.isBusy() ||
        subStore.isBlocking() ||
        backupService.isBusy() ||
        shellWorkflow.isBusy() ||
        isolatedProbes?.isBlocking() ||
        loginItem.isBusy() ||
        trayWorkflows?.isBusy() ||
        variantService.isBusy() ||
        recovery.isRestoring() ||
        code.isApplying() ||
        desktop.isBlocking() ||
        edge.isBusy() ||
        core.isBlocking() ||
        profiles.isBusy() ||
        subscriptions.isBusy() ||
        providers.isBusy() ||
        subscriptionSources.isBusy() ||
        sourceScheduler.isBusy() ||
        resources.isBusy() ||
        geoOrigins.isBusy() ||
        geoScheduler.isBusy() ||
        profileRuntime.isBusy() ||
        completeConfiguration.isBusy() ||
        coreRecordRecovery.isBusy() ||
        clashBackend.isBusy() ||
        localProxy.isBlocking() ||
        tunSession.isBlocking() ||
        (!finalQuitPassedSystemProxy && systemProxy.isBlocking())
      ) {
        event.preventDefault()
        drainingHere = true
        waitToQuit()
      }
    })
    window.on('closed', () => {
      invalidateSubStoreNetwork()
      onlineThemes?.cancel()
      invalidateRendererEpochs()
      invalidateSimpleRenderer()
      tunSession.invalidateRules()
      tunSession.invalidateResources()
      void geoOrigins.requestClose()
      void runtimeGistSync.stop('rendererChanged')
      webdavDirectory.cancel()
      runtimeGistDiscovery.invalidate()
      overrideLibrary.invalidate()
      ++subStoreWindowEpoch
      subStoreWindow?.destroy()
      subStoreWindow = undefined
      trayWorkflows?.dispose()
      trayWorkflows = undefined
      shellWorkflow.dispose()
      geometryHost.dispose()
      floatingGeometryHost.dispose()
      powerMonitor.removeListener('suspend', onSuspend)
      powerMonitor.removeListener('suspend', onRuntimeGistSuspend)
      powerMonitor.removeListener('suspend', onBackupSuspend)
      powerMonitor.removeListener('resume', onResume)
      void coreLifecycle.close()
      coreRecordRecovery.clear()
      systemProxy.clear()
      artifacts.clear()
      diagnostics.clear()
      recovery.clear()
      code.clear()
      profiles.clear()
      void sourceScheduler.requestClose()
      void geoScheduler.requestClose()
      void pluginScheduler.requestClose()
      remoteBackup.cancel()
      resources.clear()
      runtimeGist.cancel()
      backupAccounts.cancel()
      void webdavBackupScheduler.requestClose()
      backupService.invalidatePending()
      subscriptionSources.clear()
      subscriptions.clear()
      providers.clear()
      profileRuntime.clear()
      completeConfiguration.clear()
      localProxy.clear()
      tunSession.clear()
      descriptorInbox.clear()
      notifyOpenedDescriptor = undefined
      window = null
    })
    notifyOpenedDescriptor = () => {
      if (!window || window.isDestroyed()) return
      if (descriptorInbox.hasPending()) shellHost.showWindow()
      window.webContents.send('openPluginFile', { pending: descriptorInbox.hasPending() })
    }
    browserBindingReady = await browserBinding.start()
    if (!browserBindingReady)
      console.warn('Relay专用浏览器通道未就绪；保留普通代理，浏览器和Claude配置入口拒绝操作。')
    geometryHost.attach(window)
    if (restoredGeometry.maximized) window.maximize()
    const startupWindow = window
    let startupContentReady = false,
      startupRequested = false,
      startupNavigationSeen = false
    const startSelectedProfile = (): void => {
      if (
        automaticUninstallRequested ||
        startupRequested ||
        !startupContentReady ||
        startupWindow.isDestroyed() ||
        !startupWindow.isVisible()
      )
        return
      startupRequested = true
      void profileStartup?.run().then((status) => {
        if (status === 'failed')
          void mainWindowLogger.warn(
            'Relay selected-profile startup was not confirmed; no automatic retry'
          )
      })
    }
    startupWindow.on('show', () => {
      startupWindow.webContents.send('relayWorkspaceVisible')
      startSelectedProfile()
    })
    let shellInitialization: Promise<void> | undefined
    const initializeShell = (): Promise<void> =>
      (shellInitialization ??= (async () => {
        try {
          await shellWorkflow.whenIdle()
          if (startupWindow.isDestroyed()) return
          if (!shellWorkflow.state().initialized)
            await shellWorkflow.initialize(!rendererStartup.hasFailed())
        } catch {
          if (!startupWindow.isDestroyed()) shellHost.showWindow()
        } finally {
          // Saved silent-start settings must not hide a failure reported while
          // initialization was in flight, or a page that recovered after timeout.
          if (rendererStartup.hasFailed() && !startupWindow.isDestroyed()) shellHost.showWindow()
        }
        if (!startupWindow.isDestroyed() && descriptorInbox.hasPending()) notifyOpenedDescriptor?.()
        if (!rendererStartup.hasFailed()) {
          startupContentReady = true
          startSelectedProfile()
        }
      })())
    const rendererStartup = watchRendererStartup(startupWindow, {
      ready: () => {
        void mainWindowLogger.info('Relay renderer first-content-ready')
        void initializeShell()
      },
      failed: (reason) => {
        if (!restartCoordinator?.isFinalQuitInProgress()) restartCoordinator?.quitCancelled()
        onlineThemes?.cancel()
        invalidateRendererEpochs()
        invalidateSimpleRenderer()
        tunSession.invalidateRules()
        tunSession.invalidateInteractiveResources()
        geoOrigins.cancelInteractive()
        void runtimeGistSync.stop('rendererChanged')
        webdavDirectory.cancel()
        runtimeGistDiscovery.invalidate()
        overrideLibrary.invalidate()
        backupService.invalidatePending()
        backupAccounts.cancel()
        void webdavBackupScheduler.requestClose()
        void mainWindowLogger.error(`Relay renderer startup: ${reason}`)
        // Keep the same window, native hosts and recovery obligations. Reloading
        // or destroying it would silently run the closed-handler cleanup below.
        shellHost.showWindow()
        const notice = new AbortController()
        void dialog
          .showMessageBox(startupWindow, {
            signal: notice.signal,
            type: 'error',
            title: 'Relay 界面未就绪',
            message: 'Relay 界面加载失败。',
            detail: `错误阶段：${reason}。已有会话和恢复通道保留，请查看诊断详情。`,
            buttons: ['打开开发者工具', '保留窗口'],
            defaultId: 0,
            cancelId: 1
          })
          .then(({ response }) => {
            if (response === 0 && !notice.signal.aborted && !startupWindow.isDestroyed())
              startupWindow.webContents.openDevTools({ mode: 'detach' })
          })
          .catch(() => {})
        return () => notice.abort()
      }
    })
    const invalidateGuardIntent = (): void => {
      invalidateSubStoreNetwork()
      isolatedProbes?.invalidate()
      appUpdates?.cancel()
      maintenance?.cancel()
      ownedResetService.invalidate()
      ++guardRendererEpoch
      guardManagement?.invalidateIntent()
      void scopedCLI?.invalidateIntent().catch(() => {})
    }
    startupWindow.webContents.on('render-process-gone', () => {
      invalidateGuardIntent()
      providers.invalidateBatch()
      artifacts.clear()
      diagnostics.clear()
      code.clear()
      invalidateRendererEpochs()
      backupService.invalidatePending()
    })
    startupWindow.on('closed', invalidateGuardIntent)
    startupWindow.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) providers.invalidateBatch()
    })
    startupWindow.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame) {
        invalidateGuardIntent()
        providers.invalidateBatch()
      }
      if (details.isMainFrame && !details.isSameDocument) {
        const initialNavigation = !startupNavigationSeen && !startupContentReady
        startupNavigationSeen = true
        artifacts.clear()
        diagnostics.clear()
        code.clear()
        if (!restartCoordinator?.isFinalQuitInProgress()) restartCoordinator?.quitCancelled()
        onlineThemes?.cancel()
        invalidateRendererEpochs()
        invalidateSimpleRenderer(!initialNavigation)
        tunSession.invalidateRules()
        tunSession.invalidateInteractiveResources()
        geoOrigins.cancelInteractive()
        void runtimeGistSync.stop('rendererChanged')
        webdavDirectory.cancel()
        runtimeGistDiscovery.invalidate()
        overrideLibrary.invalidate()
        backupService.invalidatePending()
        backupAccounts.cancel()
        void webdavBackupScheduler.requestClose()
      }
    })
    // The root-owned intent survives moving/emptying Trash. Stop admitting new
    // actions before any await, then use the existing ownership-aware quit drain.
    const automaticUninstall = startAutomaticUninstallMonitor({
      platform: process.platform,
      packaged: app.isPackaged,
      onRequested: async (executable) => {
        automaticUninstallRequested = true
        uninstallNativeExecutable = executable
        if (quitAfterRestore || shellQuitting) return
        await closePrivateBrowserForUninstall()
        await loginItem.whenIdle()
        loginRegistration.write(false)
        if (loginRegistration.read().openAtLogin)
          throw new Error('Relay 登录项尚未停用，保留卸载记录以便重试。')
        if (quitAfterRestore || shellQuitting) return
        restart.ordinaryQuit()
        app.quit()
      }
    })
    app.on('quit', () => automaticUninstall.stop())
    // Register before loading: the renderer may send ready before loadFile resolves.
    void startupWindow
      .loadFile(page, {
        hash: uiPreferences.state().value.rememberSelectedSiderCard ? '/' : '/relay'
      })
      .catch(rendererStartup.loadFailed)
    await rendererStartup.firstContent
    await shellInitialization
    if (!automaticUninstallRequested) void terminalCLI?.start()
  })
  .catch((error: unknown) => {
    console.error(
      'Relay initialization failed:',
      error instanceof Error ? error.message : 'Unknown error'
    )
    app.exit(1)
  })
app.on('window-all-closed', () => app.quit())
