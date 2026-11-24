import { RelayCoreOwnerPanel } from '@renderer/components/relay/core-owner-panel'
import { RelayAppUpdatePanel } from '@renderer/components/relay/app-update-panel'
import { RelayGuardManagementPanel } from '@renderer/components/relay/guard-management-panel'
import { RelayGuardScopedCLIPanel } from '@renderer/components/relay/guard-scoped-cli-panel'
import { RelayMaintenancePanel } from '@renderer/components/relay/maintenance-panel'
import { RelayUIPreferencesPanel } from '@renderer/components/relay/ui-preferences-panel'
import { RelayOwnedResetPanel } from '@renderer/components/relay/owned-reset-panel'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import useSWR from 'swr'
import { relayProxyPageOwner } from '@renderer/utils/ipc'
import {
  getRelayWorkspacePanel,
  RELAY_WORKSPACE_PANELS,
  relayWorkspaceLink
} from '@renderer/utils/relay-workspace'
import {
  RelayWorkspaceSection,
  RelayWorkspaceTabs
} from '@renderer/components/relay/workspace-section'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import BasePage from '@renderer/components/base/base-page'
import { RelayOverviewPanel } from '@renderer/components/relay/overview-panel'
import { RelayDraftArtifacts } from '@renderer/components/relay/draft-artifacts'
import { RelayDiagnosticsPanel } from '@renderer/components/relay/diagnostics-panel'
import { RelayRecoveryPanel } from '@renderer/components/relay/recovery-panel'
import { RelayCodePanel } from '@renderer/components/relay/code-panel'
import { RelayDesktopReadinessPanel } from '@renderer/components/relay/desktop-readiness-panel'
import { RelayDesktopSessionPanel } from '@renderer/components/relay/desktop-session-panel'
import { RelayEdgePanel } from '@renderer/components/relay/edge-panel'
import { RelayGuardReadinessPanel } from '@renderer/components/relay/guard-readiness-panel'
import { RelayCorePanel } from '@renderer/components/relay/core-panel'
import { RelayCoreRecoveryPanel } from '@renderer/components/relay/core-recovery-panel'
import { RelaySystemProxyPanel } from '@renderer/components/relay/system-proxy-panel'
import { RelayTunPanel } from '@renderer/components/relay/tun-panel'
import { RelayProfilesPanel } from '@renderer/components/relay/profiles-panel'
import { RelaySimpleEditor } from '@renderer/components/relay/simple-editor'
import { RelaySubscriptionPanel } from '@renderer/components/relay/subscription-panel'
import { RelaySubscriptionsDashboard } from '@renderer/components/relay/subscriptions-dashboard'
import { relayProfileRead } from '@renderer/components/relay/profile-read-queue'
import {
  activateCachedProfile,
  chooseActiveTunProfile,
  relayProxyRunning
} from '@renderer/components/relay/proxy-library-actions'
import { RelaySubscriptionSourcesPanel } from '@renderer/components/relay/subscription-sources-panel'
import { RelayResourcesPanel } from '@renderer/components/relay/resources-panel'
import { RelayGeoDataPanel } from '@renderer/components/relay/geodata-panel'
import { RelayProvidersPanel } from '@renderer/components/relay/providers-panel'
import { RelayRuntimePanel } from '@renderer/components/relay/runtime-panel'
import { RelayRulesManager } from '@renderer/components/relay/rules-panel'
import { adoptRuleState } from '@renderer/utils/relay-rule-editor'
import { RelayConfigurationEditPanel } from '@renderer/components/relay/configuration-edit-panel'
import { RelayLocalProxyPanel } from '@renderer/components/relay/local-proxy-panel'
import { saveLocalProxyPlan } from '@renderer/components/relay/local-proxy-plan-actions'
import { RelaySmartToolsPanel } from '@renderer/components/relay/smart-tools-panel'
import { RelayPluginsPanel } from '@renderer/components/relay/plugins-panel'
import { RelayUpdatePanel } from '@renderer/components/relay/update-panel'
import { RelaySubStorePanel } from '@renderer/components/relay/substore-panel'
import { RelayRemoteBackupPanel } from '@renderer/components/relay/backup-remote-panel'
import { RelayRuntimeGistPanel } from '@renderer/components/relay/runtime-gist-panel'
import { RelayRuntimeGistSyncPanel } from '@renderer/components/relay/runtime-gist-sync-panel'
import { RelayBackupPanel } from '@renderer/components/relay/backup-panel'
import { RelayBackupAccountPanel } from '@renderer/components/relay/backup-account-panel'
import { RelayWebdavBackupSchedulerPanel } from '@renderer/components/relay/webdav-backup-scheduler-panel'
import { RelayWebdavDirectoryPanel } from '@renderer/components/relay/webdav-directory-panel'
import { RelayLoginItemSetting } from '@renderer/components/relay/login-item-setting'
import { RelayShellPanel } from '@renderer/components/relay/shell-panel'
import { RelayVariantsPanel } from '@renderer/components/relay/variants-panel'
import { RelayRuntimeInfoPanel } from '@renderer/components/relay/runtime-info-panel'
import { RelayAiClientsPanel } from '@renderer/components/relay/ai-clients-panel'
import {
  RelayPreferencesPanel,
  mergeLoadedPreferences
} from '@renderer/components/relay/preferences-panel'
import type { RelayShellState } from '../../../shared/relay/shell'
import { SIMPLE_MODULES, type SimpleModule } from '../../../shared/simple-config'
import type { TunSessionState } from '../../../shared/relay/tun'
import type { DedicatedListenerPlan } from '../../../shared/relay/dedicated-listeners'
import {
  localProxyPlanRecord,
  type LocalProxyPlanRecord
} from '../../../shared/relay/local-proxy-plan'
import {
  localProxyHTTPPort,
  localProxyPorts,
  type LocalProxyPorts
} from '../../../shared/relay/local-proxy-ports'
import type {
  RelayRemoteBackupPlan,
  RelayRemoteBackupResult
} from '../../../shared/relay/backup-remote'
import type {
  RelayRuntimeGistPlan,
  RelayRuntimeGistResult
} from '../../../shared/relay/runtime-gist'
import type {
  SubscriptionPreparation,
  SubscriptionDownloadResult,
  SubscriptionState
} from '../../../shared/relay/subscription'
import type {
  RelayProfileSelection,
  RelayRuntimePreparation,
  RelayRuntimeCheckResult
} from '../../../shared/relay/runtime'
import type {
  RelayProfilePreparation,
  RelayProfileInventory,
  RelayProfileSaveResult,
  RelayStoredProfile
} from '../../../shared/relay/profiles'
import type { RelayGuardReadiness } from '../../../shared/relay/guard'
import type {
  LocalProxyState,
  LocalProxyPreparation,
  LocalProxyResult,
  LocalCoreLogLevel,
  LocalResolverMode
} from '../../../shared/relay/local-proxy'
import type {
  RelayCoreMode,
  RelayCoreState,
  RelayCorePreparation,
  RelayCoreResult
} from '../../../shared/relay/core'
import type {
  RelayEdgeAction,
  RelayEdgePreparation,
  RelayEdgeApplyResult
} from '../../../shared/relay/edge'
import type {
  RelayDesktopAction,
  RelayDesktopResult,
  RelayDesktopState
} from '../../../shared/relay/desktop'
import type {
  RelayArtifactAction,
  RelayArtifactResult,
  RelayGeneratedArtifacts,
  RelayGenerateRequest,
  RelayPreviewInput,
  RelayStatus,
  RelayObservation,
  RelayPreferenceSnapshot,
  RelayRecoveryStatus,
  RelayRecoverySelection,
  RelayRecoveryInspection,
  RelayRecoveryRestoreResult,
  RelayCodePreparation,
  RelayCodeApplyResult,
  RelayBrowserLaunchResult,
  RelayBackupSource,
  RelayDesktopReadiness
} from '../../../shared/relay/protocol'
import { RelayOverrideLibraryManager } from './override'
import { RelaySnifferManager } from './sniffer'
import { RelayDnsManager } from './dns'
import './relay-workspace.css'

const initial: RelayPreviewInput = {
  httpPort: 7890,
  node: 'Your node',
  internalExceptions: '',
  existingJSON: '{}'
}
export default function RelayWorkspace(): React.JSX.Element {
  const { profileConfig, mutateProfileConfig } = useProfileConfig()
  const location = useLocation()
  const navigate = useNavigate()
  const pageRef = useRef<HTMLDivElement>(null)
  const activePanel = getRelayWorkspacePanel(location.search)
  const profilePanel = ['profiles', 'profile-library', 'rule-providers', 'core'].includes(
    activePanel
  )
  const {
    data: profileOwner,
    error: profileOwnerError,
    mutate: refreshProfileOwner
  } = useSWR(
    profilePanel ? 'relayProxyPageOwner' : null,
    async () => (await relayProxyPageOwner()) ?? null,
    { revalidateOnFocus: false, errorRetryCount: 0 }
  )
  const managedOwner =
    !profileOwnerError && profileOwner?.kind === 'tun-managed' ? profileOwner : undefined
  const requestedModule = new URLSearchParams(location.search).get('module')
  const simpleModule =
    requestedModule && Object.hasOwn(SIMPLE_MODULES, requestedModule)
      ? (requestedModule as SimpleModule)
      : undefined
  useLayoutEffect(() => {
    const content = pageRef.current?.querySelector('.content')
    if (content) {
      content.scrollTop = 0
      content.scrollLeft = 0
    }
  }, [activePanel, simpleModule])
  const [status, setStatus] = useState<RelayStatus>()
  const [input, setInput] = useState(initial)
  const [output, setOutput] = useState<RelayGeneratedArtifacts>()
  const [operationBusy, setBusy] = useState(false)
  const [simplePending, setSimplePending] = useState(false)
  const [accountRemotePreparation, setAccountRemotePreparation] = useState<{
      plan?: RelayRemoteBackupPlan
      result?: RelayRemoteBackupResult
    }>(),
    [accountRuntimePreparation, setAccountRuntimePreparation] = useState<{
      plan?: RelayRuntimeGistPlan
      result?: RelayRuntimeGistResult
    }>()
  const [tunState, setTunState] = useState<TunSessionState>(),
    [tunUnconfirmed, setTunUnconfirmed] = useState(false),
    [completeEvidenceId, setCompleteEvidenceId] = useState<string>()
  const runtimeGistBusy = operationBusy || simplePending || !!tunState?.pending || tunUnconfirmed
  const activeTunSessionId =
    tunState?.owned &&
    tunState.phase === 'active' &&
    tunState.traffic === 'forwarding' &&
    !tunState.pending &&
    !tunUnconfirmed
      ? tunState.sessionId
      : undefined
  const busy =
    operationBusy || simplePending || !!tunState?.owned || !!tunState?.pending || tunUnconfirmed
  const profileSelectionBusy =
    operationBusy ||
    simplePending ||
    !!tunState?.pending ||
    !!profileOwnerError ||
    (profilePanel && profileOwner === undefined) ||
    (!profileOwner && !!tunState?.owned && !activeTunSessionId)
  const [error, setError] = useState('')
  const [activity, setActivity] = useState('')
  const [observation, setObservation] = useState<RelayObservation>()
  const [preferenceSnapshot, setPreferenceSnapshot] = useState<RelayPreferenceSnapshot>()
  const [preferenceNotice, setPreferenceNotice] = useState('')
  const [recovery, setRecovery] = useState<RelayRecoveryStatus>()
  const [recoveryNotice, setRecoveryNotice] = useState('')
  const [recoveryPreflight, setRecoveryPreflight] = useState<RelayRecoveryInspection>()
  const [codePreparation, setCodePreparation] = useState<RelayCodePreparation>()
  const [codeNotice, setCodeNotice] = useState('')
  const [desktopReadiness, setDesktopReadiness] = useState<RelayDesktopReadiness>()
  const [desktopNotice, setDesktopNotice] = useState('')
  const [desktopState, setDesktopState] = useState<RelayDesktopState>()
  const [desktopSessionNotice, setDesktopSessionNotice] = useState('')
  const [edgeReport, setEdgeReport] = useState<RelayEdgePreparation>()
  const [edgeNotice, setEdgeNotice] = useState('')
  const [guardReadiness, setGuardReadiness] = useState<RelayGuardReadiness>()
  const [guardNotice, setGuardNotice] = useState('')
  const [coreState, setCoreState] = useState<RelayCoreState>()
  const [coreMode, setCoreMode] = useState<RelayCoreMode>('rule')
  const [corePreparation, setCorePreparation] = useState<RelayCorePreparation>()
  const [coreNotice, setCoreNotice] = useState('')
  const coreSequence = useRef(0)
  const coreBlocking = coreState?.owned || coreState?.pending
  const [profilePreparation, setProfilePreparation] = useState<RelayProfilePreparation>()
  const [profileInventory, setProfileInventory] = useState<RelayProfileInventory>()
  const inventoryReading = useRef(false)
  const inventoryAttempt = useRef<string | undefined>(undefined)
  const [inventoryError, setInventoryError] = useState(false)
  const refreshProfileInventory = useCallback(async (): Promise<void> => {
    const inventory = await relayProfileRead('relayProfileList')
    setProfileInventory(inventory)
    setInventoryError(false)
  }, [])
  useEffect(() => {
    if (activePanel === 'profiles') {
      inventoryAttempt.current = undefined
      return
    }
    if (
      profileInventory ||
      (activePanel === 'profile-library' || activePanel === 'rule-providers'
        ? profileSelectionBusy
        : busy) ||
      inventoryReading.current ||
      inventoryAttempt.current === activePanel
    )
      return
    inventoryAttempt.current = activePanel
    inventoryReading.current = true
    setBusy(true)
    void refreshProfileInventory()
      .catch(() => setInventoryError(true))
      .finally(() => {
        inventoryReading.current = false
        setBusy(false)
      })
  }, [activePanel, profileInventory, busy, profileSelectionBusy, refreshProfileInventory])
  const preferredProfile =
    profileInventory?.profiles.find((profile) => profile.id === profileConfig?.current) ??
    profileInventory?.profiles[0]
  const [profileNotice, setProfileNotice] = useState('')
  const [profilePending, setProfilePending] = useState(false)
  const profileOperation = useRef(false),
    profileEpoch = useRef(0)
  const [subscriptionName, setSubscriptionName] = useState('Subscription snapshot')
  const [subscriptionURL, setSubscriptionURL] = useState('')
  const [subscriptionPort, setSubscriptionPort] = useState(18191)
  const [subscriptionPreparation, setSubscriptionPreparation] = useState<SubscriptionPreparation>()
  const [subscriptionProfile, setSubscriptionProfile] = useState<RelayProfilePreparation>()
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionState>()
  const [subscriptionNotice, setSubscriptionNotice] = useState('')
  const [subscriptionPending, setSubscriptionPending] = useState(false)
  const subscriptionOperation = useRef(false),
    subscriptionEpoch = useRef(0),
    workspaceMounted = useRef(true)
  useEffect(() => {
    workspaceMounted.current = true
    const epochs = [subscriptionEpoch, profileEpoch, coreSequence, codeReadSequence]
    return () => {
      workspaceMounted.current = false
      epochs.forEach((epoch) => {
        ++epoch.current
      })
    }
  }, [])
  const [runtimePreparation, setRuntimePreparation] = useState<RelayRuntimePreparation>()
  const [runtimeChecked, setRuntimeChecked] = useState<RelayRuntimeCheckResult>()
  const [runtimeNotice, setRuntimeNotice] = useState('')
  const [runtimePending, setRuntimePending] = useState(false)
  const runtimeOperation = useRef(false)
  const [restoredRevision, setRestoredRevision] = useState(0)
  // The workspace remounts after a restore before the local backup IPC replies.
  const [backupReceipt, setBackupReceipt] = useState<{ scope: 'local' | 'remote'; text: string }>()
  useEffect(
    () =>
      window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', () => {
        setAccountRemotePreparation({})
        setAccountRuntimePreparation({})
      }),
    []
  )
  const [shellState, setShellState] = useState<RelayShellState>()
  const [shellDark, setShellDark] = useState(false)
  const [localState, setLocalState] = useState<LocalProxyState>()
  const [localPreparation, setLocalPreparation] = useState<LocalProxyPreparation>()
  const [localPorts, setLocalPorts] = useState<LocalProxyPorts>(() => localProxyPorts(undefined))
  const localPort = localProxyHTTPPort(localPorts)
  const [resolverMode, setResolverMode] = useState<LocalResolverMode>('profile')
  const [persistentCore, setPersistentCore] = useState(false)
  const [localLogLevel, setLocalLogLevel] = useState<LocalCoreLogLevel>()
  const [dedicated, setDedicated] = useState<DedicatedListenerPlan>()
  const [localPlanRecord, setLocalPlanRecord] = useState<LocalProxyPlanRecord>()
  const [localPlanLoading, setLocalPlanLoading] = useState(true)
  const [localPlanDirty, setLocalPlanDirty] = useState(false)
  const [localPlanNotice, setLocalPlanNotice] = useState('正在读取启动设置…')
  const localPlanEpoch = useRef(0),
    localPlanEdits = useRef(0)
  const [localNotice, setLocalNotice] = useState('')
  const [localPending, setLocalPending] = useState(false)
  const localOperations = useRef(0),
    localSequence = useRef(0)
  const localBlocking = localState?.owned || localState?.pending || localPending
  useEffect(() => {
    let active = true
    const epoch = ++localPlanEpoch.current,
      edits = localPlanEdits.current
    setLocalPlanLoading(true)
    setLocalPlanRecord(undefined)
    // DOM focus can be true while Electron still hides the first window.
    // Subscribe before querying Main so an already-shown window cannot be missed.
    let requested = false
    const read = async (): Promise<void> => {
      if (!active || requested) return
      try {
        const visible = await window.electron.ipcRenderer.invoke('relayWorkspaceVisible')
        if (visible !== true || !active || requested) return
        requested = true
        unsubscribe()
        const raw = await window.electron.ipcRenderer.invoke('relayLocalProxyPlanRead')
        const record = localProxyPlanRecord(raw)
        if (!active || epoch !== localPlanEpoch.current) return
        setLocalPlanRecord(record)
        if (edits === localPlanEdits.current) {
          setLocalPorts(localProxyPorts(record.document.ports, record.document.httpPort))
          setResolverMode(record.document.resolverMode)
          setDedicated(record.document.dedicated)
          setLocalPlanDirty(false)
        }
        setLocalPlanNotice(
          record.exists ? '已读取保存的启动设置。' : '尚未保存；启动代理时会保存当前设置。'
        )
      } catch {
        if (active && epoch === localPlanEpoch.current) {
          setLocalPlanRecord(undefined)
          setLocalPlanNotice('启动设置读取失败；不会用默认值覆盖，也不会自动启动。')
          setLocalPlanLoading(false)
        }
      } finally {
        if (requested && active && epoch === localPlanEpoch.current) setLocalPlanLoading(false)
      }
    }
    const unsubscribe = window.electron.ipcRenderer.on('relayWorkspaceVisible', () => void read())
    void read()
    return () => {
      active = false
      unsubscribe()
    }
  }, [restoredRevision])
  const markLocalPlanEdited = (): void => {
    ++localPlanEdits.current
    setLocalPlanDirty(true)
    setLocalPreparation(undefined)
  }
  const saveLocalPlan = async (current: () => boolean): Promise<LocalProxyPlanRecord> => {
    if (!localPlanRecord || localPlanLoading)
      throw new Error('启动设置尚未读取，不能使用默认值覆盖保存。')
    const edits = localPlanEdits.current,
      epoch = ++localPlanEpoch.current
    const record = await saveLocalProxyPlan(
      localPlanRecord,
      {
        httpPort: localPort,
        ports: localPorts,
        resolverMode,
        ...(dedicated ? { dedicated } : {})
      },
      (channel, ...args) => window.electron.ipcRenderer.invoke(channel, ...args),
      () => current() && epoch === localPlanEpoch.current && edits === localPlanEdits.current
    )
    setLocalPlanRecord(record)
    setLocalPlanDirty(false)
    setLocalPlanNotice('启动设置已保存；重开 Relay 后沿用，监听端口随核心启动。')
    return record
  }
  const saveLocalPlanOnly = async (): Promise<void> => {
    if (busy || localOperations.current || localState?.pending || localState?.uncertain) return
    ++localOperations.current
    const sequence = ++localSequence.current
    setLocalPending(true)
    setBusy(true)
    try {
      await saveLocalPlan(() => workspaceMounted.current && sequence === localSequence.current)
    } catch (error) {
      if (sequence === localSequence.current)
        setLocalPlanNotice(
          error instanceof Error ? error.message : '启动设置保存失败，请重新读取。'
        )
    } finally {
      --localOperations.current
      setLocalPending(localOperations.current > 0)
      if (!localOperations.current) setBusy(false)
    }
  }
  const desktopReadSequence = useRef(0)
  const desktopBlocking =
    desktopState?.host === 'running' || desktopState?.uncertain || desktopState?.pending
  const codeReadSequence = useRef(0)
  const userHasStarted = useRef(false)
  const preferenceReadSequence = useRef(0)
  const recoveryReadSequence = useRef(0)

  useEffect(() => {
    let active = true
    const readSequence = ++preferenceReadSequence.current
    window.electron.ipcRenderer
      .invoke('relayReadPreferences')
      .then((value) => {
        if (active && readSequence === preferenceReadSequence.current) {
          const snapshot = value as RelayPreferenceSnapshot
          setPreferenceSnapshot(snapshot)
          setInput((current) =>
            mergeLoadedPreferences(current, snapshot.preferences, userHasStarted.current)
          )
        }
      })
      .catch(() => {
        if (active && readSequence === preferenceReadSequence.current)
          setPreferenceNotice('偏好未能读取，仍可生成草稿；需要重新读取成功后才能保存参数。')
      })
    window.electron.ipcRenderer
      .invoke('relayStatus')
      .then((value) => {
        if (active) setStatus(value as RelayStatus)
      })
      .catch(() => {
        if (active) setError('无法读取Relay组件状态。')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true,
      reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      const version = desktopReadSequence.current
      try {
        const result = (await window.electron.ipcRenderer.invoke(
          'relayDesktopState'
        )) as RelayDesktopState
        if (active && version === desktopReadSequence.current) setDesktopState(result)
      } catch {
        if (active) setDesktopSessionNotice('后台状态读取未确认，请保留窗口并核对。')
      } finally {
        reading = false
      }
    }
    void read()
    const timer = desktopBlocking ? setInterval(() => void read(), 1000) : undefined
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [desktopBlocking])

  useEffect(() => {
    let active = true,
      epoch = 0
    const read = async (): Promise<void> => {
      const ticket = ++epoch
      try {
        const state = (await window.electron.ipcRenderer.invoke(
          'relayShellState'
        )) as RelayShellState
        if (active && ticket === epoch) setShellState(state)
      } catch {
        if (active && ticket === epoch) setShellState(undefined)
      }
    }
    void read()
    const unsubscribe = window.electron.ipcRenderer.on('relayShellUpdated', () => void read())
    return () => {
      active = false
      ++epoch
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    const preference = shellState?.settings.appTheme ?? 'system'
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void =>
      setShellDark(preference === 'dark' || (preference === 'system' && media.matches))
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [shellState?.settings.appTheme])

  useEffect(() => {
    let active = true
    const unsubscribe = window.electron.ipcRenderer.on('relayDataRestored', () => {
      setCompleteEvidenceId(undefined)
      ++codeReadSequence.current
      ++coreSequence.current
      ++preferenceReadSequence.current
      ++localSequence.current
      setCodePreparation(undefined)
      setLocalPreparation(undefined)
      setProfilePreparation(undefined)
      setSubscriptionPreparation(undefined)
      setSubscriptionProfile(undefined)
      setSubscriptionState(undefined)
      ++subscriptionEpoch.current
      ++profileEpoch.current
      setRuntimePreparation(undefined)
      setRuntimeChecked(undefined)
      setCorePreparation(undefined)
      setRecovery(undefined)
      setRecoveryPreflight(undefined)
      setObservation(undefined)
      setOutput(undefined)
      inventoryAttempt.current = undefined
      setInventoryError(false)
      setProfileInventory(undefined)
      setAccountRemotePreparation(undefined)
      setAccountRuntimePreparation({})
      setRestoredRevision((revision) => revision + 1)
      const ticket = preferenceReadSequence.current
      void window.electron.ipcRenderer
        .invoke('relayReadPreferences')
        .then((value) => {
          if (!active || ticket !== preferenceReadSequence.current) return
          const snapshot = value as RelayPreferenceSnapshot
          setPreferenceSnapshot(snapshot)
          setInput((previous) => mergeLoadedPreferences(previous, snapshot.preferences, false))
        })
        .catch(() => {
          if (active) setPreferenceSnapshot(undefined)
        })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const desktopAction = async (action: RelayDesktopAction): Promise<void> => {
    setEdgeReport(undefined)
    ++desktopReadSequence.current
    if (action !== 'cancel') setBusy(true)
    setDesktopSessionNotice('等待会话操作或系统确认…')
    setDesktopState((previous) => ({
      host: previous?.host ?? 'absent',
      uncertain: previous?.uncertain ?? false,
      snapshot: previous?.snapshot,
      pending: true
    }))
    try {
      const result = (await window.electron.ipcRenderer.invoke('relayDesktopAction', {
        action
      })) as RelayDesktopResult
      ++desktopReadSequence.current
      setDesktopState(result.state)
      setDesktopSessionNotice(
        result.status === 'cancelled'
          ? '已取消或请求取消。'
          : result.status === 'uncertain'
            ? '结果未确认，请核对会话与恢复记录。'
            : '会话操作已返回；账号是否登录成功需自行确认。'
      )
      if (result.status !== 'cancelled') {
        setCodePreparation(undefined)
        ++codeReadSequence.current
        setDesktopReadiness(undefined)
        setObservation(undefined)
        setRecoveryPreflight(undefined)
      }
    } catch {
      setDesktopSessionNotice('会话请求未完成，请重新读取状态；没有自动重试。')
    } finally {
      if (action !== 'cancel') setBusy(false)
    }
  }

  useEffect(() => {
    let active = true,
      reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      const sequence = coreSequence.current
      try {
        const snapshot = (await window.electron.ipcRenderer.invoke(
          'relayCoreState'
        )) as RelayCoreState
        if (active && sequence === coreSequence.current) setCoreState(snapshot)
      } catch {
        if (active && sequence === coreSequence.current)
          setCoreNotice('核心状态未能读取，请核对本次实例。')
      } finally {
        reading = false
      }
    }
    void read()
    const timer = coreBlocking ? setInterval(() => void read(), 1000) : undefined
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [coreBlocking])

  const subscriptionWatching = !!(
    subscriptionState?.pending ||
    subscriptionProfile ||
    subscriptionPreparation
  )
  useEffect(() => {
    let active = true
    const read = async (): Promise<void> => {
      if (subscriptionOperation.current) return
      const epoch = subscriptionEpoch.current
      try {
        const snapshot = (await window.electron.ipcRenderer.invoke(
          'relaySubscriptionState'
        )) as SubscriptionState
        if (active && epoch === subscriptionEpoch.current && !subscriptionOperation.current) {
          setSubscriptionState(snapshot)
          setSubscriptionPreparation((previous) =>
            previous && previous.evidenceId === snapshot.preparedId ? previous : undefined
          )
          setSubscriptionProfile((previous) =>
            previous && previous.evidenceId === snapshot.stagedId ? previous : undefined
          )
        }
      } catch {
        /* Preserve unconfirmed state, never retry a request or save. */
      }
    }
    void read()
    const timer = subscriptionWatching ? setInterval(() => void read(), 1000) : undefined
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [subscriptionWatching])

  const subscriptionAction = async (action: 'prepare' | 'download' | 'save'): Promise<void> => {
    if (subscriptionOperation.current) return
    subscriptionOperation.current = true
    const ticket = ++subscriptionEpoch.current
    const current = (): boolean => workspaceMounted.current && ticket === subscriptionEpoch.current
    setBusy(true)
    setSubscriptionPending(true)
    const id =
      action === 'download' ? subscriptionPreparation?.evidenceId : subscriptionProfile?.evidenceId
    if (action !== 'prepare')
      setSubscriptionState({
        phase: action === 'download' ? 'confirmingDownload' : 'confirmingSave',
        pending: true,
        operationId: id
      })
    setSubscriptionNotice('正在检查、下载并保存订阅…')
    setLocalPreparation(undefined)
    try {
      if (action === 'prepare') {
        setSubscriptionPreparation(undefined)
        setSubscriptionProfile(undefined)
        const report = (await window.electron.ipcRenderer.invoke('relaySubscriptionPrepare', {
          name: subscriptionName,
          url: subscriptionURL,
          proxyPort: subscriptionPort
        })) as SubscriptionPreparation
        if (!current()) {
          await window.electron.ipcRenderer.invoke('relaySubscriptionCancel', {
            evidenceId: report.evidenceId
          })
          return
        }
        setSubscriptionURL('')
        setSubscriptionPreparation(report)
        const downloaded = (await window.electron.ipcRenderer.invoke('relaySubscriptionDownload', {
          evidenceId: report.evidenceId
        })) as SubscriptionDownloadResult
        if (!current()) return
        setSubscriptionPreparation(undefined)
        setSubscriptionProfile(downloaded.profile)
        if (downloaded.profile?.inspection.structure !== 'passed') {
          setSubscriptionNotice(downloaded.warnings.join(' ') || '下载或结构检查未通过，未保存。')
          return
        }
        const saved = (await window.electron.ipcRenderer.invoke('relaySubscriptionSave', {
          evidenceId: downloaded.profile.evidenceId
        })) as RelayProfileSaveResult
        if (!current()) return
        setSubscriptionProfile(undefined)
        setSubscriptionNotice(
          saved.warnings.join(' ') ||
            (saved.status === 'saved'
              ? '订阅已保存为配置副本。'
              : '保存未完成，请读取配置列表核对。')
        )
        if (saved.status === 'saved' || saved.status === 'uncertain') {
          const inventory = (await window.electron.ipcRenderer.invoke(
            'relayProfileList'
          )) as RelayProfileInventory
          if (current()) setProfileInventory(inventory)
        }
      } else if (action === 'download') {
        setSubscriptionPreparation(undefined)
        setSubscriptionProfile(undefined)
        const result = (await window.electron.ipcRenderer.invoke('relaySubscriptionDownload', {
          evidenceId: id
        })) as SubscriptionDownloadResult
        setSubscriptionProfile(result.profile)
        setSubscriptionNotice(result.warnings.join(' '))
      } else {
        const result = (await window.electron.ipcRenderer.invoke('relaySubscriptionSave', {
          evidenceId: id
        })) as RelayProfileSaveResult
        setSubscriptionNotice(result.warnings.join(' '))
        if (result.status !== 'cancelled') setSubscriptionProfile(undefined)
        if (result.status === 'saved' || result.status === 'uncertain')
          setProfileInventory(
            (await window.electron.ipcRenderer.invoke('relayProfileList')) as RelayProfileInventory
          )
      }
    } catch {
      setSubscriptionNotice('本次结果未确认或凭据已过期，请核对后重新准备；没有自动重试或启用。')
    } finally {
      try {
        setSubscriptionState(
          (await window.electron.ipcRenderer.invoke('relaySubscriptionState')) as SubscriptionState
        )
      } catch {
        /* Keep the pending state when the result is unknown. */
      }
      subscriptionOperation.current = false
      setSubscriptionPending(false)
      setBusy(false)
    }
  }
  const cancelSubscription = async (): Promise<void> => {
    ++subscriptionEpoch.current
    const id =
      subscriptionState?.operationId ??
      subscriptionState?.stagedId ??
      subscriptionState?.preparedId ??
      subscriptionPreparation?.evidenceId
    if (!id) return
    try {
      const result = (await window.electron.ipcRenderer.invoke('relaySubscriptionCancel', {
        evidenceId: id
      })) as { status: string }
      setSubscriptionNotice(
        result.status === 'busy'
          ? '正在保存，请等待同步完成。'
          : result.status === 'stale'
            ? '操作已结束或已变化，请核对当前检查结果。'
            : '已请求取消或丢弃；等待当前操作返回，不会自动重试。'
      )
      if (!subscriptionOperation.current) {
        ++subscriptionEpoch.current
        setSubscriptionPreparation(undefined)
        setSubscriptionProfile(undefined)
        setSubscriptionState(
          (await window.electron.ipcRenderer.invoke('relaySubscriptionState')) as SubscriptionState
        )
      }
    } catch {
      setSubscriptionNotice('取消结果未确认，请保留窗口并核对状态。')
    }
  }

  const profileAction = async (
    action: 'prepare' | 'save' | 'list' | 'choose',
    selection?: RelayProfileSelection
  ): Promise<void> => {
    if (profileOperation.current || (action === 'choose' && (profileSelectionBusy || !selection)))
      return
    profileOperation.current = true
    const ticket = ++profileEpoch.current
    const current = (): boolean => workspaceMounted.current && ticket === profileEpoch.current
    const evidenceId = profilePreparation?.evidenceId
    setProfilePending(true)
    setBusy(true)
    setProfileNotice(action === 'choose' ? '正在使用所选配置…' : '正在选择、检查并保存配置…')
    setRuntimePreparation(undefined)
    setRuntimeChecked(undefined)
    setLocalPreparation(undefined)
    if (action === 'prepare' || action === 'save') setProfilePreparation(undefined)
    try {
      if (action === 'prepare') {
        const report = (await window.electron.ipcRenderer.invoke('relayProfilePrepare')) as
          RelayProfilePreparation | undefined
        if (!current()) return
        setProfilePreparation(report)
        if (report?.inspection.structure === 'passed') {
          const result = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
            evidenceId: report.evidenceId
          })) as RelayProfileSaveResult
          if (!current()) return
          setProfilePreparation(undefined)
          setProfileNotice(
            result.warnings.join(' ') ||
              (result.status === 'saved' ? '配置已导入。' : '保存未完成，请刷新列表核对。')
          )
          if (result.status === 'saved' || result.status === 'uncertain')
            setProfileInventory(
              (await window.electron.ipcRenderer.invoke(
                'relayProfileList'
              )) as RelayProfileInventory
            )
        } else {
          setProfileNotice(report ? '配置结构检查未通过，未保存。' : '已取消文件选择。')
        }
      } else if (action === 'save') {
        const result = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
          evidenceId
        })) as RelayProfileSaveResult
        setProfileNotice(result.warnings.join(' '))
        if (result.status === 'saved' || result.status === 'uncertain')
          setProfileInventory(
            (await window.electron.ipcRenderer.invoke('relayProfileList')) as RelayProfileInventory
          )
      } else if (action === 'list') {
        setProfileInventory(undefined)
        setProfileInventory(
          (await window.electron.ipcRenderer.invoke('relayProfileList')) as RelayProfileInventory
        )
        setProfileNotice('已读取独立配置副本。')
      } else if (selection) {
        const tun = await chooseActiveTunProfile(
          selection,
          (channel, ...args) => window.electron.ipcRenderer.invoke(channel, ...args),
          managedOwner?.instanceId ?? activeTunSessionId
        )
        if (tun) {
          if (current()) {
            await refreshProfileOwner(tun, { revalidate: false })
            void mutateProfileConfig()
            setProfileNotice('虚拟网卡已使用所选配置。')
          }
          return
        }
        await window.electron.ipcRenderer.invoke('changeCurrentProfile', selection)
        const observed = (await window.electron.ipcRenderer.invoke(
          'getProfileConfig'
        )) as IProfileConfig
        setProfileNotice(
          observed.current === selection.id
            ? '已核对本次普通代理所选配置。'
            : '所选配置未生效。请核对当前选择；如已取消热载，原选择保留。'
        )
      }
    } catch {
      setProfileNotice(
        action === 'choose'
          ? '配置选择或回读未确认。请重新读取，不会自动重试。'
          : '读取或保存未完成，请重新检查；没有自动重试或启用配置。'
      )
    } finally {
      profileOperation.current = false
      setProfilePending(false)
      setBusy(false)
    }
  }

  const activateProfile = async (profile: RelayStoredProfile): Promise<void> => {
    if (profileOperation.current || localOperations.current || profileSelectionBusy)
      throw new Error('请等待当前操作完成')
    profileOperation.current = true
    ++localOperations.current
    const sequence = ++localSequence.current
    setProfilePending(true)
    setLocalPending(true)
    setBusy(true)
    setRuntimePreparation(undefined)
    setRuntimeChecked(undefined)
    setLocalPreparation(undefined)
    let readbackFailed = false
    let ordinary = false
    try {
      const tun = await chooseActiveTunProfile(
        profile,
        (channel, ...args) => window.electron.ipcRenderer.invoke(channel, ...args),
        managedOwner?.instanceId ?? activeTunSessionId
      )
      if (tun) {
        if (sequence !== localSequence.current) throw new Error('代理状态已变化')
        await refreshProfileOwner(tun, { revalidate: false })
        return
      }
      ordinary = true
      setLocalState((previous) => (previous ? { ...previous, pending: true } : previous))
      const saved = relayProxyRunning(localState)
        ? undefined
        : await saveLocalPlan(() => workspaceMounted.current && sequence === localSequence.current)
      const state = await activateCachedProfile(
        profile,
        relayProxyRunning(localState)
          ? (localState?.httpPort ?? localPort)
          : (saved?.document.httpPort ?? localPort),
        (channel, ...args) => window.electron.ipcRenderer.invoke(channel, ...args),
        {
          resolverMode: saved?.document.resolverMode ?? resolverMode,
          lifetime: persistentCore ? 'persistent' : 'main',
          ...(!persistentCore && localLogLevel !== undefined ? { logLevel: localLogLevel } : {}),
          ...(saved?.document.ports ? { ports: saved.document.ports } : {}),
          ...(saved?.document.dedicated ? { dedicated: saved.document.dedicated } : {})
        }
      )
      if (sequence !== localSequence.current) throw new Error('代理状态已变化')
      setLocalState(state)
    } finally {
      if (ordinary)
        try {
          const state = (await window.electron.ipcRenderer.invoke(
            'relayLocalProxyState'
          )) as LocalProxyState
          readbackFailed =
            sequence !== localSequence.current ||
            !relayProxyRunning(state) ||
            state.profileId !== profile.id
          if (sequence === localSequence.current) setLocalState(state)
        } catch {
          readbackFailed = true
          if (sequence === localSequence.current) {
            setLocalState((previous) => (previous ? { ...previous, uncertain: true } : previous))
            setLocalNotice('配置启用后的状态未确认，请在内核设置中重新读取。')
          }
        }
      profileOperation.current = false
      --localOperations.current
      setProfilePending(false)
      setLocalPending(localOperations.current > 0)
      if (!localOperations.current) setBusy(false)
      mutateProfileConfig()
    }
    if (readbackFailed) throw new Error('配置启用后的状态未确认')
  }

  const runtimeAction = async (selection?: RelayProfileSelection): Promise<void> => {
    if (runtimeOperation.current) return
    runtimeOperation.current = true
    const evidenceId = runtimePreparation?.evidenceId
    setRuntimePending(true)
    setBusy(true)
    setRuntimeChecked(undefined)
    setRuntimeNotice(
      selection ? '复核已保存配置并读取声明…' : '运行固定核心的独立配置检查，不启用流量…'
    )
    if (selection) setRuntimePreparation(undefined)
    try {
      if (selection) {
        setRuntimePreparation(
          (await window.electron.ipcRenderer.invoke(
            'relayProfileRuntimePrepare',
            selection
          )) as RelayRuntimePreparation
        )
        setRuntimeNotice('声明已读取；这里只准备隔离投影，未切换配置。')
      } else {
        const result = (await window.electron.ipcRenderer.invoke('relayProfileRuntimeCheck', {
          evidenceId
        })) as RelayRuntimeCheckResult
        setRuntimeChecked(result)
        setRuntimeNotice(result.warnings.join(' '))
      }
    } catch {
      setRuntimePreparation(undefined)
      setRuntimeNotice('配置或检查结果未确认，请重新读取列表并选择；没有启用配置。')
    } finally {
      runtimeOperation.current = false
      setRuntimePending(false)
      setBusy(false)
    }
  }

  useEffect(() => {
    let active = true,
      reading = false,
      invalidated = false
    const read = async (): Promise<void> => {
      if (!active || localOperations.current) return
      if (reading) return
      reading = true
      invalidated = false
      const sequence = localSequence.current
      try {
        const snapshot = (await window.electron.ipcRenderer.invoke(
          'relayLocalProxyState'
        )) as LocalProxyState
        if (active && !invalidated && sequence === localSequence.current) setLocalState(snapshot)
      } catch {
        if (active && !invalidated && sequence === localSequence.current)
          setLocalNotice('缓存状态未能读取，请保留本次窗口。')
      } finally {
        reading = false
        if (active && invalidated) void read()
      }
    }
    // Automatic/tray starts can complete after the first idle snapshot. Listen
    // before reading, and coalesce notifications arriving during that read.
    const unsubscribe = window.electron.ipcRenderer.on('groupsUpdated', () => {
      invalidated = true
      void read()
      if (profilePanel) void refreshProfileOwner()
    })
    const unsubscribeTun = profilePanel
      ? window.electron.ipcRenderer.on('relayTunUpdated', () => void refreshProfileOwner())
      : undefined
    void read()
    const timer = localBlocking ? setInterval(() => void read(), 1000) : undefined
    return () => {
      active = false
      if (timer) clearInterval(timer)
      unsubscribe()
      unsubscribeTun?.()
    }
  }, [localBlocking, profilePanel, refreshProfileOwner])

  const prepareLocalProxy = async (profile: RelayStoredProfile): Promise<void> => {
    if (localOperations.current) return
    ++localOperations.current
    const sequence = ++localSequence.current
    setBusy(true)
    setLocalPending(true)
    setLocalPreparation(undefined)
    setLocalNotice('复核本地副本、资源和端口；尚未启动代理…')
    try {
      const saved = await saveLocalPlan(
        () => workspaceMounted.current && sequence === localSequence.current
      )
      const report = (await window.electron.ipcRenderer.invoke('relayLocalProxyPrepare', {
        profile: { id: profile.id, sha256: profile.sha256 },
        ...saved.document,
        lifetime: persistentCore ? 'persistent' : 'main',
        ...(!persistentCore && localLogLevel !== undefined ? { logLevel: localLogLevel } : {})
      })) as LocalProxyPreparation
      const snapshot = (await window.electron.ipcRenderer.invoke(
        'relayLocalProxyState'
      )) as LocalProxyState
      if (sequence === localSequence.current) {
        setLocalPreparation(report)
        setLocalState(snapshot)
        setLocalNotice(report.warnings.join(' '))
      }
    } catch {
      if (sequence === localSequence.current) setLocalNotice('准备未完成，没有启动代理或接管端口。')
    } finally {
      --localOperations.current
      setLocalPending(localOperations.current > 0)
      if (!localOperations.current) setBusy(false)
    }
  }
  const reloadLocalProxy = async (profile: RelayStoredProfile): Promise<void> => {
    if (localOperations.current || !localState?.httpPort || localState.phase !== 'running') return
    ++localOperations.current
    const sequence = ++localSequence.current
    setBusy(true)
    setLocalPending(true)
    setLocalPreparation(undefined)
    setLocalNotice('准备本次自有实例热载，尚未向核心提交…')
    try {
      const plan = (await window.electron.ipcRenderer.invoke('relayLocalProxyReloadPrepare', {
        profile: { id: profile.id, sha256: profile.sha256 },
        httpPort: localState.httpPort,
        ...(localState.ports ? { ports: localState.ports } : {}),
        resolverMode: localState.resolution?.mode ?? 'off',
        ...(localState.dedicated
          ? {
              dedicated: {
                route: localState.dedicated.route,
                ...(localState.dedicated.httpPort
                  ? { httpPort: localState.dedicated.httpPort }
                  : {}),
                ...(localState.dedicated.socksPort
                  ? { socksPort: localState.dedicated.socksPort }
                  : {})
              }
            }
          : {})
      })) as { evidenceId: string }
      const result = (await window.electron.ipcRenderer.invoke('relayLocalProxyReload', {
        evidenceId: plan.evidenceId
      })) as LocalProxyResult
      if (sequence === localSequence.current) {
        setLocalState(result.state)
        setLocalNotice(result.state.warnings.join(' '))
      }
    } catch {
      if (sequence === localSequence.current)
        setLocalNotice('热载未确认，请刷新本次状态；没有自动重试、回滚或重启。')
    } finally {
      --localOperations.current
      setLocalPending(localOperations.current > 0)
      if (!localOperations.current) setBusy(false)
    }
  }
  const localAction = async (
    action: 'start' | 'stop' | 'refresh' | 'select' | 'delay' | 'automatic',
    group?: string,
    member?: string
  ): Promise<void> => {
    if (action !== 'stop' && localOperations.current) return
    ++localOperations.current
    const sequence = ++localSequence.current,
      evidenceId = localPreparation?.evidenceId,
      instanceId = localState?.instanceId
    setBusy(true)
    setLocalPending(true)
    setLocalPreparation(undefined)
    setLocalNotice('等待本次代理操作或系统确认…')
    setLocalState((previous) => ({
      phase: action === 'start' ? 'starting' : (previous?.phase ?? 'unknown'),
      pending: true,
      owned: previous?.owned ?? false,
      hasRecord: previous?.hasRecord ?? false,
      uncertain: previous?.uncertain ?? false,
      instanceId: action === 'start' ? evidenceId : previous?.instanceId,
      httpPort: previous?.httpPort,
      ports: previous?.ports,
      profileName: previous?.profileName,
      resolution: previous?.resolution,
      traffic: previous?.traffic ?? 'inactive',
      groups: previous?.groups ?? [],
      systemProxyChanged: false,
      liveGuardEnabled: false,
      warnings: previous?.warnings ?? []
    }))
    try {
      const input =
        action === 'start'
          ? { action, evidenceId }
          : action === 'select' || action === 'delay'
            ? { action, instanceId, group, member }
            : action === 'automatic'
              ? { action, instanceId, group }
              : { action, instanceId }
      const result = (await window.electron.ipcRenderer.invoke(
        'relayLocalProxyAction',
        input
      )) as LocalProxyResult
      if (sequence === localSequence.current) {
        setLocalState(result.state)
        setLocalNotice(
          result.status === 'cancelled'
            ? '已取消，保持原有实例状态。'
            : result.state.warnings.join(' ')
        )
      }
    } catch {
      if (sequence === localSequence.current) {
        setLocalNotice('结果未确认，请保留窗口并核对当前状态；没有自动重试。')
        try {
          const snapshot = (await window.electron.ipcRenderer.invoke(
            'relayLocalProxyState'
          )) as LocalProxyState
          if (sequence === localSequence.current) setLocalState(snapshot)
        } catch {
          /* Preserve pending state. */
        }
      }
    } finally {
      --localOperations.current
      setLocalPending(localOperations.current > 0)
      if (!localOperations.current) setBusy(false)
    }
  }

  const prepareCore = async (): Promise<void> => {
    const sequence = ++coreSequence.current
    setBusy(true)
    setCorePreparation(undefined)
    setCoreNotice('读取自有配置和固定核心资源…')
    let submitted = false
    try {
      const report = (await window.electron.ipcRenderer.invoke('relayCorePrepare', {
        mode: coreMode
      })) as RelayCorePreparation
      if (sequence === coreSequence.current) {
        setCorePreparation(report)
        setCoreNotice(report.warnings.join(' '))
        if (report.canStart) {
          submitted = true
          const result = (await window.electron.ipcRenderer.invoke('relayCoreAction', {
            action: 'start',
            evidenceId: report.evidenceId
          })) as RelayCoreResult
          if (sequence !== coreSequence.current) return
          setCorePreparation(undefined)
          setCoreNotice(result.state.warnings.join(' '))
        }
        const snapshot = (await window.electron.ipcRenderer.invoke(
          'relayCoreState'
        )) as RelayCoreState
        if (sequence === coreSequence.current) setCoreState(snapshot)
      }
    } catch {
      if (sequence === coreSequence.current)
        setCoreNotice(
          submitted
            ? '启动结果未确认，请读取核心状态核对；不会自动重试。'
            : '准备未完成，没有启动子进程。'
        )
    } finally {
      if (sequence === coreSequence.current) setBusy(false)
    }
  }
  const coreAction = async (action: 'start' | 'stop'): Promise<void> => {
    const sequence = ++coreSequence.current,
      evidenceId = corePreparation?.evidenceId
    setBusy(true)
    setCorePreparation(undefined)
    setCoreNotice('正在执行核心操作…')
    setCoreState((previous) => ({
      phase: previous?.phase ?? 'unknown',
      mode: previous?.mode ?? coreMode,
      pending: true,
      hasRecord: previous?.hasRecord ?? false,
      owned: previous?.owned ?? false,
      uncertain: previous?.uncertain ?? false,
      trafficEnabled: false,
      warnings: previous?.warnings ?? []
    }))
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'relayCoreAction',
        action === 'start' ? { action, evidenceId } : { action }
      )) as RelayCoreResult
      if (sequence === coreSequence.current) {
        setCoreState(result.state)
        setCoreNotice(
          result.status === 'cancelled'
            ? '已取消，没有启动隔离核心。'
            : result.state.warnings.join(' ')
        )
      }
    } catch {
      if (sequence === coreSequence.current) {
        setCoreNotice('结果未确认，请读取状态并核对本次会话；没有自动重试。')
        try {
          const snapshot = (await window.electron.ipcRenderer.invoke(
            'relayCoreState'
          )) as RelayCoreState
          if (sequence === coreSequence.current) setCoreState(snapshot)
        } catch {
          /* Preserve pending state on uncertainty. */
        }
      }
    } finally {
      if (sequence === coreSequence.current) setBusy(false)
    }
  }

  const readGuardReadiness = async (): Promise<void> => {
    setBusy(true)
    setGuardReadiness(undefined)
    setGuardNotice('只读核对包内组件与签名…')
    try {
      const report = (await window.electron.ipcRenderer.invoke(
        'relayGuardReadiness'
      )) as RelayGuardReadiness
      setGuardReadiness(report)
      setGuardNotice('只读核对已返回；系统过滤状态未查询，真实阻断未验收。')
    } catch {
      setGuardNotice('读取未确认，不保留先前通过状态；没有启动或修改系统过滤器。')
    } finally {
      setBusy(false)
    }
  }

  const edgeAction = async (action: 'inspect' | 'openProfile' | RelayEdgeAction): Promise<void> => {
    const proof = edgeReport
    setBusy(true)
    setEdgeNotice('正在处理 Edge 请求…')
    setEdgeReport(undefined)
    try {
      if (action === 'inspect') {
        setEdgeReport(
          (await window.electron.ipcRenderer.invoke('relayEdgeInspect')) as RelayEdgePreparation
        )
        setEdgeNotice('只读检查完成；策略来源与真实网络路径仍需核对。')
      } else {
        const result = (await window.electron.ipcRenderer.invoke(
          action === 'openProfile' ? 'relayEdgeProfileOpen' : 'relayEdgeEntryOpen',
          action === 'openProfile' ? { evidenceId: proof?.evidenceId } : { action }
        )) as RelayEdgeApplyResult
        setEdgeNotice(result.warnings.join(' '))
        setDesktopReadiness(undefined)
        setObservation(undefined)
        setCodePreparation(undefined)
        setRecoveryPreflight(undefined)
        ++codeReadSequence.current
      }
    } catch {
      setEdgeNotice(
        '请求未完成或结果未确认；请核对是否已出现系统窗口，再重新检查。没有自动重试或安装。'
      )
    } finally {
      setBusy(false)
    }
  }

  const generate = async (request: RelayGenerateRequest): Promise<void> => {
    userHasStarted.current = true
    setBusy(true)
    setError('')
    setActivity('')
    setOutput(undefined)
    try {
      setOutput(
        (await window.electron.ipcRenderer.invoke(
          'relayGenerate',
          request
        )) as RelayGeneratedArtifacts
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成未完成，没有应用配置。')
    } finally {
      setBusy(false)
    }
  }

  const changeInput = (next: RelayPreviewInput): void => {
    userHasStarted.current = true
    setInput(next)
    setOutput(undefined)
    setActivity('')
    ++codeReadSequence.current
    setCodePreparation(undefined)
  }

  const diagnose = async (): Promise<void> => {
    userHasStarted.current = true
    setBusy(true)
    setError('')
    setActivity('')
    setObservation(undefined)
    try {
      setObservation(
        (await window.electron.ipcRenderer.invoke('relayDiagnose')) as RelayObservation
      )
    } catch {
      setError('只读检测未完成；没有修改网络或客户端配置。')
    } finally {
      setBusy(false)
    }
  }

  const artifactAction = async (request: RelayArtifactAction): Promise<void> => {
    setBusy(true)
    setError('')
    setActivity('')
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'relayArtifactAction',
        request
      )) as RelayArtifactResult
      if (result.preferenceSnapshot) {
        ++codeReadSequence.current
        setCodePreparation(undefined)
        ++preferenceReadSequence.current
        setPreferenceSnapshot(result.preferenceSnapshot)
        setPreferenceNotice('已记住完整方案中的三个参数；未保存 JSON 草稿。')
      }
      setActivity(
        result.warning ??
          (result.status === 'copied'
            ? '文本已复制，没有应用配置。'
            : result.status === 'saved'
              ? '文本已导出，没有应用配置。'
              : '已取消导出，没有写入文件。')
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成。')
    } finally {
      setBusy(false)
    }
  }

  const readRecovery = async (): Promise<void> => {
    const sequence = ++recoveryReadSequence.current
    setBusy(true)
    setRecovery(undefined)
    setRecoveryPreflight(undefined)
    setRecoveryNotice('')
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'relayRecoveryStatus'
      )) as RelayRecoveryStatus
      if (sequence === recoveryReadSequence.current) setRecovery(result)
    } catch {
      if (sequence === recoveryReadSequence.current)
        setRecoveryNotice('恢复记录读取未完成，不能判断是否有待恢复记录。未执行任何恢复。')
    } finally {
      if (sequence === recoveryReadSequence.current) setBusy(false)
    }
  }

  const readDesktopReadiness = async (): Promise<void> => {
    setBusy(true)
    setDesktopReadiness(undefined)
    setDesktopNotice('')
    try {
      setDesktopReadiness(
        (await window.electron.ipcRenderer.invoke('relayDesktopReadiness')) as RelayDesktopReadiness
      )
    } catch {
      setDesktopNotice('桌面检查未完成，不能据此判断可登录；没有修改默认浏览器或登录记录。')
    } finally {
      setBusy(false)
    }
  }

  const openBackupDirectory = async (source: RelayBackupSource): Promise<void> => {
    setBusy(true)
    setRecoveryNotice('')
    try {
      await window.electron.ipcRenderer.invoke('relayBackupDirectoryOpen', { source })
      setRecoveryNotice('已向 Finder 发送打开目录请求。备份可能含私密字段，请仅在本机核对。')
    } catch {
      setRecoveryNotice('备份目录打开未确认；请重读列表核对，未自动创建目录或调用其他入口。')
    } finally {
      setBusy(false)
    }
  }

  const inspectRecovery = async (selection: RelayRecoverySelection): Promise<void> => {
    const sequence = ++recoveryReadSequence.current
    setBusy(true)
    setRecoveryPreflight(undefined)
    setRecoveryNotice('')
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'relayRecoveryPreflight',
        selection
      )) as RelayRecoveryInspection
      if (sequence === recoveryReadSequence.current) setRecoveryPreflight(result)
    } catch {
      if (sequence === recoveryReadSequence.current)
        setRecoveryNotice('预检未完成，请重新读取列表后核对。没有执行恢复或修改配置。')
    } finally {
      if (sequence === recoveryReadSequence.current) setBusy(false)
    }
  }

  const restoreRecovery = async (): Promise<void> => {
    if (!recoveryPreflight) return
    ++codeReadSequence.current
    setCodePreparation(undefined)
    const sequence = ++recoveryReadSequence.current
    setBusy(true)
    setRecoveryNotice('正在恢复所选配置…')
    try {
      const result = (await window.electron.ipcRenderer.invoke('relayRecoveryRestore', {
        evidenceId: recoveryPreflight.evidenceId,
        allowLegacy:
          recoveryPreflight.requiresLegacyConfirmation ||
          recoveryPreflight.issues.includes('targetModeUnknown')
      })) as RelayRecoveryRestoreResult
      if (sequence !== recoveryReadSequence.current) return
      setRecoveryNotice(result.warnings.join(' '))
      if (result.status !== 'cancelled') {
        setRecovery(undefined)
        setRecoveryPreflight(undefined)
        setOutput(undefined)
        setObservation(undefined)
        setPreferenceSnapshot(undefined)
        ++preferenceReadSequence.current
        setPreferenceNotice('恢复操作后需重新读取参数；先核对记录与实际文件状态。')
      }
    } catch {
      if (sequence === recoveryReadSequence.current) {
        setRecoveryPreflight(undefined)
        setRecoveryNotice('恢复请求未确认，请重读记录并预检后核对；没有自动重启网络或客户端。')
      }
    } finally {
      if (sequence === recoveryReadSequence.current) setBusy(false)
    }
  }

  const readPreferences = async (): Promise<void> => {
    ++codeReadSequence.current
    setCodePreparation(undefined)
    userHasStarted.current = true
    const sequence = ++preferenceReadSequence.current
    setBusy(true)
    setPreferenceNotice('')
    try {
      const snapshot = (await window.electron.ipcRenderer.invoke(
        'relayReadPreferences'
      )) as RelayPreferenceSnapshot
      if (sequence === preferenceReadSequence.current) {
        setPreferenceSnapshot(snapshot)
        setInput((current) => mergeLoadedPreferences(current, snapshot.preferences, false))
        setOutput(undefined)
        setPreferenceNotice('已重新读取参数，JSON草稿保持原值。')
      }
    } catch {
      if (sequence === preferenceReadSequence.current) {
        setPreferenceSnapshot(undefined)
        setPreferenceNotice('偏好读取未完成；未覆盖文件或当前输入，请检查后重试。')
      }
    } finally {
      if (sequence === preferenceReadSequence.current) setBusy(false)
    }
  }

  const savePreferences = async (): Promise<void> => {
    ++codeReadSequence.current
    setCodePreparation(undefined)
    if (!preferenceSnapshot) return
    userHasStarted.current = true
    ++preferenceReadSequence.current
    setBusy(true)
    setPreferenceNotice('')
    try {
      const { httpPort, node, internalExceptions } = input
      const snapshot = (await window.electron.ipcRenderer.invoke('relaySavePreferences', {
        preferences: { httpPort, node, internalExceptions },
        revision: preferenceSnapshot.revision
      })) as RelayPreferenceSnapshot
      setPreferenceSnapshot(snapshot)
      setPreferenceNotice('参数已保存到 Relay；客户端和网络配置未改变。')
    } catch {
      setPreferenceNotice(
        '保存结果未确认，可能存在版本冲突；请重新读取后核对。未应用客户端或网络配置。'
      )
    } finally {
      setBusy(false)
    }
  }

  const prepareCode = async (apply = false, settings = input): Promise<void> => {
    userHasStarted.current = true
    const sequence = ++codeReadSequence.current
    setBusy(true)
    setCodePreparation(undefined)
    setCodeNotice('')
    try {
      const { httpPort, node, internalExceptions } = settings
      const result = (await window.electron.ipcRenderer.invoke('relayCodePrepare', {
        httpPort,
        node,
        internalExceptions
      })) as RelayCodePreparation
      if (sequence === codeReadSequence.current) {
        setCodePreparation(result)
        if (apply && result.canApply) await applyCode(result)
      }
    } catch {
      if (sequence === codeReadSequence.current)
        setCodeNotice('配置准备未完成。请先启动Relay的AI专用HTTP入口，核对节点和端口；本次未应用。')
    } finally {
      if (sequence === codeReadSequence.current) setBusy(false)
    }
  }
  const applyCode = async (preparation = codePreparation): Promise<void> => {
    if (!preparation) return
    const sequence = ++codeReadSequence.current
    setBusy(true)
    setCodeNotice('正在备份并配置…')
    try {
      const result = (await window.electron.ipcRenderer.invoke('relayCodeApply', {
        evidenceId: preparation.evidenceId
      })) as RelayCodeApplyResult
      if (sequence !== codeReadSequence.current) return
      setCodeNotice(result.warnings.join(' '))
      if (result.status !== 'cancelled') {
        setCodePreparation(undefined)
        setOutput(undefined)
        setObservation(undefined)
        setRecovery(undefined)
        setRecoveryPreflight(undefined)
        ++preferenceReadSequence.current
        if (result.status === 'applied') {
          setPreferenceSnapshot(result.preferenceSnapshot)
          setPreferenceNotice(`联合事务已提交；备份编号：${result.backupId}`)
        } else {
          setPreferenceSnapshot(undefined)
          setPreferenceNotice('事务结果未确认，请重新读取参数并核对备份。')
        }
      }
    } catch {
      if (sequence === codeReadSequence.current) {
        setCodePreparation(undefined)
        setCodeNotice('配置请求未确认，请重新准备实际文件后核对。')
      }
    } finally {
      if (sequence === codeReadSequence.current) setBusy(false)
    }
  }
  const openBrowser = async (): Promise<void> => {
    ++codeReadSequence.current
    setCodePreparation(undefined)
    setBusy(true)
    setCodeNotice('')
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'relayBrowserOpen'
      )) as RelayBrowserLaunchResult
      setCodeNotice(result.warnings.join(' '))
    } catch {
      setCodeNotice(
        '专用窗口启动未确认。请核对本次 Relay 专用 HTTP 监听、Chrome 与专用资料状态；不会调用默认浏览器。'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <BasePage ref={pageRef} title={RELAY_WORKSPACE_PANELS[activePanel].title} contained hidePin>
      <div
        key={restoredRevision}
        className="relay-workspace relay-module-page"
        data-active-panel={activePanel}
        data-shell-theme={shellDark ? 'dark' : 'light'}
      >
        {shellState?.settings.customCSS && (
          <style data-relay-custom-style>{shellState.settings.customCSS}</style>
        )}
        <RelayWorkspaceTabs active={activePanel} />
        {inventoryError && !profileInventory && activePanel !== 'profiles' && (
          <div className="relay-notice" role="alert">
            配置列表读取失败。
            <button
              disabled={busy}
              onClick={() => {
                if (busy || inventoryReading.current) return
                inventoryReading.current = true
                setBusy(true)
                void refreshProfileInventory()
                  .catch(() => setInventoryError(true))
                  .finally(() => {
                    inventoryReading.current = false
                    setBusy(false)
                  })
              }}
            >
              重新读取
            </button>
          </div>
        )}
        <RelayWorkspaceSection panels={['overview']} active={activePanel}>
          <RelayOverviewPanel status={status} active={activePanel === 'overview'} />
        </RelayWorkspaceSection>
        {(activePanel === 'settings' || activePanel === 'shell') && (
          <RelayLoginItemSetting busy={busy} onBusy={setBusy} />
        )}
        <RelayWorkspaceSection panels={['settings']} active={activePanel}>
          <RelayUIPreferencesPanel busy={busy} onBusy={setBusy} />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['maintenance']} active={activePanel}>
          <RelayMaintenancePanel busy={busy} onBusy={setBusy} />
          <RelayOwnedResetPanel busy={busy} onBusy={setBusy} />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['shell']} active={activePanel}>
          <RelayShellPanel busy={busy} onBusy={setBusy} />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['backup']} active={activePanel}>
          <RelayBackupPanel
            busy={busy}
            inspectBusy={runtimeGistBusy}
            onBusy={setBusy}
            restoreNotice={backupReceipt?.scope === 'local' ? backupReceipt.text : undefined}
            onRestoreNotice={(text) =>
              setBackupReceipt(text ? { scope: 'local', text } : undefined)
            }
          />
          <p>
            <Link className="text-primary underline" to="/relay?panel=recovery">
              恢复客户端配置备份
            </Link>
          </p>
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['backup-accounts']} active={activePanel}>
          <RelayBackupAccountPanel
            busy={runtimeGistBusy}
            remoteBusy={busy}
            tunSessionId={activeTunSessionId}
            onBusy={setBusy}
            onInvalidate={() => {
              setAccountRemotePreparation({})
              setAccountRuntimePreparation({})
            }}
            onPrepared={(plan, result) => setAccountRemotePreparation({ plan, result })}
            onRuntimePrepared={(plan, result) => {
              setAccountRuntimePreparation({ plan, result })
              navigate(relayWorkspaceLink('runtime-share'))
            }}
          />
          <RelayWebdavBackupSchedulerPanel
            busy={operationBusy || !!tunState?.pending || tunUnconfirmed}
            onBusy={setBusy}
          />
          <RelayWebdavDirectoryPanel
            busy={operationBusy || !!tunState?.pending || tunUnconfirmed}
            onBusy={setBusy}
          />
          <RelayRemoteBackupPanel
            busy={busy}
            onBusy={setBusy}
            restoreNotice={backupReceipt?.scope === 'remote' ? backupReceipt.text : undefined}
            onRestoreNotice={(text) =>
              setBackupReceipt(text ? { scope: 'remote', text } : undefined)
            }
            externalPreparation={accountRemotePreparation}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['runtime-share']} active={activePanel}>
          <RelayRuntimeGistPanel
            busy={runtimeGistBusy}
            tunSessionId={activeTunSessionId}
            onBusy={setBusy}
            externalPreparation={accountRuntimePreparation}
          />
          <RelayRuntimeGistSyncPanel
            busy={runtimeGistBusy}
            tunSessionId={activeTunSessionId}
            onBusy={setBusy}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['code']} active={activePanel}>
          <section className="relay-panel">
            <div className="relay-heading">
              <div>
                <span className="relay-eyebrow">CONFIGURATION STUDIO</span>
                <h2>Claude Code 配置预览</h2>
              </div>
              <span className="relay-label">不应用配置</span>
            </div>
            <p>
              在这里输入草稿，核对代理和内网例外。生成时只读取助手参数，不读取客户端或 Clash
              配置；不会连接代理或应用方案。
            </p>
            <fieldset disabled={busy || desktopBlocking}>
              <div className="relay-form-grid">
                <label>
                  HTTP / 混合端口
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={input.httpPort}
                    onChange={(e) => changeInput({ ...input, httpPort: Number(e.target.value) })}
                  />
                </label>
                <label>
                  现有节点名称
                  <input
                    value={input.node}
                    onChange={(e) => changeInput({ ...input, node: e.target.value })}
                  />
                </label>
              </div>
              <label>
                内网直连例外
                <input
                  placeholder="git.company.local,10.10.0.5"
                  value={input.internalExceptions}
                  onChange={(e) => changeInput({ ...input, internalExceptions: e.target.value })}
                />
              </label>
              <label>
                已有 settings.json 草稿
                <textarea
                  rows={5}
                  spellCheck={false}
                  value={input.existingJSON}
                  onChange={(e) => changeInput({ ...input, existingJSON: e.target.value })}
                />
              </label>
            </fieldset>
            <div className="relay-action">
              <button
                onClick={() => void generate({ kind: 'configuration', input })}
                disabled={busy || status?.nativeReady !== true}
              >
                生成配置草稿
              </button>
              <span>保留其他字段；清理覆盖 AI 域名的直连例外。</span>
            </div>
            <div className="relay-action relay-tools">
              <button
                onClick={() => void generate({ kind: 'simulation' })}
                disabled={busy || status?.nativeReady !== true}
              >
                运行离线策略模拟
              </button>
              <button onClick={() => void generate({ kind: 'handoff' })} disabled={busy}>
                查看内置交接参考
              </button>
              <button
                onClick={() => void generate({ kind: 'edgeProfile' })}
                disabled={busy || status?.nativeReady !== true}
              >
                生成 Edge 描述文件
              </button>
              <span>独立工具不读取实际客户端配置、不启动浏览器或过滤器。</span>
            </div>
            {error && (
              <p role="alert" className="relay-error">
                {error}
              </p>
            )}
            {activity && <p role="status">{activity}</p>}
            {output && (
              <RelayDraftArtifacts
                key={output.artifacts[0]?.id}
                result={output}
                busy={busy}
                onAction={(request) => void artifactAction(request)}
              />
            )}
          </section>
          <RelayPreferencesPanel
            snapshot={preferenceSnapshot}
            notice={preferenceNotice}
            busy={busy}
            ready={status?.nativeReady === true}
            onRead={() => void readPreferences()}
            onSave={() => void savePreferences()}
          />
          <RelayCodePanel
            preparation={codePreparation}
            notice={codeNotice}
            busy={busy}
            ready={status?.nativeReady === true}
            onPrepare={() => void prepareCode()}
            onApply={() => void prepareCode(true)}
            onOpen={() => void openBrowser()}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['substore']} active={activePanel}>
          <RelaySubStorePanel busy={busy} onBusy={setBusy} />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['plugins']} active={activePanel}>
          <RelayPluginsPanel
            busy={busy}
            onBusy={setBusy}
            onSaved={async () =>
              setProfileInventory(
                (await window.electron.ipcRenderer.invoke(
                  'relayProfileList'
                )) as RelayProfileInventory
              )
            }
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['resource-acquisition']} active={activePanel}>
          <RelayUpdatePanel busy={busy} onBusy={setBusy} />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['app-update']} active={activePanel}>
          <RelayAppUpdatePanel busy={busy} onBusy={setBusy} />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['profile-sources']} active={activePanel}>
          <RelaySubscriptionSourcesPanel
            busy={busy}
            onBusy={setBusy}
            onSaved={async () =>
              setProfileInventory(
                (await window.electron.ipcRenderer.invoke(
                  'relayProfileList'
                )) as RelayProfileInventory
              )
            }
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['geodata']} active={activePanel}>
          <RelayGeoDataPanel
            active={activePanel === 'geodata' && !!profileInventory}
            busy={operationBusy || !!tunState?.pending || tunUnconfirmed}
            onBusy={setBusy}
            tunSessionId={
              tunState?.owned &&
              tunState.phase === 'active' &&
              tunState.traffic === 'forwarding' &&
              !tunUnconfirmed
                ? tunState.sessionId
                : undefined
            }
            onModeChanged={() => setCompleteEvidenceId(undefined)}
          />
          <details className="relay-panel">
            <summary>缓存与高级资源</summary>
            <div className="relay-action">
              <a className="text-primary underline" href="#/relay?panel=resource-acquisition">
                可信资源与 Smart 模型候选
              </a>
              <a className="text-primary underline" href="#/relay?panel=smart-resources">
                本次实例的 Smart 状态与工具
              </a>
            </div>
            <p>
              <a className="text-primary underline" href="#/relay?panel=rule-providers">
                选择配置并结构化管理规则提供者
              </a>
              ；定义另存与私有缓存固化均不更新当前活动提供者。
            </p>
            <RelayResourcesPanel
              busy={busy}
              activeBusy={operationBusy || !!tunState?.pending || tunUnconfirmed}
              tunSessionId={
                tunState?.owned &&
                tunState.phase === 'active' &&
                tunState.traffic === 'forwarding' &&
                !tunUnconfirmed
                  ? tunState.sessionId
                  : undefined
              }
              onBusy={setBusy}
            />
          </details>
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['providers']} active={activePanel}>
          <RelayProvidersPanel
            profiles={profileInventory?.profiles ?? []}
            busy={busy}
            onBusy={setBusy}
            onSaved={async () =>
              setProfileInventory(
                (await window.electron.ipcRenderer.invoke(
                  'relayProfileList'
                )) as RelayProfileInventory
              )
            }
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['profiles']} active={activePanel}>
          <RelaySubscriptionsDashboard
            active={activePanel === 'profiles'}
            inventory={profileInventory}
            currentSelection={profileConfig?.current ?? null}
            activeProfileId={
              managedOwner?.profileId ??
              (localState?.owned &&
              localState.phase === 'running' &&
              localState.traffic === 'listening' &&
              !localState.uncertain &&
              !localState.pending
                ? localState.profileId
                : undefined)
            }
            busy={busy || !!managedOwner || profilePending || runtimePending}
            selectionBusy={profileSelectionBusy || profilePending || runtimePending}
            onBusy={setBusy}
            onRefresh={refreshProfileInventory}
            onChoose={activateProfile}
            onBrowse={(profile) => navigate(`/proxies?profile=${encodeURIComponent(profile.id)}`)}
            onAdvanced={() => navigate(relayWorkspaceLink('profile-sources'))}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['profile-library', 'rule-providers']} active={activePanel}>
          <RelaySubscriptionPanel
            name={subscriptionName}
            url={subscriptionURL}
            proxyPort={subscriptionPort}
            preparation={subscriptionPreparation}
            profile={subscriptionProfile}
            state={subscriptionState}
            busy={busy || subscriptionPending}
            notice={subscriptionNotice}
            onName={(value) => {
              setSubscriptionName(value)
              setSubscriptionPreparation(undefined)
            }}
            onURL={(value) => {
              setSubscriptionURL(value)
              setSubscriptionPreparation(undefined)
            }}
            onPort={(value) => {
              setSubscriptionPort(value)
              setSubscriptionPreparation(undefined)
            }}
            onPrepare={() => void subscriptionAction('prepare')}
            onDownload={() => void subscriptionAction('download')}
            onSave={() => void subscriptionAction('save')}
            onCancel={() => void cancelSubscription()}
          />
          <RelayProfilesPanel
            preparation={profilePreparation}
            inventory={profileInventory}
            notice={profileNotice}
            busy={busy || !!managedOwner || profilePending || runtimePending}
            selectionBusy={profileSelectionBusy || profilePending || runtimePending}
            onPrepare={() => void profileAction('prepare')}
            onSave={() => void profileAction('save')}
            onList={() => void profileAction('list')}
            onInspect={(profile) => void runtimeAction({ id: profile.id, sha256: profile.sha256 })}
            onChoose={(profile) =>
              void profileAction('choose', { id: profile.id, sha256: profile.sha256 })
            }
            currentSelection={profileConfig?.current ?? null}
            activeProfileId={
              managedOwner?.profileId ??
              (localState?.owned &&
              localState.phase === 'running' &&
              !localState.uncertain &&
              !localState.pending
                ? localState.profileId
                : undefined)
            }
          />
          <RelayRuntimePanel
            preparation={runtimePreparation}
            checked={runtimeChecked}
            notice={runtimeNotice}
            busy={busy || runtimePending || profilePending}
            onCheck={() => void runtimeAction()}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['simple']} active={activePanel}>
          <RelaySimpleEditor
            initialModule={simpleModule}
            busy={busy || profilePending || runtimePending}
            onBusy={setSimplePending}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['variants']} active={activePanel}>
          <RelayVariantsPanel busy={busy} onBusy={setBusy} />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['override-library']} active={activePanel}>
          <RelayOverrideLibraryManager
            active={activePanel === 'override-library' && !!profileInventory}
            busy={
              busy ||
              runtimeGistBusy ||
              !!coreState?.pending ||
              localPending ||
              !!localState?.pending
            }
            onBusy={setBusy}
            onBindingsChanged={() => setCompleteEvidenceId(undefined)}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['sniffer']} active={activePanel}>
          <RelaySnifferManager
            active={activePanel === 'sniffer' && !!profileInventory}
            busy={busy}
            onBusy={setBusy}
            onChanged={() => setCompleteEvidenceId(undefined)}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['dns']} active={activePanel}>
          <RelayDnsManager
            active={activePanel === 'dns' && !!profileInventory}
            busy={busy}
            onBusy={setBusy}
            onChanged={() => setCompleteEvidenceId(undefined)}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['rules']} active={activePanel}>
          <RelayRulesManager
            active={activePanel === 'rules' && !!profileInventory}
            preferredProfile={preferredProfile}
            busy={busy}
            onBusy={setBusy}
            onChanged={() => setCompleteEvidenceId(undefined)}
            localState={localState}
            tunState={tunState}
            tunUnconfirmed={tunUnconfirmed}
            runtimeBusy={runtimeGistBusy}
            onLocalState={(next, expected) =>
              setLocalState((current) => adoptRuleState(current, next, expected))
            }
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['configuration']} active={activePanel}>
          <RelayConfigurationEditPanel
            busy={busy}
            onBusy={setBusy}
            onChecked={setCompleteEvidenceId}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['tun']} active={activePanel}>
          <RelayTunPanel
            active={activePanel === 'tun'}
            profileConfig={profileConfig}
            onConfigurationChange={() => setCompleteEvidenceId(undefined)}
            completeEvidenceId={completeEvidenceId}
            busy={
              operationBusy ||
              !!coreState?.pending ||
              localPending ||
              !!localState?.pending ||
              !!desktopState?.pending
            }
            activationBlocked={
              !!coreBlocking ||
              !!desktopBlocking ||
              localPending ||
              !!localState?.pending ||
              !!localState?.uncertain ||
              (!!localState?.owned &&
                (localState.phase !== 'running' || localState.traffic !== 'listening'))
            }
            onBusy={setBusy}
            onState={setTunState}
            onUnconfirmed={setTunUnconfirmed}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['core-recovery']} active={activePanel}>
          <RelayCoreRecoveryPanel busy={busy} onBusy={setBusy} />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['system-proxy']} active={activePanel}>
          <RelaySystemProxyPanel
            active={activePanel === 'system-proxy' && !!profileInventory}
            defaultSettings={{
              port: relayProxyRunning(localState) ? (localState?.httpPort ?? localPort) : localPort
            }}
            mixedPort={relayProxyRunning(localState) ? localState?.ports?.mixed : localPorts.mixed}
            busy={operationBusy || simplePending || !!tunState?.pending || tunUnconfirmed}
            onBusy={setBusy}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['core-check']} active={activePanel}>
          <RelayCorePanel
            state={coreState}
            preparation={corePreparation}
            mode={coreMode}
            busy={busy || localPending || !!localState?.owned}
            notice={coreNotice}
            onMode={(mode) => {
              ++coreSequence.current
              setCoreMode(mode)
              setCorePreparation(undefined)
            }}
            onPrepare={() => void prepareCore()}
            onStart={() => void coreAction('start')}
            onStop={() => void coreAction('stop')}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['core']} active={activePanel}>
          <RelayLocalProxyPanel
            active={activePanel === 'core' && !!profileInventory}
            onBusy={setBusy}
            onConfigurationChange={() => {
              setCompleteEvidenceId(undefined)
              setLocalPreparation(undefined)
            }}
            profiles={profileInventory?.profiles ?? []}
            preferredProfileId={preferredProfile?.id}
            onUse={activateProfile}
            state={localState}
            preparation={localPreparation}
            ports={localPorts}
            resolverMode={resolverMode}
            lifetime={persistentCore ? 'persistent' : 'main'}
            onLifetime={(lifetime) => {
              setPersistentCore(lifetime === 'persistent')
              setLocalPreparation(undefined)
            }}
            logLevel={localLogLevel}
            onLogLevel={(level) => {
              setLocalLogLevel(level)
              setLocalPreparation(undefined)
            }}
            dedicated={dedicated}
            planReady={!!localPlanRecord && !localPlanLoading}
            planDirty={localPlanDirty}
            planNotice={localPlanNotice}
            onSavePlan={() => void saveLocalPlanOnly()}
            onDedicated={(plan) => {
              setDedicated(plan)
              markLocalPlanEdited()
            }}
            busy={busy || localPending}
            notice={localNotice}
            onPorts={(ports) => {
              setLocalPorts(ports)
              markLocalPlanEdited()
            }}
            onResolverMode={(mode) => {
              setResolverMode(mode)
              markLocalPlanEdited()
            }}
            onPrepare={(profile) => void prepareLocalProxy(profile)}
            onReload={(profile) => void reloadLocalProxy(profile)}
            onStart={() => void localAction('start')}
            onStop={() => void localAction('stop')}
            onRefresh={() => void localAction('refresh')}
            onSelect={(group, member) => void localAction('select', group, member)}
            onTest={(group, member) => void localAction('delay', group, member)}
            onAutomatic={(group) => void localAction('automatic', group)}
          />
          <details className="relay-panel">
            <summary>后台运行与恢复</summary>
            <RelayCoreOwnerPanel />
          </details>
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['smart-resources']} active={activePanel}>
          <RelaySmartToolsPanel
            ordinaryInstanceId={localState?.phase === 'running' ? localState.instanceId : undefined}
            ordinaryConfigurationRevision={
              localState?.phase === 'running' ? localState.configurationRevision : undefined
            }
            tunSessionId={activeTunSessionId}
            busy={
              operationBusy ||
              localPending ||
              !!localState?.pending ||
              !!tunState?.pending ||
              tunUnconfirmed
            }
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['connections', 'logs', 'network']} active={activePanel}>
          <RelayRuntimeInfoPanel
            active={['connections', 'logs', 'network'].includes(activePanel) && !!profileInventory}
            state={localState}
            busy={busy}
            onBusy={setBusy}
            view={
              activePanel === 'logs'
                ? 'logs'
                : activePanel === 'network'
                  ? 'network'
                  : 'connections'
            }
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['clients']} active={activePanel}>
          <RelayAiClientsPanel
            state={localState}
            claudeCodePort={input.httpPort}
            busy={busy || localPending}
            onBusy={setBusy}
            onAssociate={(httpPort, node) => {
              const settings = { ...input, httpPort, node }
              changeInput(settings)
              navigate(relayWorkspaceLink('code'))
              void prepareCode(true, settings)
            }}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['guard']} active={activePanel}>
          <RelayGuardScopedCLIPanel busy={busy} onBusy={setBusy} />
          <RelayGuardManagementPanel busy={busy} onBusy={setBusy} />
          <RelayGuardReadinessPanel
            report={guardReadiness}
            notice={guardNotice}
            busy={busy}
            ready={status?.nativeReady === true}
            onRead={() => void readGuardReadiness()}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['recovery']} active={activePanel}>
          <RelayRecoveryPanel
            status={recovery}
            notice={recoveryNotice}
            busy={busy}
            ready={status?.nativeReady === true}
            onRead={() => void readRecovery()}
            preflight={recoveryPreflight}
            onInspect={(selection) => void inspectRecovery(selection)}
            onRestore={() => void restoreRecovery()}
            onOpenDirectory={(source) => void openBackupDirectory(source)}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['desktop-login']} active={activePanel}>
          <RelayEdgePanel
            report={edgeReport}
            notice={edgeNotice}
            busy={busy || !!desktopBlocking}
            ready={status?.nativeReady === true}
            onInspect={() => void edgeAction('inspect')}
            onOpen={() => void edgeAction('openProfile')}
            onEntry={(action) => void edgeAction(action)}
          />
          <RelayDesktopReadinessPanel
            report={desktopReadiness}
            notice={desktopNotice}
            busy={busy}
            ready={status?.nativeReady === true}
            onRead={() => void readDesktopReadiness()}
          />
          <RelayDesktopSessionPanel
            state={desktopState}
            notice={desktopSessionNotice}
            busy={busy}
            ready={status?.nativeReady === true}
            onAction={(action) => void desktopAction(action)}
          />
        </RelayWorkspaceSection>
        <RelayWorkspaceSection panels={['diagnostics']} active={activePanel}>
          <section className="relay-panel">
            <h2>只读核对现有配置</h2>
            <p>
              点击后读取用户级 Code
              设置、专用浏览器资料、系统代理、Edge强制策略和现有Clash配置，探测本机端口并只读查询本地核心。不会访问外部检测网站。
            </p>
            <div className="relay-action">
              <button
                disabled={busy || status?.nativeReady !== true}
                onClick={() => void diagnose()}
              >
                执行只读检测
              </button>
              <span>不会保存、重载、切换代理或断开现有连接。</span>
            </div>
          </section>
          {observation && (
            <RelayDiagnosticsPanel
              observation={observation}
              busy={busy}
              onGuardPlan={(node, evidenceId) => {
                navigate(relayWorkspaceLink('code'))
                void generate({ kind: 'guardPlan', node, evidenceId })
              }}
            />
          )}
        </RelayWorkspaceSection>
      </div>
    </BasePage>
  )
}
