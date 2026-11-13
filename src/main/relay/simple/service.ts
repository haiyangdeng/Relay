import type {
  RelaySimpleConfigurationMetadata,
  RelaySimpleConfigurationSnapshot
} from '../../../shared/relay/simple-configuration'
import type { RelaySimpleSourcesSnapshot } from '../../../shared/relay/simple-sources'
import { SIMPLE_MODULES, type SimpleModule } from '../../../shared/simple-config'
import { stripProfileControls } from '../../../shared/relay/profiles'
import type { ProfileSource } from '../profiles/source'
import type {
  RelaySimpleEditableDraft,
  RelaySimpleMetadata,
  RelaySimpleModuleSave,
  RelaySimpleProfileRequest
} from '../../../shared/relay/simple'
import {
  configurationBindingMetadata,
  configurationBindingSave,
  type createPinnedSimpleConfigurationReader
} from './configuration'
import {
  applySourceBinding,
  newSimpleBindingId,
  sourceBindingsView,
  sourceMutation,
  type AdmittedSimpleBinding,
  type createPinnedSimpleBindingReader
} from './bindings'
import {
  boundedJSON,
  clone,
  hash,
  keys,
  SIMPLE_MODULE_BYTES,
  publicView,
  revision,
  saveRequest,
  SimpleFailure,
  type SimpleRecord,
  type SimplePublicView
} from './model'
import {
  compileSnapshot,
  publicPreview,
  snapshotInputs,
  type CapturedInputs,
  type PublicPreview
} from './resolver'
import type { SimpleDraftStore } from './store'
import { nodeUpdateRequest, readNodeDraft, sameNameNodeUpdate } from './crud'

const moduleSaveRequest = (value: unknown): RelaySimpleModuleSave => {
  boundedJSON(value)
  keys(value, ['expectedRevision', 'module', 'text'])
  revision(value.expectedRevision)
  const isModule = (v: unknown): v is SimpleModule =>
    typeof v === 'string' && Object.hasOwn(SIMPLE_MODULES, v)
  if (
    !isModule(value.module) ||
    typeof value.text !== 'string' ||
    Buffer.byteLength(value.text) > SIMPLE_MODULE_BYTES
  )
    throw new SimpleFailure('invalid')
  return { expectedRevision: value.expectedRevision, module: value.module, text: value.text }
}
const profileRequest = (value: unknown): RelaySimpleProfileRequest => {
  boundedJSON(value)
  keys(value, ['expectedRevision', 'previewSHA256', 'name'])
  revision(value.expectedRevision)
  if (
    typeof value.previewSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.previewSHA256) ||
    typeof value.name !== 'string' ||
    stripProfileControls(value.name) !== value.name
  )
    throw new SimpleFailure('invalid')
  const name = value.name.trim()
  if (!name || name.length > 108 || /[\\/]/u.test(name) || ['.', '..'].includes(name))
    throw new SimpleFailure('invalid')
  return { expectedRevision: value.expectedRevision, previewSHA256: value.previewSHA256, name }
}
const metadata = (record: SimpleRecord): RelaySimpleMetadata => ({
  ...publicView(record),
  sharedConfigurationPinned: record.document.configurationRevision.draft !== '',
  sources: record.document.state.draft.sources.map(({ id, name, mode }) => ({ id, name, mode }))
})

export interface SimpleOwner {
  isCurrent(): boolean
}
export function createSimpleDraftService(adapters: {
  store: Pick<SimpleDraftStore, 'read' | 'saveDraft'>
  capture(record: SimpleRecord, signal: AbortSignal): Promise<CapturedInputs>
  bindingReader?: ReturnType<typeof createPinnedSimpleBindingReader>
  configurationReader?: ReturnType<typeof createPinnedSimpleConfigurationReader>
}) {
  let epoch = 0,
    closing = false,
    uncertain = false,
    restoring = false
  let operation: { abort: AbortController; epoch: number; owner: SimpleOwner } | undefined
  const waiters: (() => void)[] = []
  const operationWaiters: (() => void)[] = []
  const notifyIdle = (): void => {
    if (!operation && !restoring) waiters.splice(0).forEach((resolve) => resolve())
  }
  const current = (): void => {
    let live = false
    try {
      live = !!operation?.owner.isCurrent()
    } catch {
      /* revoke */
    }
    if (
      !operation ||
      operation.abort.signal.aborted ||
      operation.epoch !== epoch ||
      closing ||
      !live
    )
      throw new SimpleFailure('cancelled')
  }
  const begin = (owner: SimpleOwner): void => {
    if (restoring) throw new SimpleFailure('busy')
    if (closing) throw new SimpleFailure('closed')
    if (uncertain) throw new SimpleFailure('uncertain')
    if (operation) throw new SimpleFailure('busy')
    operation = { abort: new AbortController(), epoch, owner }
    try {
      current()
    } catch (error) {
      operation = undefined
      throw error
    }
  }
  const end = (): void => {
    operation = undefined
    operationWaiters.splice(0).forEach((resolve) => resolve())
    notifyIdle()
  }
  const clear = (): void => {
    ++epoch
    operation?.abort.abort()
  }
  const whenIdle = (): Promise<void> =>
    operation || restoring ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const assertOwner = (owner: SimpleOwner): void => {
    let live = false
    try {
      live = owner.isCurrent()
    } catch {
      /* revoke */
    }
    if (!live) throw new SimpleFailure('cancelled')
  }
  // One restore gate for backup afterRestore and explicit trusted-owner recover.
  const restore = async <T>(
    project: (record: SimpleRecord) => T,
    owner?: SimpleOwner
  ): Promise<T> => {
    if (owner) assertOwner(owner)
    if (restoring) throw new SimpleFailure('busy')
    closing = true
    clear()
    restoring = true
    const restoreEpoch = epoch
    const freshRestore = (): void => {
      if (restoreEpoch !== epoch) throw new SimpleFailure('cancelled')
      if (owner) assertOwner(owner)
    }
    try {
      if (operation) await new Promise<void>((resolve) => operationWaiters.push(resolve))
      freshRestore()
      const value = await adapters.store.read()
      freshRestore()
      const view = project(value)
      freshRestore()
      uncertain = false
      closing = false
      return view
    } catch (error) {
      if (!(error instanceof SimpleFailure && error.code === 'cancelled')) uncertain = true
      throw error
    } finally {
      restoring = false
      notifyIdle()
    }
  }
  return {
    isBusy: (): boolean => !!operation || restoring,
    state: () => ({ pending: !!operation || restoring, restoring, closing, uncertain, epoch }),
    whenIdle,
    clear,
    async requestClose(): Promise<void> {
      closing = true
      clear()
      await whenIdle()
    },
    // Main must explicitly call this after a cancelled quit; no old owner resumes.
    reopen(): void {
      if (operation || restoring) throw new SimpleFailure('busy')
      ++epoch
      closing = false
    },
    afterRestore(): Promise<SimplePublicView> {
      return restore(publicView)
    },
    // Main provides a newly trusted owner; successful reread returns no modules.
    async recover(owner: SimpleOwner): Promise<RelaySimpleMetadata> {
      try {
        return await restore(metadata, owner)
      } catch (error) {
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      }
    },
    async readEditableDraft(owner: SimpleOwner): Promise<RelaySimpleEditableDraft> {
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        const view = { ...metadata(record), modules: clone(record.document.state.draft.modules) }
        current()
        return view
      } catch (error) {
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    async readConfigurationBinding(owner: SimpleOwner): Promise<RelaySimpleConfigurationSnapshot> {
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        let candidate: RelaySimpleConfigurationSnapshot['candidate'] = { status: 'unavailable' }
        if (adapters.configurationReader && operation) {
          try {
            const inspected = await adapters.configurationReader.inspectCurrent(
              operation.abort.signal,
              current
            )
            current()
            candidate = inspected
              ? {
                  status: 'available',
                  configurationRevision: inspected.revision,
                  keys: (['dns', 'hosts', 'sniffer', 'geodata-mode'] as const).filter((key) =>
                    Object.hasOwn(inspected.shared, key)
                  )
                }
              : { status: 'missing' }
          } catch (error) {
            current()
            if (!(error instanceof SimpleFailure && ['invalid', 'stale'].includes(error.code)))
              throw error
          }
        }
        current()
        return { ...configurationBindingMetadata(record), candidate }
      } catch (error) {
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    async saveConfigurationBinding(
      raw: unknown,
      owner: SimpleOwner
    ): Promise<RelaySimpleConfigurationMetadata> {
      const request = configurationBindingSave(raw)
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        if (record.revision !== request.expectedRevision) throw new SimpleFailure('stale')
        if (request.configurationRevision) {
          if (!adapters.configurationReader || !operation) throw new SimpleFailure('invalid')
          await adapters.configurationReader.readPinned(
            request.configurationRevision,
            operation.abort.signal,
            current
          )
          current()
          await adapters.configurationReader.readPinned(
            request.configurationRevision,
            operation.abort.signal,
            current
          )
          current()
        }
        if (record.document.configurationRevision.draft === request.configurationRevision)
          return configurationBindingMetadata(record)
        const saved = await adapters.store.saveDraft(
          {
            expectedRevision: record.revision,
            draft: clone(record.document.state.draft),
            bindings: clone(record.document.bindings.draft),
            configurationRevision: request.configurationRevision
          },
          current
        )
        current()
        return configurationBindingMetadata(saved)
      } catch (error) {
        if (error instanceof SimpleFailure && error.code === 'uncertain') uncertain = true
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    async readSourceBindings(owner: SimpleOwner): Promise<RelaySimpleSourcesSnapshot> {
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        const view = sourceBindingsView(record)
        current()
        return view
      } catch (error) {
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    async saveSourceBinding(raw: unknown, owner: SimpleOwner): Promise<RelaySimpleSourcesSnapshot> {
      const request = sourceMutation(raw)
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        if (record.revision !== request.expectedRevision) throw new SimpleFailure('stale')
        let admitted: AdmittedSimpleBinding | undefined
        if (request.action !== 'remove') {
          if (!adapters.bindingReader || !operation) throw new SimpleFailure('invalid')
          if (
            request.action === 'replace' &&
            !sourceBindingsView(record).sources.find((row) => row.bindingId === request.bindingId)
              ?.editable
          )
            throw new SimpleFailure('invalid')
          const id = request.action === 'add' ? newSimpleBindingId() : request.bindingId
          admitted = await adapters.bindingReader(
            id,
            request.value,
            operation.abort.signal,
            current
          )
          current()
          await admitted.recheck()
          current()
        }
        const next = applySourceBinding(record, request, admitted)
        current()
        const saved = await adapters.store.saveDraft(next, current)
        current()
        return sourceBindingsView(saved)
      } catch (error) {
        if (error instanceof SimpleFailure && error.code === 'uncertain') uncertain = true
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    async saveModule(raw: unknown, owner: SimpleOwner): Promise<RelaySimpleMetadata> {
      const request = moduleSaveRequest(raw)
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        if (record.revision !== request.expectedRevision) throw new SimpleFailure('stale')
        const draft = clone(record.document.state.draft)
        draft.modules[request.module] = request.text
        current()
        const saved = await adapters.store.saveDraft(
          {
            expectedRevision: record.revision,
            draft,
            bindings: record.document.bindings.draft,
            configurationRevision: record.document.configurationRevision.draft
          },
          current
        )
        current()
        return metadata(saved)
      } catch (error) {
        if (error instanceof SimpleFailure && error.code === 'uncertain') uncertain = true
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    // Main-only frozen callable source; handlers pass it to ProfileService,
    // never serialize it or accept a source object from IPC.
    async prepareProfile(raw: unknown, owner: SimpleOwner): Promise<ProfileSource> {
      const request = profileRequest(raw)
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        if (record.revision !== request.expectedRevision) throw new SimpleFailure('stale')
        const active = operation
        if (!active) throw new SimpleFailure('cancelled')
        const captured = await adapters.capture(clone(record), active.abort.signal)
        current()
        if (typeof captured.recheck !== 'function') throw new SimpleFailure('invalid')
        const recheck = captured.recheck
        const immutable = snapshotInputs(captured)
        await recheck()
        current()
        const compiled = compileSnapshot(
          record.document.state.draft,
          record.document.bindings.draft,
          record.document.configurationRevision.draft,
          immutable
        )
        current()
        if (compiled.errors.length || hash(compiled.yaml) !== request.previewSHA256)
          throw new SimpleFailure(compiled.errors.length ? 'invalid' : 'stale')
        await recheck()
        current()
        if ((await adapters.store.read()).revision !== record.revision)
          throw new SimpleFailure('stale')
        current()
        const authorityEpoch = epoch,
          capturedSignal = active.abort.signal,
          text = compiled.yaml,
          textHash = request.previewSHA256
        const checkAuthority = (): void => {
          if (
            epoch !== authorityEpoch ||
            capturedSignal.aborted ||
            closing ||
            uncertain ||
            restoring
          )
            throw new SimpleFailure('cancelled')
          assertOwner(owner)
        }
        const assertCurrent = async (): Promise<void> => {
          checkAuthority()
          begin(owner)
          try {
            checkAuthority()
            const before = await adapters.store.read()
            current()
            checkAuthority()
            if (before.revision !== record.revision) throw new SimpleFailure('stale')
            await recheck()
            current()
            checkAuthority()
            if ((await adapters.store.read()).revision !== record.revision)
              throw new SimpleFailure('stale')
            current()
            checkAuthority()
          } catch (error) {
            throw error instanceof SimpleFailure ? error : new SimpleFailure('stale')
          } finally {
            end()
          }
        }
        return Object.freeze({
          name: request.name + '.yaml',
          text,
          assertCurrent,
          readAgain: async () => {
            await assertCurrent()
            if (hash(text) !== textHash) throw new SimpleFailure('stale')
            return text
          }
        })
      } catch (error) {
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    async read(owner: SimpleOwner): Promise<SimplePublicView> {
      begin(owner)
      try {
        const value = await adapters.store.read()
        current()
        return publicView(value)
      } finally {
        end()
      }
    },
    // Main/private editing view only; no public IPC admission is made here.
    async readNodes(owner: SimpleOwner) {
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        const nodes = readNodeDraft(record.document.state.draft)
        current()
        return { revision: record.revision, nodes }
      } catch (error) {
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    async updateNode(raw: unknown, owner: SimpleOwner): Promise<SimplePublicView> {
      const request = nodeUpdateRequest(raw)
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        if (record.revision !== request.expectedRevision) throw new SimpleFailure('stale')
        const draft = sameNameNodeUpdate(record.document.state.draft, request)
        current()
        const saved = await adapters.store.saveDraft(
          {
            expectedRevision: record.revision,
            draft,
            bindings: record.document.bindings.draft,
            configurationRevision: record.document.configurationRevision.draft
          },
          current
        )
        current()
        return publicView(saved)
      } catch (error) {
        if (error instanceof SimpleFailure && error.code === 'uncertain') uncertain = true
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end()
      }
    },
    async saveDraft(raw: unknown, owner: SimpleOwner): Promise<SimplePublicView> {
      const request = saveRequest(raw)
      begin(owner)
      try {
        const value = await adapters.store.saveDraft(request, current)
        current()
        return publicView(value)
      } catch (error) {
        if (error instanceof SimpleFailure && error.code === 'uncertain') uncertain = true
        throw error
      } finally {
        end()
      }
    },
    async preview(expectedRevision: unknown, owner: SimpleOwner): Promise<PublicPreview> {
      revision(expectedRevision)
      begin(owner)
      try {
        const record = await adapters.store.read()
        current()
        if (record.revision !== expectedRevision) throw new SimpleFailure('stale')
        const active = operation
        if (!active) throw new SimpleFailure('cancelled')
        const captured = await adapters.capture(clone(record), active.abort.signal)
        current()
        if (typeof captured.recheck !== 'function') throw new SimpleFailure('invalid')
        const immutable = snapshotInputs(captured)
        await captured.recheck()
        current()
        const result = compileSnapshot(
          record.document.state.draft,
          record.document.bindings.draft,
          record.document.configurationRevision.draft,
          immutable
        )
        current()
        await captured.recheck()
        current()
        if ((await adapters.store.read()).revision !== record.revision)
          throw new SimpleFailure('stale')
        current()
        return publicPreview(result)
      } finally {
        end()
      }
    }
  }
}
