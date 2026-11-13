import type {
  RelaySimplePublicationIpcApi,
  RelaySimplePublicationState,
  RelaySimplePublicationResult
} from '../../../../shared/relay/simple-publication'
import type {
  RelaySimpleConfigurationIpcApi,
  RelaySimpleConfigurationSnapshot
} from '../../../../shared/relay/simple-configuration'
import type {
  RelaySimpleSourcesIpcApi,
  RelaySimpleSourcesSnapshot,
  RelaySimpleSourceMutation
} from '../../../../shared/relay/simple-sources'
import { SIMPLE_MODULES, type SimpleModule } from '../../../../shared/simple-config'
import type {
  RelayProfilePreparation,
  RelayProfileSaveResult
} from '../../../../shared/relay/profiles'
import type {
  RelaySimpleCode,
  RelaySimpleEditableDraft,
  RelaySimpleIpcApi,
  RelaySimpleMetadata,
  RelaySimplePreview
} from '../../../../shared/relay/simple'
import {
  readPublicationState,
  readPublicationPreparation,
  readPublicationResult,
  verifyPublishedResult,
  publicationStateBlocks,
  mayAbandonPublication,
  publicationDigest,
  type PublicationTicket
} from './simple-publication-state'
import {
  readConfigurationMetadata,
  readConfigurationSnapshot,
  mergeConfigurationMetadata,
  verifyConfigurationReceipt
} from './simple-configuration-state'
import {
  parseProfileChoices,
  parseOriginChoices,
  parseSourceSnapshot,
  sourceMetadata,
  sourceForm,
  sourceFormValue,
  verifySourceReceipt,
  type SourceProfileChoice,
  type SourceOriginChoice,
  type SimpleSourceForm
} from './simple-source-state'

export interface SimplePanelSourcesAdapter extends RelaySimpleSourcesIpcApi {
  listProfiles(): Promise<unknown>
  listSources(): Promise<unknown>
}
export interface SimplePanelState {
  publicationEnabled: boolean
  publicationState?: RelaySimplePublicationState
  publicationPreparation?: PublicationTicket
  publicationResult?: RelaySimplePublicationResult
  publicationReadInvalid: boolean
  publicationNeedsInspection: boolean
  configurationEnabled: boolean
  configurationSnapshot?: RelaySimpleConfigurationSnapshot
  sourcesEnabled: boolean
  moduleRevisionStale: boolean
  sourceSnapshot?: RelaySimpleSourcesSnapshot
  sourceProfiles?: SourceProfileChoice[]
  sourceOrigins?: SourceOriginChoice[]
  sourceForm?: SimpleSourceForm
  pending: boolean
  module: SimpleModule
  name: string
  metadata?: RelaySimpleMetadata
  modules?: Record<SimpleModule, string>
  savedModules?: Record<SimpleModule, string>
  preview?: RelaySimplePreview
  preparation?: RelayProfilePreparation
  needsRecovery: boolean
  notice: string
}
export interface SimplePanelAdapters {
  api: RelaySimpleIpcApi
  sources?: SimplePanelSourcesAdapter
  configuration?: RelaySimpleConfigurationIpcApi
  publication?: RelaySimplePublicationIpcApi
  saveProfile(request: { evidenceId: string }): Promise<RelayProfileSaveResult>
  isCurrent(): boolean
  isBlocked?(): boolean
  onBusy?(busy: boolean): void
}

const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, limit = 4096): value is string =>
  typeof value === 'string' && value.length <= limit
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 64 && value.every((entry) => text(entry))
function metadata(raw: unknown): RelaySimpleMetadata {
  if (
    !object(raw) ||
    typeof raw.exists !== 'boolean' ||
    typeof raw.revision !== 'string' ||
    !(raw.exists ? digest(raw.revision) : raw.revision === '') ||
    !Number.isSafeInteger(raw.publishedRevision) ||
    Number(raw.publishedRevision) < 0 ||
    typeof raw.dirty !== 'boolean' ||
    typeof raw.sharedConfigurationPinned !== 'boolean' ||
    !Array.isArray(raw.sources) ||
    raw.sources.length > 64
  )
    throw new Error('Malformed metadata')
  const sources = raw.sources.map((entry) => {
    if (
      !object(entry) ||
      !text(entry.id, 256) ||
      !text(entry.name, 256) ||
      typeof entry.mode !== 'string' ||
      !['extract', 'inline', 'http'].includes(entry.mode)
    )
      throw new Error('Malformed source summary')
    return {
      id: entry.id,
      name: entry.name,
      mode: entry.mode as 'extract' | 'inline' | 'http'
    }
  })
  return {
    exists: raw.exists,
    revision: raw.revision,
    publishedRevision: Number(raw.publishedRevision),
    dirty: raw.dirty,
    sharedConfigurationPinned: raw.sharedConfigurationPinned,
    sources
  }
}
function editable(raw: unknown): RelaySimpleEditableDraft {
  const info = metadata(raw)
  if (
    !object(raw) ||
    !object(raw.modules) ||
    Object.keys(raw.modules).length !== Object.keys(SIMPLE_MODULES).length ||
    !Object.keys(SIMPLE_MODULES).every(
      (key) =>
        Object.hasOwn(raw.modules as object, key) &&
        typeof (raw.modules as Record<string, unknown>)[key] === 'string'
    )
  )
    throw new Error('Malformed modules')
  const modules = {} as Record<SimpleModule, string>
  for (const module of Object.keys(SIMPLE_MODULES) as SimpleModule[]) {
    const value = raw.modules[module]
    if (typeof value !== 'string' || new TextEncoder().encode(value).length > 128 * 1024)
      throw new Error('Malformed module text')
    modules[module] = value
  }
  return { ...info, modules }
}
function preview(raw: unknown): RelaySimplePreview {
  if (
    !object(raw) ||
    !digest(raw.yamlSHA256) ||
    !Number.isSafeInteger(raw.bytes) ||
    Number(raw.bytes) < 0 ||
    !strings(raw.errors) ||
    typeof raw.valid !== 'boolean' ||
    raw.valid !== (raw.errors.length === 0)
  )
    throw new Error('Malformed preview')
  return {
    yamlSHA256: raw.yamlSHA256,
    bytes: Number(raw.bytes),
    errors: raw.errors.length ? ['已保存草稿的结构预览未通过。'] : [],
    valid: raw.valid
  }
}
function preparation(
  raw: unknown,
  expectedSHA256: string,
  expectedBytes: number
): RelayProfilePreparation {
  if (
    !object(raw) ||
    typeof raw.evidenceId !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(raw.evidenceId) ||
    !text(raw.name, 256) ||
    raw.sha256 !== expectedSHA256 ||
    !Number.isSafeInteger(raw.bytes) ||
    raw.bytes !== expectedBytes ||
    !object(raw.inspection) ||
    raw.inspection.structure !== 'passed' ||
    raw.inspection.active !== false ||
    raw.inspection.coreCompatibility !== 'notVerified' ||
    !strings(raw.inspection.issues)
  )
    throw new Error('Malformed preparation')
  return {
    evidenceId: raw.evidenceId,
    name: raw.name,
    sha256: expectedSHA256,
    bytes: Number(raw.bytes),
    inspection: {
      structure: 'passed',
      active: false,
      coreCompatibility: 'notVerified',
      issues: []
    }
  }
}
const codes: readonly RelaySimpleCode[] = [
  'invalid',
  'stale',
  'cancelled',
  'busy',
  'closed',
  'uncertain'
]
const initial = (): SimplePanelState => ({
  pending: false,
  publicationEnabled: false,
  publicationReadInvalid: false,
  publicationNeedsInspection: false,
  sourcesEnabled: false,
  configurationEnabled: false,
  moduleRevisionStale: false,
  module: 'general',
  name: 'Simple草稿副本',
  needsRecovery: false,
  notice: ''
})
export const hasUnsavedModules = (state: SimplePanelState): boolean =>
  !!state.modules &&
  !!state.savedModules &&
  (Object.keys(SIMPLE_MODULES) as SimpleModule[]).some(
    (module) => state.modules?.[module] !== state.savedModules?.[module]
  )

export const isPublicationBlocking = (state: SimplePanelState): boolean =>
  state.publicationEnabled &&
  (state.publicationReadInvalid ||
    state.publicationNeedsInspection ||
    publicationStateBlocks(state.publicationState))

export function createSimplePanelController(adapters: SimplePanelAdapters) {
  const reset = (): SimplePanelState => ({
    ...initial(),
    sourcesEnabled: !!adapters.sources,
    configurationEnabled: !!adapters.configuration,
    publicationEnabled: !!adapters.publication
  })
  let state = reset(),
    epoch = 0,
    active = true
  let operation: { epoch: number } | undefined
  const listeners = new Set<() => void>()
  const publish = (next: SimplePanelState): void => {
    if (
      next.module !== state.module ||
      next.name !== state.name ||
      next.modules !== state.modules ||
      next.sourceForm !== state.sourceForm
    )
      next = { ...next, publicationPreparation: undefined }
    if (next.modules) Object.freeze(next.modules)
    if (next.savedModules) Object.freeze(next.savedModules)
    state = Object.freeze(next)
    listeners.forEach((listener) => listener())
  }
  const invalidate = (): void => {
    ++epoch
    publish({
      ...reset(),
      pending: !!operation,
      notice: '编辑上下文已失效；内容和准备凭据已清除，请显式重新读取。'
    })
  }
  const ownerCurrent = (): boolean => {
    try {
      return active && adapters.isCurrent()
    } catch {
      return false
    }
  }
  const live = (ticket: { epoch: number }): boolean => {
    if (operation !== ticket || ticket.epoch !== epoch) return false
    if (ownerCurrent()) return true
    invalidate()
    return false
  }
  const run = async (
    body: (ticket: { epoch: number }) => Promise<void>,
    publicationRecovery = false
  ): Promise<void> => {
    if (state.publicationPreparation) publish({ ...state, publicationPreparation: undefined })
    if (
      operation ||
      adapters.isBlocked?.() ||
      (!publicationRecovery && isPublicationBlocking(state))
    )
      return
    if (!ownerCurrent()) {
      invalidate()
      return
    }
    const ticket = { epoch }
    operation = ticket
    publish({ ...state, pending: true, preparation: undefined })
    adapters.onBusy?.(true)
    try {
      await body(ticket)
    } catch {
      if (live(ticket))
        publish({
          ...state,
          preview: undefined,
          preparation: undefined,
          notice: '本次操作未确认；请检查草稿或读取配置列表核对，不会自动重试。'
        })
    } finally {
      if (operation === ticket) {
        operation = undefined
        publish({ ...state, pending: false })
        adapters.onBusy?.(false)
      }
    }
  }
  const result = <T>(raw: unknown, read: (value: unknown) => T): T | undefined => {
    if (!object(raw)) throw new Error('Malformed reply')
    if (raw.status === 'ok') return read(raw.value)
    if (!codes.includes(raw.status as RelaySimpleCode)) throw new Error('Malformed status')
    if (raw.status === 'uncertain' || raw.status === 'stale' || raw.status === 'closed')
      publish({
        ...reset(),
        pending: true,
        needsRecovery: raw.status === 'uncertain',
        notice:
          raw.status === 'uncertain'
            ? '草稿写入或读取回执不确定。请显式核对磁盘草稿后恢复编辑。'
            : '草稿版本或编辑上下文已改变，请显式重新读取；读取不会更新来源或共享配置绑定。'
      })
    else
      publish({
        ...state,
        preview: undefined,
        preparation: undefined,
        notice: '本次操作未完成。请检查草稿或等待其他操作结束后重试。'
      })
    return undefined
  }
  const advanceConfiguration = (
    info: RelaySimpleMetadata,
    oldRevision: string
  ): RelaySimpleConfigurationSnapshot | undefined => {
    const previous = state.configurationSnapshot
    if (!previous || previous.revision !== oldRevision) return undefined
    return {
      ...previous,
      exists: info.exists,
      revision: info.revision,
      dirty: info.dirty,
      publishedRevision: info.publishedRevision,
      sharedConfigurationPinned: info.sharedConfigurationPinned
    }
  }
  const configurationReply = <T>(raw: unknown, read: (value: unknown) => T): T | undefined => {
    if (!object(raw)) throw new Error('Malformed configuration reply')
    if (raw.status === 'ok') return read(raw.value)
    if (!codes.includes(raw.status as RelaySimpleCode))
      throw new Error('Malformed configuration status')
    const invalidated = ['stale', 'closed', 'uncertain'].includes(String(raw.status))
    publish({
      ...state,
      preview: undefined,
      preparation: undefined,
      ...(invalidated
        ? {
            configurationSnapshot: undefined,
            sourceSnapshot: undefined,
            sourceForm: undefined,
            sourceProfiles: undefined,
            sourceOrigins: undefined,
            moduleRevisionStale: !!state.modules,
            needsRecovery: raw.status === 'uncertain'
          }
        : {}),
      notice:
        raw.status === 'uncertain'
          ? '共享绑定保存回执不确定；未保存模块文本仍保留，请先核对磁盘草稿。'
          : invalidated
            ? '草稿或共享配置版本已变化；未保存模块文本仍保留，请显式重新查看版本。'
            : '本次共享绑定操作未完成，没有确认任何变更。'
    })
    return undefined
  }
  const saveConfiguration = (selected: string): Promise<void> => {
    const before = state.configurationSnapshot,
      adapter = adapters.configuration
    if (!before || !adapter || state.needsRecovery) return Promise.resolve()
    if (
      selected &&
      (before.candidate.status !== 'available' ||
        before.candidate.configurationRevision !== selected)
    )
      return Promise.resolve()
    return run(async (ticket) => {
      publish({ ...state, preview: undefined, preparation: undefined })
      const raw = await adapter.relaySimpleSaveConfigurationBinding({
        expectedRevision: before.revision,
        configurationRevision: selected
      })
      if (!live(ticket)) return
      const saved = configurationReply(raw, readConfigurationMetadata)
      if (!saved) return
      verifyConfigurationReceipt(before, saved, selected)
      const matches = !state.modules || state.metadata?.revision === before.revision,
        sourceMatches = state.sourceSnapshot?.revision === before.revision
      publish({
        ...state,
        configurationSnapshot: { ...saved, candidate: before.candidate },
        metadata:
          state.metadata?.revision === before.revision
            ? mergeConfigurationMetadata(saved, state.metadata.sources)
            : state.metadata,
        sourceSnapshot:
          sourceMatches && state.sourceSnapshot
            ? {
                ...state.sourceSnapshot,
                ...mergeConfigurationMetadata(saved, []),
                sources: state.sourceSnapshot.sources
              }
            : undefined,
        sourceForm: undefined,
        preview: undefined,
        preparation: undefined,
        moduleRevisionStale: !matches,
        notice: matches
          ? '已保存明确选择的共享配置绑定。模块文本和来源保持，请显式重新预览。'
          : '共享绑定已保存，未保存模块文本仍保留；模块基线不同，请显式重新读取后再保存或预览。'
      })
    })
  }
  const sourceReply = (raw: unknown): RelaySimpleSourcesSnapshot | undefined => {
    if (!object(raw)) throw new Error('Malformed source reply')
    if (raw.status === 'ok') return parseSourceSnapshot(raw.value, metadata)
    if (!codes.includes(raw.status as RelaySimpleCode)) throw new Error('Malformed source status')
    const invalidated = ['stale', 'closed', 'uncertain'].includes(String(raw.status))
    publish({
      ...state,
      preview: undefined,
      preparation: undefined,
      ...(invalidated
        ? {
            configurationSnapshot: undefined,
            sourceSnapshot: undefined,
            sourceProfiles: undefined,
            sourceOrigins: undefined,
            sourceForm: undefined,
            moduleRevisionStale: !!state.modules,
            needsRecovery: raw.status === 'uncertain'
          }
        : {}),
      notice:
        raw.status === 'uncertain'
          ? '来源保存回执不确定；未保存模块文本仍保留，请先显式核对磁盘再恢复编辑。'
          : invalidated
            ? '来源或文件版本已变化，未保存模块文本仍保留；请显式重新读取后核对。读取不会自动更新pin。'
            : '本次来源操作未完成，未确认任何绑定变更。'
    })
    return undefined
  }
  const mutateSource = (request: RelaySimpleSourceMutation): Promise<void> => {
    const before = state.sourceSnapshot,
      adapter = adapters.sources
    if (!adapter || !before || state.needsRecovery || request.expectedRevision !== before.revision)
      return Promise.resolve()
    return run(async (ticket) => {
      publish({ ...state, preview: undefined, preparation: undefined })
      const raw = await adapter.relaySimpleSaveSourceBinding(request)
      if (!live(ticket)) return
      const saved = sourceReply(raw)
      if (!saved) return
      verifySourceReceipt(before, saved, request)
      const moduleMatches = !state.modules || state.metadata?.revision === before.revision
      publish({
        ...state,
        sourceSnapshot: saved,
        configurationSnapshot: advanceConfiguration(sourceMetadata(saved), before.revision),
        sourceForm: undefined,
        preview: undefined,
        preparation: undefined,
        metadata: moduleMatches ? sourceMetadata(saved) : state.metadata,
        moduleRevisionStale: !moduleMatches,
        notice: moduleMatches
          ? '已保存来源草稿绑定；模块正文及未保存文本已保留。请显式预览，尚未发布或启用。'
          : '来源绑定已保存，未保存模块文本仍保留；模块基于其它文件版本，保存或预览前请显式重新读取。'
      })
    })
  }
  const publicationFailure = (readOnly = false): void => {
    publish({
      ...state,
      publicationPreparation: undefined,
      publicationResult: undefined,
      publicationState: undefined,
      publicationNeedsInspection: true,
      publicationReadInvalid: readOnly,
      moduleRevisionStale: !!state.modules,
      preview: undefined,
      preparation: undefined,
      configurationSnapshot: undefined,
      sourceSnapshot: undefined,
      sourceForm: undefined,
      sourceProfiles: undefined,
      sourceOrigins: undefined,
      notice: readOnly
        ? '发布摘要未确认，保留磁盘现场并阻止写入。请显式查看状态或只读核对；此处没有回显原文诊断。'
        : '发布结果尚需核对。文本保留，磁盘可能已有副本或提交；不会声称回滚或自动重试。请显式查看发布状态。'
    })
  }
  const publicationReply = <T>(raw: unknown, read: (value: unknown) => T): T | undefined => {
    try {
      if (!object(raw)) throw new Error('Malformed publication reply')
      if (raw.status === 'ok') return read(raw.value)
      if (!codes.includes(raw.status as RelaySimpleCode))
        throw new Error('Malformed publication status')
      publicationFailure(raw.status === 'invalid')
      return undefined
    } catch {
      publicationFailure(true)
      return undefined
    }
  }
  const recordPublicationFailure = (value: RelaySimplePublicationResult): void => {
    publicationFailure(false)
    publish({
      ...state,
      publicationResult: value,
      notice:
        value.status === 'uncertain'
          ? '发布结果不确定，保留全部现场和副本。请显式只读核对，未确认回滚或发布失败。'
          : value.status === 'cancelled'
            ? '发布确认已取消。磁盘副本或提交需显式核对；不会自动回滚或重试。'
            : '发布未完成或回执未确认。全部现场和副本保留，请显式核对。'
    })
  }
  const acceptPublished = (
    value: RelaySimplePublicationResult,
    ticket: PublicationTicket
  ): void => {
    verifyPublishedResult(value, ticket)
    const matches =
        state.metadata?.revision === ticket.expectedRevision &&
        state.metadata.publishedRevision === ticket.expectedPublishedRevision,
      info =
        matches && state.metadata
          ? {
              ...state.metadata,
              exists: true,
              revision: value.revision as string,
              publishedRevision: value.publishedRevision as number,
              dirty: false
            }
          : undefined
    publish({
      ...state,
      publicationPreparation: undefined,
      publicationResult: value,
      publicationState: undefined,
      publicationReadInvalid: false,
      publicationNeedsInspection: value.needsRecovery,
      metadata: info ?? state.metadata,
      sourceSnapshot:
        info && state.sourceSnapshot?.revision === ticket.expectedRevision
          ? { ...state.sourceSnapshot, ...info, sources: state.sourceSnapshot.sources }
          : undefined,
      configurationSnapshot:
        info && state.configurationSnapshot?.revision === ticket.expectedRevision
          ? {
              ...state.configurationSnapshot,
              exists: info.exists,
              revision: info.revision,
              dirty: info.dirty,
              publishedRevision: info.publishedRevision,
              sharedConfigurationPinned: info.sharedConfigurationPinned
            }
          : undefined,
      preview: undefined,
      preparation: undefined,
      moduleRevisionStale: !matches,
      notice: value.needsRecovery
        ? '已确认发布固定版本，但发布记录收尾尚需核对；副本未启用，新写入保持阻止。请显式只读核对或收尾。'
        : matches
          ? '已发布固定版本并保留独立副本；没有选用或启用配置。请显式查看发布状态或重新预览后继续。'
          : '已确认发布固定版本；本编辑器基线不同，文本保留。请显式重新读取后继续，没有自动选用配置。'
    })
  }
  const clean = (): boolean =>
    !!state.modules && !state.moduleRevisionStale && !hasUnsavedModules(state)
  return {
    getSnapshot: (): SimplePanelState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    invalidate,
    activate(): void {
      active = true
    },
    deactivate(): void {
      active = false
      invalidate()
    },
    readPublicationState: (): Promise<void> => {
      const adapter = adapters.publication
      if (!adapter) return Promise.resolve()
      return run(async (ticket) => {
        try {
          const raw = await adapter.relaySimplePublicationState()
          if (!live(ticket)) return
          const value = publicationReply(raw, readPublicationState)
          if (value)
            publish({
              ...state,
              publicationState: value,
              publicationReadInvalid: false,
              publicationNeedsInspection: false,
              notice: '已显式查看发布摘要；不代表自动恢复或重新读取草稿正文。'
            })
        } catch {
          if (live(ticket)) publicationFailure(true)
        }
      }, true)
    },
    recoverPublication: (): Promise<void> => {
      const adapter = adapters.publication
      if (!adapter) return Promise.resolve()
      return run(async (ticket) => {
        try {
          const raw = await adapter.relaySimplePublicationRecover()
          if (!live(ticket)) return
          const value = publicationReply(raw, readPublicationState)
          if (value)
            publish({
              ...state,
              publicationState: value,
              publicationReadInvalid: false,
              publicationNeedsInspection: false,
              notice:
                '已完成本次显式只读核对。草稿与模块正文没有自动重读，未决意图须按摘要另行处理。'
            })
        } catch {
          if (live(ticket)) publicationFailure(true)
        }
      }, true)
    },
    preparePublication: (publishNow = false): Promise<void> => {
      const adapter = adapters.publication,
        info = state.metadata,
        checked = state.preview,
        pub = state.publicationState
      if (
        !adapter ||
        !info ||
        !checked?.valid ||
        !clean() ||
        state.needsRecovery ||
        state.sourceForm ||
        !state.name.trim() ||
        !pub?.initialized ||
        publicationStateBlocks(pub) ||
        state.publicationReadInvalid ||
        state.publicationNeedsInspection
      )
        return Promise.resolve()
      const name = state.name.trim()
      return run(async (ticket) => {
        try {
          const raw = await adapter.relaySimplePublicationPrepare({
            expectedRevision: info.revision,
            previewSHA256: checked.yamlSHA256,
            name
          })
          if (!live(ticket)) return
          const value = publicationReply(raw, (input) =>
            readPublicationPreparation(input, info, checked.yamlSHA256, checked.bytes, preparation)
          )
          if (value && publishNow) {
            publish({ ...state, publicationNeedsInspection: true, preview: undefined })
            const completed = await adapter.relaySimplePublicationConfirm({
              evidenceId: value.preparation.evidenceId
            })
            if (!live(ticket)) return
            const outcome = publicationReply(completed, (input) =>
              readPublicationResult(input, value.operationId)
            )
            if (!outcome) return
            if (outcome.status === 'published') acceptPublished(outcome, value)
            else if (outcome.status === 'abandoned') publicationFailure(true)
            else recordPublicationFailure(outcome)
          } else if (value)
            publish({
              ...state,
              publicationPreparation: value,
              publicationResult: undefined,
              notice: '发布副本已准备。仍需单独确认发布；不会交给另存副本按钮或自动选用。'
            })
        } catch {
          if (live(ticket)) publicationFailure(true)
        }
      })
    },
    confirmPublication: (): Promise<void> => {
      const adapter = adapters.publication,
        current = state.publicationPreparation
      if (
        !adapter ||
        !current ||
        !clean() ||
        state.sourceForm ||
        state.needsRecovery ||
        isPublicationBlocking(state)
      )
        return Promise.resolve()
      return run(async (ticket) => {
        publish({
          ...state,
          publicationNeedsInspection: true,
          preview: undefined,
          preparation: undefined
        })
        try {
          const raw = await adapter.relaySimplePublicationConfirm({
            evidenceId: current.preparation.evidenceId
          })
          if (!live(ticket)) return
          const value = publicationReply(raw, (input) =>
            readPublicationResult(input, current.operationId)
          )
          if (!value) return
          if (value.status === 'published') acceptPublished(value, current)
          else if (value.status === 'abandoned') publicationFailure(true)
          else recordPublicationFailure(value)
        } catch {
          if (live(ticket)) publicationFailure(true)
        }
      })
    },
    abandonPublication: (): Promise<void> => {
      const adapter = adapters.publication,
        before = state.publicationState
      if (!adapter || !mayAbandonPublication(before) || !before?.operationId)
        return Promise.resolve()
      const operationId = before.operationId
      return run(async (ticket) => {
        publish({
          ...state,
          publicationNeedsInspection: true,
          preview: undefined,
          preparation: undefined
        })
        try {
          const raw = await adapter.relaySimplePublicationAbandon({
            operationId,
            expectedMarkerRevision: before.markerRevision
          })
          if (!live(ticket)) return
          const value = publicationReply(raw, (input) => readPublicationResult(input, operationId))
          if (!value) return
          if (value.status === 'published') {
            if (
              !before.profile ||
              !value.profile ||
              value.profile?.sha256 !== before.profile?.sha256 ||
              value.profile?.id !== before.profile?.id ||
              !publicationDigest(value.revision) ||
              !Number.isSafeInteger(value.publishedRevision) ||
              Number(value.publishedRevision) <= 0
            ) {
              publicationFailure(true)
              return
            }
            publish({
              ...state,
              publicationResult: value,
              publicationState: undefined,
              publicationNeedsInspection: value.needsRecovery,
              publicationReadInvalid: false,
              moduleRevisionStale: !!state.modules,
              configurationSnapshot: undefined,
              sourceSnapshot: undefined,
              sourceForm: undefined,
              notice: value.needsRecovery
                ? '已确认此前发布完成，记录仍需继续核对收尾；没有回滚已保存副本。'
                : '已核对并收尾此前完成的发布；不是放弃或回滚。请显式重新读取草稿，副本没有自动启用。'
            })
          } else if (value.status === 'abandoned' && !value.needsRecovery) {
            publish({
              ...state,
              publicationResult: value,
              publicationState: undefined,
              publicationNeedsInspection: false,
              publicationReadInvalid: false,
              moduleRevisionStale: !!state.modules,
              configurationSnapshot: undefined,
              sourceSnapshot: undefined,
              sourceForm: undefined,
              notice:
                '已明确放弃未完成发布意图；全部配置副本与旧历史内容保留，不表示回滚。请显式读取草稿。'
            })
          } else recordPublicationFailure(value)
        } catch {
          if (live(ticket)) publicationFailure(true)
        }
      }, true)
    },
    readConfigurationBinding: (): Promise<void> => {
      const adapter = adapters.configuration
      if (!adapter || state.needsRecovery) return Promise.resolve()
      return run(async (ticket) => {
        publish({
          ...state,
          configurationSnapshot: undefined,
          preview: undefined,
          preparation: undefined
        })
        const raw = await adapter.relaySimpleReadConfigurationBinding()
        if (!live(ticket)) return
        const snapshot = configurationReply(raw, readConfigurationSnapshot)
        if (!snapshot) return
        const matches = !state.modules || state.metadata?.revision === snapshot.revision,
          sourceMatches = state.sourceSnapshot?.revision === snapshot.revision
        publish({
          ...state,
          configurationSnapshot: snapshot,
          moduleRevisionStale: !matches,
          ...(sourceMatches
            ? {}
            : {
                sourceSnapshot: undefined,
                sourceForm: undefined,
                sourceProfiles: undefined,
                sourceOrigins: undefined
              }),
          notice: matches
            ? '已查看共享配置版本；采用或解除都需要明确操作，不会自动更新绑定。'
            : '共享绑定文件版本与模块基线不同；未保存文本仍保留，请显式重新读取模块后再保存或预览。'
        })
      })
    },
    bindViewedConfiguration: (): Promise<void> => {
      const candidate = state.configurationSnapshot?.candidate
      return candidate?.status === 'available'
        ? saveConfiguration(candidate.configurationRevision)
        : Promise.resolve()
    },
    unbindConfiguration: (): Promise<void> => saveConfiguration(''),
    readSources: (): Promise<void> => {
      const adapter = adapters.sources
      if (!adapter || state.needsRecovery) return Promise.resolve()
      return run(async (ticket) => {
        publish({
          ...state,
          sourceSnapshot: undefined,
          sourceProfiles: undefined,
          sourceOrigins: undefined,
          sourceForm: undefined,
          preview: undefined,
          preparation: undefined
        })
        const raw = await adapter.relaySimpleReadSourceBindings()
        if (!live(ticket)) return
        const snapshot = sourceReply(raw)
        if (!snapshot) return
        const moduleMatches = !state.modules || state.metadata?.revision === snapshot.revision
        publish({ ...state, moduleRevisionStale: !moduleMatches })
        const rawProfiles = await adapter.listProfiles()
        if (!live(ticket)) return
        const profiles = parseProfileChoices(rawProfiles)
        const rawOrigins = await adapter.listSources()
        if (!live(ticket)) return
        const origins = parseOriginChoices(rawOrigins)
        publish({
          ...state,
          sourceSnapshot: snapshot,
          configurationSnapshot:
            state.configurationSnapshot?.revision === snapshot.revision
              ? state.configurationSnapshot
              : undefined,
          sourceProfiles: profiles,
          sourceOrigins: origins,
          metadata: state.modules ? state.metadata : sourceMetadata(snapshot),
          moduleRevisionStale: !moduleMatches,
          notice: moduleMatches
            ? (object(rawProfiles) && Number(rawProfiles.incomplete) > 0) ||
              (object(rawOrigins) && Number(rawOrigins.incomplete) > 0)
              ? '库存有未完整复核条目；只允许明确选择已列的固定候选，不会自动补齐或选择最新版本。'
              : '已显式读取来源和版本候选。请选择精确profile/SHA及可选来源修订；不会默认选择最新版本。'
            : '来源文件版本与模块基线不同，未保存文本仍保留；模块保存及预览已暂停，请显式重新读取。'
        })
      })
    },
    newSource(): void {
      if (operation || !state.sourceSnapshot || state.needsRecovery) return
      publish({ ...state, sourceForm: sourceForm(), preparation: undefined })
    },
    editSource(bindingId: string): void {
      if (operation || !state.sourceSnapshot || state.needsRecovery) return
      const row = state.sourceSnapshot.sources.find((item) => item.bindingId === bindingId)
      if (!row?.editable) return
      publish({ ...state, sourceForm: sourceForm(row), preparation: undefined })
    },
    updateSourceForm(patch: Partial<SimpleSourceForm>): void {
      if (operation || !state.sourceForm) return
      publish({ ...state, sourceForm: { ...state.sourceForm, ...patch }, preparation: undefined })
    },
    chooseSourceProfile(key: string): void {
      if (operation || !state.sourceForm) return
      const choices = [
        ...(state.sourceProfiles ?? []),
        ...(state.sourceOrigins ?? []).flatMap((origin) =>
          origin.versions.map((version) => ({ ...version.profile, name: '' }))
        ),
        ...(state.sourceSnapshot?.sources ?? []).map((row) => ({ ...row.profile, name: '' }))
      ]
      const profile = choices.find((choice) => choice.id + ':' + choice.sha256 === key)
      if (!profile) return
      publish({
        ...state,
        sourceForm: {
          ...state.sourceForm,
          profile: { id: profile.id, sha256: profile.sha256 },
          selectedVersionId: undefined
        },
        preparation: undefined
      })
    },
    chooseSourceOrigin(key: string): void {
      if (operation || !state.sourceForm) return
      const selected = (state.sourceOrigins ?? []).find(
        (origin) => origin.id + ':' + origin.revision === key && !origin.locked
      )
      if (key && !selected) return
      publish({
        ...state,
        sourceForm: {
          ...state.sourceForm,
          source: selected ? { id: selected.id, revision: selected.revision } : null,
          selectedVersionId: undefined
        },
        preparation: undefined
      })
    },
    chooseSourceVersion(versionId: string): void {
      if (operation || !state.sourceForm?.source) return
      const selected = state.sourceForm.source,
        origin = state.sourceOrigins?.find(
          (origin) =>
            origin.id === selected.id && origin.revision === selected.revision && !origin.locked
        ),
        version = origin?.versions.find((version) => version.id === versionId)
      if (!version) return
      publish({
        ...state,
        sourceForm: {
          ...state.sourceForm,
          profile: { ...version.profile },
          selectedVersionId: version.id
        },
        preparation: undefined
      })
    },
    cancelSourceForm(): void {
      if (operation) return
      publish({ ...state, sourceForm: undefined })
    },
    saveSource: (): Promise<void> => {
      const snapshot = state.sourceSnapshot,
        form = state.sourceForm
      if (!snapshot || !form || state.needsRecovery) return Promise.resolve()
      try {
        const value = sourceFormValue(
          form,
          snapshot,
          state.sourceProfiles ?? [],
          state.sourceOrigins ?? []
        )
        return mutateSource(
          form.bindingId
            ? {
                action: 'replace',
                expectedRevision: snapshot.revision,
                bindingId: form.bindingId,
                value
              }
            : { action: 'add', expectedRevision: snapshot.revision, value }
        )
      } catch {
        publish({
          ...state,
          notice:
            '来源选项未通过检查。请明确选择profile及来源版本，清除当前模式不支持的集合选项；没有发送保存请求。'
        })
        return Promise.resolve()
      }
    },
    removeSource: (bindingId: string): Promise<void> => {
      const snapshot = state.sourceSnapshot
      if (!snapshot?.sources.some((row) => row.bindingId === bindingId) || state.needsRecovery)
        return Promise.resolve()
      return mutateSource({ action: 'remove', expectedRevision: snapshot.revision, bindingId })
    },
    selectModule(module: SimpleModule): void {
      if (operation || !Object.hasOwn(SIMPLE_MODULES, module)) return
      publish({ ...state, module, preview: undefined, preparation: undefined })
    },
    setText(value: string): void {
      if (operation || !state.modules) return
      publish({
        ...state,
        modules: { ...state.modules, [state.module]: value },
        preview: undefined,
        preparation: undefined
      })
    },
    setName(name: string): void {
      if (operation) return
      publish({ ...state, name, preparation: undefined })
    },
    read: (): Promise<void> => {
      if (state.needsRecovery) return Promise.resolve()
      return run(async (ticket) => {
        const raw = await adapters.api.relaySimpleReadEditableDraft()
        if (!live(ticket)) return
        const value = result(raw, editable)
        if (!value) return
        const { modules, ...info } = value
        publish({
          ...state,
          metadata: info,
          modules: { ...modules },
          savedModules: { ...modules },
          moduleRevisionStale: false,
          configurationSnapshot:
            state.configurationSnapshot?.revision === info.revision
              ? state.configurationSnapshot
              : undefined,
          ...(state.sourceSnapshot?.revision !== info.revision
            ? {
                sourceSnapshot: undefined,
                sourceForm: undefined,
                sourceProfiles: undefined,
                sourceOrigins: undefined
              }
            : {}),
          preview: undefined,
          needsRecovery: false,
          notice: '已显式读取草稿；模块正文可能含密码，请在本编辑器内处理。'
        })
      })
    },
    saveModule: (): Promise<void> => {
      const { metadata: info, modules, savedModules, module } = state
      if (
        state.moduleRevisionStale ||
        state.needsRecovery ||
        !info ||
        !modules ||
        !savedModules ||
        modules[module] === savedModules[module]
      )
        return Promise.resolve()
      const value = modules[module]
      if (new TextEncoder().encode(value).length > 128 * 1024) {
        publish({ ...state, notice: '当前模块超过128KiB，未发送保存请求。' })
        return Promise.resolve()
      }
      return run(async (ticket) => {
        const raw = await adapters.api.relaySimpleSaveModule({
          expectedRevision: info.revision,
          module,
          text: value
        })
        if (!live(ticket)) return
        const saved = result(raw, metadata)
        if (!saved) return
        if (
          !saved.exists ||
          saved.revision === info.revision ||
          saved.publishedRevision !== info.publishedRevision
        )
          throw new Error('Malformed module save receipt')
        publish({
          ...state,
          metadata: saved,
          savedModules: { ...savedModules, [module]: value },
          configurationSnapshot: advanceConfiguration(saved, info.revision),
          sourceSnapshot:
            state.sourceSnapshot?.revision === info.revision &&
            JSON.stringify(sourceMetadata(state.sourceSnapshot).sources) ===
              JSON.stringify(saved.sources)
              ? { ...state.sourceSnapshot, ...saved, sources: state.sourceSnapshot.sources }
              : undefined,
          preview: undefined,
          notice: '已保存当前模块草稿。请预览已保存版本后另存配置副本。'
        })
      })
    },
    preview: (): Promise<void> => {
      if (!state.metadata || !clean() || state.needsRecovery) return Promise.resolve()
      const revision = state.metadata.revision
      return run(async (ticket) => {
        const raw = await adapters.api.relaySimplePreview(revision)
        if (!live(ticket)) return
        const value = result(raw, preview)
        if (!value) return
        publish({
          ...state,
          preview: value,
          notice: value.valid
            ? '结构预览通过，核心兼容性未知。尚未另存或启用配置。'
            : '结构预览未通过，请检查已保存的模块草稿。'
        })
      })
    },
    prepareProfile: (saveNow = false): Promise<void> => {
      const { metadata: info, preview: checked, name } = state
      if (!info || !checked?.valid || !clean() || state.needsRecovery) return Promise.resolve()
      return run(async (ticket) => {
        const raw = await adapters.api.relaySimplePrepareProfile({
          expectedRevision: info.revision,
          previewSHA256: checked.yamlSHA256,
          name: name.trim()
        })
        if (!live(ticket)) return
        const value = result(raw, (input) => preparation(input, checked.yamlSHA256, checked.bytes))
        if (!value) return
        if (!saveNow) {
          publish({ ...state, preparation: value, notice: '副本检查通过。' })
          return
        }
        const saved: unknown = await adapters.saveProfile({ evidenceId: value.evidenceId })
        if (!live(ticket)) return
        if (!object(saved) || !strings(saved.warnings)) throw new Error('Malformed save receipt')
        if (saved.status === 'saved') {
          if (!object(saved.profile) || saved.profile.sha256 !== value.sha256)
            throw new Error('Malformed saved profile')
          publish({ ...state, notice: '已另存独立配置副本，未启用配置。' })
        } else if (['cancelled', 'uncertain', 'failed'].includes(String(saved.status))) {
          publish({ ...state, notice: '另存未完成，请读取配置列表核对；不会自动重试。' })
        } else throw new Error('Malformed save status')
      })
    },
    confirmSave: (): Promise<void> => {
      const current = state.preparation
      if (!current || !clean()) return Promise.resolve()
      return run(async (ticket) => {
        const raw: unknown = await adapters.saveProfile({ evidenceId: current.evidenceId })
        if (!live(ticket)) return
        if (!object(raw) || !strings(raw.warnings)) throw new Error('Malformed save receipt')
        let notice: string
        if (raw.status === 'saved') {
          if (
            !object(raw.profile) ||
            !text(raw.profile.name, 256) ||
            raw.profile.sha256 !== current.sha256
          )
            throw new Error('Malformed saved profile')
          notice = '已另存独立配置副本。没有启用配置或推进Simple历史版本。'
        } else if (raw.status === 'cancelled') notice = '已取消另存。再次保存需要重新准备。'
        else if (raw.status === 'uncertain')
          notice = '另存回执不确定，请读取配置列表核对；不会自动重试。'
        else if (raw.status === 'failed') notice = '另存未完成，请检查配置列表后重新准备。'
        else throw new Error('Malformed save status')
        publish({ ...state, notice })
      })
    },
    recover: (): Promise<void> => {
      if (!state.needsRecovery) return Promise.resolve()
      return run(async (ticket) => {
        const raw = await adapters.api.relaySimpleRecover()
        if (!live(ticket)) return
        const value = result(raw, metadata)
        if (!value) return
        publish({
          ...reset(),
          pending: true,
          metadata: value,
          notice: '磁盘草稿核对完成，请显式读取模块。此操作没有重新绑定来源或共享配置。'
        })
      })
    }
  }
}

export type SimplePanelController = ReturnType<typeof createSimplePanelController>
