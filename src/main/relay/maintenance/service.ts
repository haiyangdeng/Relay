import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { defaultUIPreferences, type RelayUIPreferences } from '../../../shared/relay/ui-preferences'
import {
  maintenanceAction,
  maintenanceID,
  maintenanceObject,
  type RelayMaintenancePlan,
  type RelayMaintenanceState,
  type RelayMaintenanceReset
} from '../../../shared/relay/maintenance'
import type { SimpleFileRecord } from '../simple/store'
import type { RelayMaintenanceStore } from './store'
export function createMaintenanceService(adapters: {
  store: RelayMaintenanceStore
  inspectPreferences(): Promise<SimpleFileRecord<RelayUIPreferences>>
  savePreferences(
    value: RelayUIPreferences,
    revision: string,
    assertCurrent: () => void
  ): Promise<{ revision: string }>
  assertIdle(): void
  confirm(plan: RelayMaintenancePlan): Promise<boolean>
  confirmReveal(): Promise<boolean>
  clearRendererCache(): Promise<void>
  revealHeapDirectory(path: string): Promise<void>
}) {
  let pending = false,
    phase: RelayMaintenanceState['phase'] = 'idle',
    controller: AbortController | undefined,
    generation = 0
  let proof: { plan: RelayMaintenancePlan; revision: string; fresh(): boolean } | undefined
  const waiters: (() => void)[] = []
  const assert = (signal: AbortSignal, context: () => void) => {
    if (signal.aborted) throw new Error('本次维护授权已取消。')
    context()
    adapters.assertIdle()
  }
  const begin = (next: RelayMaintenanceState['phase']) => {
    if (pending) throw new Error('本地维护操作尚未结束。')
    adapters.assertIdle()
    pending = true
    phase = next
    controller = new AbortController()
    return controller.signal
  }
  const end = () => {
    pending = false
    phase = 'idle'
    controller = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  return {
    isBusy: () => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    cancel() {
      ++generation
      proof = undefined
      controller?.abort()
    },
    async state(): Promise<RelayMaintenanceState> {
      return { pending, phase, reset: (await adapters.store.journal.read()).value }
    },
    async prepare(raw: unknown, context: () => void): Promise<RelayMaintenancePlan> {
      const action = maintenanceAction(raw),
        signal = begin('preparing')
      proof = undefined
      try {
        assert(signal, context)
        const record = await adapters.store.journal.read()
        assert(signal, context)
        const prefs = await adapters.inspectPreferences()
        assert(signal, context)
        if (
          action === 'reset-interface' &&
          record.value &&
          ['intent', 'uncertain'].includes(record.value.phase)
        )
          throw new Error('请先恢复或核实上次界面偏好事务。')
        if (action === 'restore-interface' && (!record.value || record.value.phase === 'restored'))
          throw new Error('没有可恢复的界面偏好事务。')
        const plan: RelayMaintenancePlan = {
          evidenceId: randomUUID(),
          action,
          expiresAt: Date.now() + 60000,
          backupId: action === 'restore-interface' ? (record.value?.id ?? null) : null
        }
        const wall = Date.now(),
          mono = performance.now(),
          stamp = generation
        let wallLast = wall,
          monoLast = mono,
          invalid = false
        proof = {
          plan,
          revision: prefs.revision,
          fresh: () => {
            const w = Date.now(),
              m = performance.now()
            if (
              ![w, m].every(Number.isFinite) ||
              w < wallLast ||
              m < monoLast ||
              w - wall >= 60000 ||
              m - mono >= 60000 ||
              generation !== stamp
            )
              invalid = true
            wallLast = w
            monoLast = m
            return !invalid
          }
        }
        return structuredClone(plan)
      } finally {
        end()
      }
    },
    async execute(raw: unknown, context: () => void): Promise<unknown> {
      const request = maintenanceObject(raw, ['evidenceId']),
        id = maintenanceID(request.evidenceId),
        prepared = proof
      proof = undefined
      if (!prepared || prepared.plan.evidenceId !== id || !prepared.fresh())
        throw new Error('请重新准备本地维护动作。')
      const signal = begin('confirming'),
        current = () => assert(signal, context)
      let intent: RelayMaintenanceReset | undefined, journalRevision: string | undefined
      try {
        current()
        if (!(await adapters.confirm(prepared.plan)) || signal.aborted)
          return { status: 'cancelled' }
        current()
        if (!prepared.fresh()) throw new Error('本地维护确认已过期。')
        phase = 'executing'
        if (prepared.plan.action === 'export-heap')
          return { status: 'exported', export: await adapters.store.exportHeap(current, signal) }
        if (prepared.plan.action === 'clear-renderer-cache') {
          await adapters.clearRendererCache()
          current()
          return { status: 'cleared' }
        }
        const journal = await adapters.store.journal.read()
        current()
        const prefs = await adapters.inspectPreferences()
        current()
        if (prefs.revision !== prepared.revision) throw new Error('界面偏好在确认期间已变化。')
        if (prepared.plan.action === 'reset-interface') {
          if (journal.value && ['intent', 'uncertain'].includes(journal.value.phase))
            throw new Error('有未核实的界面重置事务。')
          const backup = await adapters.store.backup(prefs.value, current)
          current()
          intent = {
            id: backup.id,
            phase: 'intent',
            beforeRevision: prefs.revision,
            beforeSHA256: backup.sha256,
            afterRevision: null
          }
          const saved = await adapters.store.journal.change(
            journal.revision,
            () => intent ?? null,
            current
          )
          journalRevision = saved.revision
          const updated = await adapters.savePreferences(
            defaultUIPreferences(),
            prefs.revision,
            current
          )
          current()
          const resetIntent = intent
          const complete = await adapters.store.journal.change(
            saved.revision,
            () => ({ ...resetIntent, phase: 'reset', afterRevision: updated.revision }),
            current
          )
          journalRevision = complete.revision
          return { status: 'reset', backupId: backup.id }
        }
        const record = journal.value
        if (!record || record.id !== prepared.plan.backupId) throw new Error('界面恢复事务已变化。')
        const original = await adapters.store.restoreValue(record)
        current()
        const known =
          record.afterRevision === prefs.revision ||
          record.beforeRevision === prefs.revision ||
          JSON.stringify(prefs.value) === JSON.stringify(defaultUIPreferences()) ||
          JSON.stringify(prefs.value) === JSON.stringify(original)
        if (!known) throw new Error('当前界面偏好含其他改动，保留备份，不覆盖。')
        intent = record
        journalRevision = journal.revision
        const restored = await adapters.savePreferences(original, prefs.revision, current)
        current()
        await adapters.store.journal.change(
          journal.revision,
          () => ({ ...record, phase: 'restored', afterRevision: restored.revision }),
          current
        )
        return { status: 'restored' }
      } catch (error) {
        if (intent && journalRevision) {
          const failedIntent = intent
          await adapters.store.journal
            .change(
              journalRevision,
              () => ({ ...failedIntent, phase: 'uncertain' }),
              () => {}
            )
            .catch(() => {})
        }
        throw error
      } finally {
        end()
      }
    },
    async revealHeap(context: () => void): Promise<void> {
      const signal = begin('confirming')
      try {
        assert(signal, context)
        if (!(await adapters.confirmReveal())) return
        assert(signal, context)
        if (!(await adapters.store.files.directory(adapters.store.heapRoot)))
          throw new Error('还没有堆快照目录。')
        assert(signal, context)
        await adapters.revealHeapDirectory(adapters.store.heapRoot)
      } finally {
        end()
      }
    }
  }
}
