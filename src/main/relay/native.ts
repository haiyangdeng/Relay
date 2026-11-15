import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { ownedNativeDiagnostic } from '../../shared/relay/diagnostic-evidence'
import {
  validateCoreRecordRecovery,
  validateCoreSelectionSnapshot,
  type CoreSelectionSnapshot,
  type CoreRecordRecoveryReport
} from '../../shared/relay/lifecycle'
import { profileSelection, type RelayProfileSelection } from '../../shared/relay/runtime'
import {
  RelayPreviewInput,
  RelayPreviewOutput,
  RelaySimulationOutput,
  RelayEdgeProfileOutput,
  RelayPreferences,
  RelayReadOnlyReport,
  RelayGuardPlanOutput,
  RelayPreferenceSnapshot,
  RelaySavePreferencesRequest,
  RelayRecoveryStatus,
  RelayRecoverySelection,
  RelayRecoveryPreflight,
  RelayRecoveryRestoreResult,
  RelayCodePrepared,
  RelayCodeApplied,
  RelayDesktopReadiness,
  validateDesktopReadiness,
  validateCodePrepared,
  validateCodeApplied,
  validateRecoveryRestoreResult,
  validateRecoverySelection,
  validateRecoveryPreflight,
  validateRecoveryStatus,
  validatePreferenceSnapshot,
  validateSavePreferencesRequest,
  validateEdgeProfileOutput,
  validatePreferences,
  validateReadOnlyReport,
  validateGuardPlanOutput,
  validatePreviewInput,
  validatePreviewOutput,
  validateSimulationOutput
} from '../../shared/relay/protocol'
import {
  validateEdgeInspection,
  validateEdgeOpenResult,
  type RelayEdgeInspection,
  type RelayEdgeOpenResult,
  type RelayEdgeAction
} from '../../shared/relay/edge'
import { validateGuardReadiness, type RelayGuardReadiness } from '../../shared/relay/guard'
import {
  systemProxyReport,
  type SystemProxyReport,
  type NativeSystemProxySettings
} from '../../shared/relay/system-proxy'
import type { RelayDiagnosticContext, RelayStateContext, RelayCodeContext } from './context'
import { nativeRuntimeExecutable } from './native-runtime'
import type {
  BackupRecoveryMoveRequest,
  BackupRecoveryPublishRequest,
  BackupFileRequest,
  BackupFileReceipt
} from './backup/store'

export async function backupFileNative(
  executable: string,
  context: RelayStateContext,
  request: BackupFileRequest
): Promise<BackupFileReceipt> {
  const result = await invokeNative(executable, '--backup-file', { context, request })
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('恢复私有文件发布未确认。')
  const value = result as Record<string, unknown>,
    raw = value.identity
  if (
    Object.keys(value).sort().join(',') !== 'identity,sha256' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw)
  )
    throw new Error('恢复私有文件回执无效。')
  const item = raw as Record<string, unknown>
  if (
    Object.keys(item).sort().join(',') !== 'dev,ino,mode,uid' ||
    ![item.dev, item.ino, item.uid, item.mode].every(
      (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
    ) ||
    item.ino === 0 ||
    (request.directory
      ? (Number(item.mode) & 0o170000) !== 0o040000 || (Number(item.mode) & 0o7022) !== 0
      : item.mode !== (0o100000 | request.mode)) ||
    item.uid !== process.getuid?.()
  )
    throw new Error('恢复私有文件身份未确认。')
  return {
    sha256: value.sha256,
    identity: {
      dev: Number(item.dev),
      ino: Number(item.ino),
      uid: Number(item.uid),
      mode: Number(item.mode)
    }
  }
}

export async function backupPublishNative(
  executable: string,
  context: RelayStateContext,
  request: BackupRecoveryPublishRequest
): Promise<void> {
  const result = await invokeNative(executable, '--backup-journal', { context, request })
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Object.keys(result).join(',') !== 'status' ||
    (result as Record<string, unknown>).status !== 'published'
  )
    throw new Error('恢复日志发布未确认，请重新核对记录，不要自动重试。')
}

export async function backupMoveNative(
  executable: string,
  context: RelayStateContext,
  request: BackupRecoveryMoveRequest
): Promise<void> {
  const result = await invokeNative(executable, '--backup-move', { context, request })
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Object.keys(result).join(',') !== 'status' ||
    (result as Record<string, unknown>).status !== 'moved'
  )
    throw new Error('备份移动结果未确认，请重新核对恢复记录，不要自动重试。')
}

export function systemProxyNative(
  executable: string,
  context: RelayStateContext,
  action: 'inspect' | 'prepare' | 'apply' | 'prepareRestore' | 'restore' | 'retireDetached',
  settings?: NativeSystemProxySettings,
  expectedRevision?: string
): Promise<SystemProxyReport> {
  return (
    action === 'apply' || action === 'restore' || action === 'retireDetached'
      ? nativeRuntimeExecutable(executable, context)
      : Promise.resolve(executable)
  )
    .then((runtime) =>
      invokeNative(runtime, '--system-proxy', {
        context,
        action,
        ...(settings ? { settings } : {}),
        ...(expectedRevision ? { expectedRevision } : {})
      })
    )
    .then(systemProxyReport)
}

export function guardHostResourceNative(
  executable: string
): Promise<{ path: string; trusted: true; resourceSHA256: string }> {
  return invokeNative(executable, '--guard-host-resource-inspect').then((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('过滤宿主资源未确认。')
    const value = raw as Record<string, unknown>
    if (
      Object.keys(value).sort().join(',') !== 'path,resourceSHA256,trusted,version' ||
      value.version !== 1 ||
      value.trusted !== true ||
      typeof value.path !== 'string' ||
      !value.path.startsWith('/') ||
      !value.path.endsWith('/RelayGuard.node') ||
      value.path.includes('\0') ||
      typeof value.resourceSHA256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.resourceSHA256)
    )
      throw new Error('当前过滤管理宿主尚未通过签名资源核验。')
    return { path: value.path, trusted: true as const, resourceSHA256: value.resourceSHA256 }
  })
}

export function guardReadinessNative(executable: string): Promise<RelayGuardReadiness> {
  return invokeNative(executable, '--guard-status').then(validateGuardReadiness)
}

export function inspectEdgeNative(
  executable: string,
  context: RelayStateContext
): Promise<RelayEdgeInspection> {
  return invokeNative(executable, '--edge-tools', { action: 'inspect', context }).then(
    validateEdgeInspection
  )
}
export function openEdgeToolNative(
  executable: string,
  action: RelayEdgeAction | 'openProfile',
  context: RelayStateContext,
  expectedRevision?: string
): Promise<RelayEdgeOpenResult> {
  if (
    !['openProfile', 'deviceManagement', 'edgePolicy'].includes(action) ||
    (action === 'openProfile'
      ? !expectedRevision || !/^[a-f0-9]{64}$/u.test(expectedRevision)
      : expectedRevision !== undefined)
  )
    throw new Error('Edge 操作参数无效。')
  return invokeNative(executable, '--edge-tools', {
    action,
    context,
    ...(expectedRevision ? { expectedRevision } : {})
  })
    .then(validateEdgeOpenResult)
    .then((result) => {
      if (result.action !== action) throw new Error('Edge 打开结果与请求不一致。')
      return result
    })
}

export function nativeReady(executable: string): boolean {
  return existsSync(executable)
}
export function desktopReadinessNative(
  executable: string,
  context: RelayStateContext
): Promise<RelayDesktopReadiness> {
  return invokeNative(executable, '--desktop-readiness', context).then(validateDesktopReadiness)
}
export function prepareCodeNative(
  executable: string,
  raw: unknown,
  context: RelayCodeContext
): Promise<RelayCodePrepared> {
  const settings = validatePreferences(raw)
  return invokeNative(executable, '--code-prepare', { context, settings })
    .then(validateCodePrepared)
    .then((result) => {
      if (result.httpPort !== settings.httpPort) throw new Error('Code 准备端口与请求不一致。')
      return result
    })
}
export function applyCodeNative(
  executable: string,
  raw: unknown,
  expectedRevision: string,
  context: RelayCodeContext
): Promise<RelayCodeApplied> {
  const settings = validatePreferences(raw)
  if (!/^[a-f0-9]{64}$/u.test(expectedRevision)) throw new Error('请先准备 Code 配置。')
  return invokeNative(executable, '--code-apply', { context, settings, expectedRevision })
    .then(validateCodeApplied)
    .then((result) => {
      const saved = result.preferenceSnapshot.preferences
      if (
        saved.httpPort !== settings.httpPort ||
        saved.node !== settings.node ||
        saved.internalExceptions !== settings.internalExceptions
      )
        throw new Error('Code 写入结果与请求参数不一致。')
      return result
    })
}
export function recoveryStatusNative(
  executable: string,
  context: RelayStateContext
): Promise<RelayRecoveryStatus> {
  return invokeNative(executable, '--recovery-status', context).then(validateRecoveryStatus)
}

export function recoveryPreflightNative(
  executable: string,
  raw: unknown,
  context: RelayStateContext
): Promise<RelayRecoveryPreflight> {
  const selection = validateRecoverySelection(raw)
  return invokeNative(executable, '--recovery-preflight', { context, selection })
    .then(validateRecoveryPreflight)
    .then((result) => {
      if (result.selection.source !== selection.source || result.selection.id !== selection.id)
        throw new Error('预检返回了其他记录，已丢弃。')
      return result
    })
}

export function recoveryRestoreNative(
  executable: string,
  selection: RelayRecoverySelection,
  expectedRevision: string,
  allowLegacy: boolean,
  context: RelayStateContext
): Promise<RelayRecoveryRestoreResult> {
  const validated = validateRecoverySelection(selection)
  if (!/^[a-f0-9]{64}$/u.test(expectedRevision) || typeof allowLegacy !== 'boolean')
    throw new Error('恢复预检版本或确认值无效。')
  return invokeNative(executable, '--recovery-restore', {
    context,
    selection: validated,
    expectedRevision,
    allowLegacy
  })
    .then(validateRecoveryRestoreResult)
    .then((result) => {
      if (result.status !== 'restored') throw new Error('恢复结果未确认，请重新预检。')
      return result
    })
}

export function readPreferencesNative(
  executable: string,
  context: RelayStateContext
): Promise<RelayPreferenceSnapshot> {
  return invokeNative(executable, '--preferences', { action: 'read', context }).then(
    validatePreferenceSnapshot
  )
}

export function savePreferencesNative(
  executable: string,
  raw: unknown,
  context: RelayStateContext
): Promise<RelayPreferenceSnapshot> {
  const request = validateSavePreferencesRequest(raw)
  return invokeNative(executable, '--preferences', { action: 'save', context, ...request })
    .then(validatePreferenceSnapshot)
    .then((snapshot) => {
      if (
        snapshot.source !== 'relay' ||
        snapshot.preferences.httpPort !== request.preferences.httpPort ||
        snapshot.preferences.node !== request.preferences.node ||
        snapshot.preferences.internalExceptions !== request.preferences.internalExceptions
      )
        throw new Error('偏好保存结果与请求不一致，请重新读取核对。')
      return snapshot
    })
}

export function previewNative(executable: string, raw: unknown): Promise<RelayPreviewOutput> {
  const input: RelayPreviewInput = validatePreviewInput(raw)
  return invokeNative(executable, '--preview', input).then(validatePreviewOutput)
}

export function simulateNative(executable: string): Promise<RelaySimulationOutput> {
  return invokeNative(executable, '--simulate').then(validateSimulationOutput)
}

export function edgeProfileNative(executable: string): Promise<RelayEdgeProfileOutput> {
  return invokeNative(executable, '--edge-profile').then(validateEdgeProfileOutput)
}

export function diagnoseNative(
  executable: string,
  raw: unknown,
  context: RelayDiagnosticContext
): Promise<RelayReadOnlyReport> {
  const settings = validatePreferences(raw)
  return invokeNative(executable, '--diagnose', { settings, context }).then((raw) => ({
    ...validateReadOnlyReport(raw),
    ...(context.owned
      ? { owned: ownedNativeDiagnostic((raw as Record<string, unknown>).owned) }
      : {})
  }))
}

export function guardPlanNative(
  executable: string,
  node: string,
  proxyTypes: Record<string, string>
): Promise<RelayGuardPlanOutput> {
  return invokeNative(executable, '--guard-plan', { node, proxyTypes }).then(
    validateGuardPlanOutput
  )
}

export function coreRecordRecoveryNative(
  executable: string,
  context: RelayStateContext,
  action: 'inspect' | 'archive',
  expectedRevision?: string
): Promise<CoreRecordRecoveryReport> {
  return invokeNative(executable, '--core-record-recovery', {
    context,
    action,
    ...(expectedRevision ? { expectedRevision } : {})
  }).then(validateCoreRecordRecovery)
}

export function readCoreSelectionNative(
  executable: string,
  context: RelayStateContext
): Promise<CoreSelectionSnapshot> {
  return invokeNative(executable, '--core-preferences', { context, action: 'read' }).then(
    validateCoreSelectionSnapshot
  )
}
export function saveCoreSelectionNative(
  executable: string,
  context: RelayStateContext,
  selected: RelayProfileSelection,
  expectedRevision: string
): Promise<CoreSelectionSnapshot> {
  return invokeNative(executable, '--core-preferences', {
    context,
    action: 'save',
    selection: profileSelection(selected),
    expectedRevision
  }).then(validateCoreSelectionSnapshot)
}
function invokeNative(
  executable: string,
  operation:
    | '--preview'
    | '--simulate'
    | '--guard-status'
    | '--guard-host-resource-inspect'
    | '--edge-profile'
    | '--edge-tools'
    | '--diagnose'
    | '--guard-plan'
    | '--preferences'
    | '--recovery-status'
    | '--recovery-preflight'
    | '--recovery-restore'
    | '--code-prepare'
    | '--code-apply'
    | '--desktop-readiness'
    | '--core-record-recovery'
    | '--core-preferences'
    | '--backup-move'
    | '--backup-journal'
    | '--backup-file'
    | '--system-proxy',
  input?:
    | RelayPreviewInput
    | RelayStateContext
    | {
        context: RelayStateContext
        request: BackupRecoveryMoveRequest | BackupRecoveryPublishRequest | BackupFileRequest
      }
    | {
        context: RelayStateContext
        action: 'inspect' | 'prepare' | 'apply' | 'prepareRestore' | 'restore' | 'retireDetached'
        settings?: NativeSystemProxySettings
        expectedRevision?: string
      }
    | {
        action: 'inspect' | RelayEdgeAction | 'openProfile'
        context: RelayStateContext
        expectedRevision?: string
      }
    | { context: RelayCodeContext; settings: RelayPreferences; expectedRevision?: string }
    | { context: RelayStateContext; selection: RelayRecoverySelection }
    | {
        context: RelayStateContext
        selection: RelayRecoverySelection
        expectedRevision: string
        allowLegacy: boolean
      }
    | { settings: RelayPreferences; context: RelayDiagnosticContext }
    | { node: string; proxyTypes: Record<string, string> }
    | { action: 'read'; context: RelayStateContext }
    | { action: 'inspect' | 'archive'; context: RelayStateContext; expectedRevision?: string }
    | {
        action: 'save'
        context: RelayStateContext
        selection: RelayProfileSelection
        expectedRevision: string
      }
    | ({ action: 'save'; context: RelayStateContext } & RelaySavePreferencesRequest)
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [operation],
      {
        timeout:
          operation === '--backup-file'
            ? 60000
            : operation === '--system-proxy'
              ? 180000
              : operation === '--diagnose'
                ? 30000
                : 10000,
        maxBuffer: 2 * 1024 * 1024
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              operation === '--code-apply' ||
                operation === '--recovery-restore' ||
                operation === '--core-record-recovery' ||
                operation === '--core-preferences' ||
                operation === '--backup-move' ||
                operation === '--backup-journal' ||
                operation === '--backup-file' ||
                operation === '--system-proxy'
                ? '事务结果未确认，请重读记录并核对。'
                : operation === '--guard-status'
                  ? '保护构建状态未确认；没有查询或更改系统过滤器，请重新读取。'
                  : operation === '--edge-tools'
                    ? 'Edge 操作结果未确认；可能已暂存文件或出现系统窗口，请核对后重新检测。没有自动安装或重试。'
                    : operation === '--desktop-readiness'
                      ? '桌面只读检查未完成，未修改默认浏览器或会话记录。'
                      : operation === '--preferences'
                        ? '偏好操作未确认，请重新读取后核对；没有应用客户端或网络配置。'
                        : '原生生成未完成，请检查输入；没有应用配置。'
            )
          )
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error('原生生成返回格式异常。'))
        }
      }
    )
    child.stdin?.on('error', () =>
      reject(
        new Error(
          operation === '--system-proxy'
            ? '系统代理输入通道已关闭，事务结果未确认；请重读记录，不要自动重试。'
            : operation === '--backup-move' ||
                operation === '--backup-journal' ||
                operation === '--backup-file'
              ? '备份移动输入通道已关闭，结果未确认；请重新核对恢复记录，不要自动重试。'
              : '原生生成输入通道已关闭，没有应用配置。'
        )
      )
    )
    child.stdin?.end(input ? JSON.stringify(input) : undefined)
  })
}
