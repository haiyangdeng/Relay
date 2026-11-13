import {
  geoOriginSelection,
  type GeoOriginInfo,
  type GeoOriginRecord,
  type GeoResourceKind
} from '../../../shared/relay/geo-origins'
import {
  geoScheduleArmRequest,
  type GeoScheduleArmResult,
  type GeoSchedulerState,
  type GeoScheduleTarget
} from '../../../shared/relay/geo-scheduler'
import type {
  SourceSchedule,
  SubscriptionSourceResult
} from '../../../shared/relay/subscription-sources'
import { createSourceScheduler, type SourceScheduleRecord } from '../subscriptions/source-scheduler'
import {
  issueGeoAutomaticPermit,
  revokeGeoAutomaticPermit,
  assertGeoAutomaticPermit,
  type GeoAutomaticPermit,
  type GeoAutomaticOwner
} from './automatic-permit'
import type { ResourceOriginStore } from './origin-store'

interface ScheduledRecord extends SourceScheduleRecord {
  info: GeoOriginInfo & { name: string; locked: false }
}
interface Arm {
  id: string
  epoch: number
  target: GeoScheduleTarget
  owner?: GeoAutomaticOwner
  permit?: GeoAutomaticPermit
  unsupported?: boolean
  assertUI(): void
}
export interface GeoScheduleConsent {
  origin: GeoOriginInfo
  schedule: SourceSchedule
  target: GeoScheduleTarget
  configurationRevision?: string
}
export function createGeoSourceScheduler(adapters: {
  origins: Pick<ResourceOriginStore, 'read' | 'readId'>
  canRun(): boolean
  owner(
    sessionId: string,
    kind: GeoResourceKind,
    assertUI: () => void
  ): Promise<GeoAutomaticOwner | undefined>
  confirm(plan: GeoScheduleConsent): Promise<boolean>
  run(
    record: GeoOriginRecord,
    permit: GeoAutomaticPermit,
    target: GeoScheduleTarget
  ): Promise<{
    status: 'updated' | 'unchanged' | 'cancelled' | 'failed' | 'uncertain'
    warnings: string[]
  }>
  requestStop(): Promise<void>
  now?(): number
}) {
  let arm: Arm | undefined,
    epoch = 0,
    closing = false
  const permits = new Map<string, GeoAutomaticPermit>(),
    owners = new Map<string, GeoAutomaticOwner>(),
    targets = new Map<string, GeoScheduleTarget>(),
    armWaiters: (() => void)[] = []
  const drainArm = (): Promise<void> =>
    arm ? new Promise((resolve) => armWaiters.push(resolve)) : Promise.resolve()
  const project = (record: GeoOriginRecord): ScheduledRecord => {
    if (!record.definition.autoIntent.requested)
      throw new Error('请先保存该来源的自动更新意图及周期。')
    return {
      info: { ...structuredClone(record.info), name: record.info.descriptor.name, locked: false },
      originRevision: record.info.originRevision,
      options: {
        useServerInterval: false,
        schedule: structuredClone(record.definition.autoIntent.schedule)
      }
    }
  }
  const live = (op: Arm): void => {
    op.assertUI()
    op.owner?.assertCurrent()
    if (arm !== op || epoch !== op.epoch || closing) throw new Error('本次地理调度授权范围已失效。')
  }
  const scheduler = createSourceScheduler<ScheduledRecord>({
    store: {
      read: async (selection) => project(await adapters.origins.read(selection)),
      readId: async (id) => project(await adapters.origins.readId(id))
    },
    canRun: () => !closing && !arm && adapters.canRun(),
    now: adapters.now,
    requestStop: adapters.requestStop,
    confirm: async (info, schedule) => {
      const op = arm
      if (!op || op.id !== info.id) return false
      live(op)
      if (op.target.kind === 'tun') {
        op.owner = await adapters.owner(op.target.sessionId, info.descriptor.kind, () => live(op))
        live(op)
        if (!op.owner || op.owner.sessionId !== op.target.sessionId) {
          op.unsupported = true
          return false
        }
      }
      const accepted = await adapters.confirm({
        origin: structuredClone(info),
        schedule: structuredClone(schedule),
        target: structuredClone(op.target),
        ...(op.owner ? { configurationRevision: op.owner.configurationRevision } : {})
      })
      live(op)
      if (!accepted) return false
      // The mature scheduler performs the final selected-record re-read after
      // consent. This token remains private and unusable until arm succeeds.
      op.permit = issueGeoAutomaticPermit(info, op.owner)
      return true
    },
    run: async (id, originRevision): Promise<SubscriptionSourceResult> => {
      const permit = permits.get(id)
      if (!permit || closing) throw new Error('地理调度没有有效的本次内存权限。')
      const record = await adapters.origins.readId(id)
      if (record.info.originRevision !== originRevision) throw new Error('地理来源已变化。')
      assertGeoAutomaticPermit(permit, record.info)
      const target = targets.get(id)
      if (!target) throw new Error('地理调度目标已失效。')
      const result = await adapters.run(record, permit, structuredClone(target))
      if (result.status === 'uncertain') {
        revokeGeoAutomaticPermit(permit)
        permits.delete(id)
        owners.delete(id)
        return { status: 'uncertain', warnings: result.warnings }
      }
      assertGeoAutomaticPermit(permit, record.info)
      return {
        status: result.status === 'updated' ? 'saved' : result.status,
        warnings: result.warnings
      }
    }
  })
  const state = (): GeoSchedulerState => {
    const snapshot = scheduler.state()
    for (const entry of snapshot.entries) {
      if (!entry.enabled) {
        const permit = permits.get(entry.id)
        if (permit) revokeGeoAutomaticPermit(permit)
        permits.delete(entry.id)
        owners.delete(entry.id)
      }
    }
    return {
      ...snapshot,
      pending: snapshot.pending || !!arm || closing,
      entries: snapshot.entries.flatMap((entry) => {
        const target = targets.get(entry.id)
        return target ? [{ ...entry, target: structuredClone(target) }] : []
      })
    }
  }
  const revoke = (id: string): void => {
    const permit = permits.get(id)
    if (permit) revokeGeoAutomaticPermit(permit)
    permits.delete(id)
    owners.delete(id)
  }
  return {
    state,
    isBusy: (): boolean => !!arm || closing || scheduler.isBusy(),
    async whenIdle(): Promise<void> {
      await scheduler.whenIdle()
      await drainArm()
    },
    async arm(raw: unknown, assertUI: () => void): Promise<GeoScheduleArmResult> {
      const selected = geoScheduleArmRequest(raw)
      if (arm || closing || scheduler.isBusy()) return { status: 'busy', state: state() }
      const op: Arm = { id: selected.origin.id, epoch, target: selected.target, assertUI }
      arm = op
      let registered = false
      try {
        live(op)
        const result = await scheduler.arm(selected.origin)
        if (result.status !== 'armed')
          return {
            status: op.unsupported ? 'unsupported' : 'cancelled',
            state: { ...state(), pending: scheduler.isBusy() || closing }
          }
        registered = true
        targets.set(op.id, structuredClone(op.target))
        live(op)
        if (!op.permit) throw new Error('地理调度授权未确认。')
        revoke(op.id)
        permits.set(op.id, op.permit)
        if (op.owner) owners.set(op.id, op.owner)
        // No callback or awaited work after the final arm scope check.
        return { status: 'armed', state: { ...state(), pending: scheduler.isBusy() || closing } }
      } catch {
        if (registered) {
          revoke(op.id)
          await scheduler.disarm({ id: op.id })
        }
        return {
          status: 'cancelled',
          state: { ...state(), pending: scheduler.isBusy() || closing }
        }
      } finally {
        if (op.permit && permits.get(op.id) !== op.permit) revokeGeoAutomaticPermit(op.permit)
        if (arm === op) arm = undefined
        armWaiters.splice(0).forEach((resolve) => resolve())
      }
    },
    async disarm(raw: unknown): Promise<GeoSchedulerState> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).join(',') !== 'id'
      )
        throw new Error('只接受待停用的地理来源ID。')
      const id = geoOriginSelection({
        id: (raw as { id: unknown }).id,
        revision: '0'.repeat(64)
      }).id
      ++epoch
      revoke(id)
      if (arm?.permit) revokeGeoAutomaticPermit(arm.permit)
      await scheduler.disarm({ id })
      await scheduler.whenIdle()
      await drainArm()
      return state()
    },
    async suspend(): Promise<void> {
      ++epoch
      await scheduler.suspend()
      await scheduler.whenIdle()
      await drainArm()
    },
    resume: (): void => scheduler.resume(),
    async invalidateOwners(): Promise<void> {
      const invalid: string[] = []
      for (const [id, owner] of owners) {
        try {
          owner.assertCurrent()
        } catch {
          invalid.push(id)
        }
      }
      if (!invalid.length) return
      ++epoch
      invalid.forEach(revoke)
      for (const id of invalid) await scheduler.disarm({ id })
      await scheduler.whenIdle()
      await drainArm()
    },
    async requestClose(): Promise<void> {
      ++epoch
      closing = true
      if (arm?.permit) revokeGeoAutomaticPermit(arm.permit)
      for (const id of permits.keys()) revoke(id)
      try {
        await scheduler.requestClose()
        await scheduler.whenIdle()
        await drainArm()
      } finally {
        closing = false
      }
    }
  }
}
