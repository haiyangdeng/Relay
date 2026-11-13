import { randomUUID } from 'crypto'
import { lstat } from 'fs/promises'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { TrafficDatabaseClient } from '../../traffic/database'
import { SubscriptionFiles } from '../subscriptions/private-files'
import type { RelayStateContext } from '../context'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type { ConnectionSnapshot } from '../../../shared/relay/observability'
import {
  TrafficUsageAccumulator,
  type TrafficUsageConnectionSnapshot,
  type TrafficUsageWriteBatch
} from '../../../shared/trafficUsage'
import {
  trafficHistoryOwner,
  trafficHistoryDimension,
  trafficHistoryRange,
  trafficHistoryBucket,
  trafficHistoryBreakdown,
  trafficHistoryImport,
  type TrafficHistoryState,
  type TrafficHistoryOwner
} from '../../../shared/relay/traffic-history'

type Binding = TrafficHistoryOwner & { pid?: number }
export function createTrafficHistory(adapters: {
  context: RelayStateContext
  local(): LocalProxyState
  tunOwner?(): TrafficHistoryOwner | undefined
  cancelRead?(): void
  assertAvailable(): void
  confirm(
    action: 'record' | 'clear' | 'import' | 'retry',
    owner?: TrafficHistoryOwner
  ): Promise<boolean>
}) {
  const files = new SubscriptionFiles(adapters.context),
    directory = join(adapters.context.stateRoot, 'Telemetry/TrafficUsage'),
    path = join(directory, 'history.sqlite'),
    accumulator = new TrafficUsageAccumulator()
  let database: TrafficDatabaseClient | undefined,
    identity: { dev: number; ino: number } | undefined,
    recording: Binding | undefined,
    generation = 0,
    confirming = false,
    pending = 0,
    closed = false,
    unavailable = false,
    writeFailed = false,
    clearUncertain = false,
    snapshots = 0,
    warning: string | undefined,
    dropped = 0,
    batches: TrafficUsageWriteBatch[] = [],
    queue: Promise<void> = Promise.resolve()
  const idleWaiters: (() => void)[] = []
  const finishIdle = (): void => {
    if (!confirming && !pending) idleWaiters.splice(0).forEach((resolve) => resolve())
  }
  const whenIdle = (): Promise<void> =>
    confirming || pending ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve()
  let importPermit: { wall: number; mono: number; batches: number; assertOwner(): void } | undefined
  const binding = (): Binding | undefined => {
    const value = adapters.local()
    if (
      !value.owned ||
      value.pending ||
      value.uncertain ||
      value.phase !== 'running' ||
      value.traffic !== 'listening' ||
      !value.instanceId ||
      !value.configurationRevision ||
      !Number.isSafeInteger(value.pid) ||
      !value.pid
    )
      return adapters.tunOwner?.()
    return {
      instanceId: value.instanceId,
      configurationRevision: value.configurationRevision,
      pid: value.pid
    }
  }
  const same = (left: Binding | undefined, right: Binding | undefined): boolean =>
    !!left &&
    !!right &&
    left.instanceId === right.instanceId &&
    left.configurationRevision === right.configurationRevision &&
    left.pid === right.pid &&
    left.kind === right.kind &&
    left.evidenceSHA256 === right.evidenceSHA256
  const publicOwner = (value: Binding): TrafficHistoryOwner =>
    value.kind === 'tun-managed'
      ? {
          kind: 'tun-managed',
          instanceId: value.instanceId,
          configurationRevision: value.configurationRevision,
          evidenceSHA256: value.evidenceSHA256
        }
      : { instanceId: value.instanceId, configurationRevision: value.configurationRevision }
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    if (closed || unavailable || pending >= 32)
      return Promise.reject(new Error('历史库尚未就绪或操作过多。'))
    ++pending
    const task = queue.then(action, action)
    queue = task.then(
      () => {},
      () => {}
    )
    return task.finally(() => {
      --pending
      finishIdle()
    })
  }
  const open = async (): Promise<TrafficDatabaseClient> => {
    await files.directory(directory, true)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await files.write(path, '')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await files.sync(directory)
      info = await lstat(path)
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o7777) !== 0o600 ||
      info.size > 512 * 1024 * 1024 ||
      (identity && (info.dev !== identity.dev || info.ino !== identity.ino))
    )
      throw new Error('历史库文件身份、权限或大小未通过检查，保留原文件。')
    for (const suffix of ['-wal', '-shm']) {
      try {
        const sidecar = await lstat(path + suffix)
        if (
          !sidecar.isFile() ||
          sidecar.isSymbolicLink() ||
          sidecar.nlink !== 1 ||
          sidecar.uid !== process.getuid?.() ||
          (sidecar.mode & 0o7777) !== 0o600
        )
          throw new Error('历史库附属文件未通过私有文件检查。')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    identity ??= { dev: info.dev, ino: info.ino }
    database ??= new TrafficDatabaseClient(() => path, 30000)
    return database
  }
  // Reserve conservatively for both SQLite pages and WAL before admission.
  // Never copy, checkpoint or delete an active WAL to recover space.
  const assertWriteBudget = async (rows: readonly unknown[], resolutions = 1): Promise<void> => {
    await open()
    let stored = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        stored += (await lstat(path + suffix)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const projected =
      1024 * 1024 +
      resolutions *
        rows.reduce<number>(
          (total, row) => total + (Buffer.byteLength(JSON.stringify(row), 'utf8') * 4 + 4096) * 2,
          0
        )
    if (!Number.isSafeInteger(stored + projected) || stored + projected > 128 * 1024 * 1024)
      throw new Error(
        '历史数据库与附属文件没有足够的128MiB写入预算；已保留原库，可停止记录或明确清空后重试。'
      )
  }
  const pendingBatch = (): TrafficUsageWriteBatch | undefined => {
    const samples = accumulator.takePending()
    if (samples.length) {
      if (batches.length >= 4) {
        dropped += samples.length
        recording = undefined
        ++generation
        warning = '历史待写预算已满，已停止记录；统计存在未保存区间。'
      } else batches.push({ id: `relay:${randomUUID()}`, samples })
    }
    return batches[0]
  }
  const flush = async (recover = false): Promise<void> => {
    if (clearUncertain) throw new Error('历史清理未确认；请先重新明确清空。')
    if (writeFailed && !recover) throw new Error('请先明确恢复未确认的历史写入。')
    try {
      for (let index = 0; index < 4; ++index) {
        const batch = pendingBatch()
        if (!batch) {
          if (recover) {
            writeFailed = false
            warning = undefined
          }
          return
        }
        const db = await open()
        await assertWriteBudget(batch.samples, 3)
        await db.write(batch)
        await open()
        if (batches[0] === batch) batches.shift()
      }
      if (recover) {
        writeFailed = false
        warning = undefined
      }
    } catch {
      recording = undefined
      ++generation
      writeFailed = true
      warning = '历史写入未确认；已停止记录并保留待写批次，没有自动重放。请先读取历史核对。'
      throw new Error(warning)
    }
  }
  const stop = (reason?: string): void => {
    // Already accepted samples keep their original timestamp; a late read ticket cannot enter a later permit.
    pendingBatch()
    recording = undefined
    ++generation
    adapters.cancelRead?.()
    accumulator.setEnabled(false)
    if (reason) warning = reason
  }
  const state = (): TrafficHistoryState => {
    const current = binding()
    if (recording && !same(recording, current)) stop('自有核心或配置已变化，历史记录许可已失效。')
    if (importPermit) {
      try {
        importPermit.assertOwner()
        if (
          Date.now() < importPermit.wall ||
          performance.now() < importPermit.mono ||
          Date.now() - importPermit.wall >= 300000 ||
          performance.now() - importPermit.mono >= 300000
        )
          importPermit = undefined
      } catch {
        importPermit = undefined
      }
    }
    return {
      recording: !!recording,
      pending: closed || confirming || pending > 0,
      owner: recording && publicOwner(recording),
      availableOwner: current && publicOwner(current),
      importAuthorized: !!importPermit,
      writeRecoveryRequired: writeFailed && !clearUncertain,
      clearRecoveryRequired: clearUncertain,
      sampledSnapshots: snapshots,
      droppedRecords: accumulator.droppedCount + dropped,
      passiveOnly: true,
      warning
    }
  }
  const authorize = async (
    action: 'record' | 'clear' | 'import' | 'retry',
    assertOwner: () => void,
    input?: unknown
  ): Promise<boolean> => {
    if (closed || unavailable || confirming || pending) throw new Error('历史库操作尚未结束。')
    const epoch = generation
    if (action !== 'clear' && clearUncertain)
      throw new Error('历史清理未确认，请重新执行清空或读取事实。')
    if (action === 'record' && writeFailed) throw new Error('请先恢复未确认写入。')
    adapters.assertAvailable()
    const before = action === 'record' ? binding() : undefined
    if (action === 'record' && (!before || !same(trafficHistoryOwner(input), publicOwner(before))))
      throw new Error('自有核心身份已变化。')
    confirming = true
    try {
      assertOwner()
      if (!(await adapters.confirm(action, before))) return false
      assertOwner()
      if (closed || generation !== epoch) throw new Error('本次历史操作已失效。')
      adapters.assertAvailable()
      if (before && !same(before, binding())) throw new Error('确认期间自有核心已变化。')
      if (action === 'record') {
        stop()
        recording = before
        accumulator.setEnabled(true)
        warning = undefined
      } else if (action === 'import') {
        importPermit = { wall: Date.now(), mono: performance.now(), batches: 0, assertOwner }
      }
      return true
    } finally {
      confirming = false
      finishIdle()
    }
  }
  return {
    state,
    authorize,
    ticket(): { generation: number; owner: Binding } | undefined {
      state()
      return recording ? { generation, owner: { ...recording } } : undefined
    },
    observe(
      ticket: { generation: number; owner: Binding } | undefined,
      snapshot: ConnectionSnapshot | undefined,
      sourceOwner?: TrafficHistoryOwner
    ): void {
      if (
        !ticket ||
        !snapshot ||
        !recording ||
        ticket.generation !== generation ||
        !same(ticket.owner, recording) ||
        (recording.kind === 'tun-managed'
          ? !sourceOwner || !same(sourceOwner, publicOwner(recording))
          : !!sourceOwner) ||
        !same(recording, binding())
      )
        return
      try {
        const count = (value: unknown): number => {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
            throw new Error()
          return value
        }
        const text = (value: unknown): string | undefined => {
          if (value === undefined) return undefined
          if (
            typeof value !== 'string' ||
            value.length > 1024 ||
            [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
          )
            throw new Error()
          return value
        }
        if (snapshot.connections.length > 10000) throw new Error()
        const connections: NonNullable<TrafficUsageConnectionSnapshot['connections']>[number][] = []
        for (const raw of snapshot.connections) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error()
          const value = raw as Record<string, unknown>,
            metadata = value.metadata
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
            throw new Error()
          const fields = metadata as Record<string, unknown>,
            id = text(value.id),
            start = text(value.start)
          if (!id || !start || !Number.isFinite(Date.parse(start))) throw new Error()
          let chains: string[] | undefined
          if (value.chains !== undefined) {
            if (!Array.isArray(value.chains) || value.chains.length > 64) throw new Error()
            chains = value.chains.map((item) => {
              const result = text(item)
              if (!result) throw new Error()
              return result
            })
          }
          connections.push({
            id,
            start,
            upload: count(value.upload),
            download: count(value.download),
            chains: chains?.length ? chains : ['Unknown'],
            metadata: {
              sourceIP: text(fields.sourceIP),
              host: text(fields.host),
              destinationIP: text(fields.destinationIP),
              process: text(fields.process)
            }
          })
        }
        accumulator.addSnapshot({
          connections,
          uploadTotal: count(snapshot.upload),
          downloadTotal: count(snapshot.download)
        })
        ++snapshots
        if (accumulator.pendingSize && !writeFailed) void run(() => flush()).catch(() => {})
      } catch {
        stop('本次连接快照不适合历史记录，已停止；没有估算或伪造流量。')
      }
    },
    stop(reason?: string): Promise<void> {
      stop(reason)
      return run(() => flush())
    },
    async overview(type: unknown, start: unknown, end: unknown, bucket: unknown) {
      const dimension = trafficHistoryDimension(type),
        range = trafficHistoryRange(start, end),
        interval = trafficHistoryBucket(bucket)
      return run(async () => {
        return (await open()).overview(dimension, range.start, range.end, interval)
      })
    },
    async breakdown(raw: unknown) {
      const query = trafficHistoryBreakdown(raw)
      return run(async () => {
        return (await open()).breakdown(query)
      })
    },
    import(raw: unknown): Promise<void> {
      const batch = trafficHistoryImport(raw),
        permit = importPermit
      const check = (count = false): void => {
        if (
          !permit ||
          importPermit !== permit ||
          (count && ++permit.batches > 1000) ||
          Date.now() < permit.wall ||
          performance.now() < permit.mono ||
          Date.now() - permit.wall >= 300000 ||
          performance.now() - permit.mono >= 300000
        )
          throw new Error('请先明确授权本次旧历史导入。')
        permit.assertOwner()
      }
      check(true)
      return run(async () => {
        check()
        await flush()
        const db = await open()
        check()
        await assertWriteBudget(batch.records)
        check()
        await db.import({ ...batch, id: `indexeddb:${batch.id}` })
        await open()
      })
    },
    clear(): Promise<void> {
      stop()
      importPermit = undefined
      return run(async () => {
        try {
          await (await open()).clear()
          batches = []
          writeFailed = false
          clearUncertain = false
          warning = undefined
        } catch {
          clearUncertain = true
          warning = '历史清理结果未确认；记录与导入保持停用，请读取事实或再次明确清空。'
          throw new Error(warning)
        }
      })
    },
    retry(): Promise<void> {
      if (clearUncertain) return Promise.reject(new Error('请先核对历史清理结果。'))
      return run(() => flush(true))
    },
    isBusy: (): boolean => closed || confirming || pending > 0,
    isBlocking: (): boolean =>
      !!database ||
      !!recording ||
      confirming ||
      pending > 0 ||
      batches.length > 0 ||
      accumulator.pendingSize > 0,
    whenIdle,
    async requestClose(): Promise<void> {
      closed = true
      stop('本次历史记录已暂停。')
      importPermit = undefined
      await whenIdle()
      try {
        await flush()
        try {
          await database?.close()
          database = undefined
        } catch (error) {
          unavailable = true
          throw error
        }
      } finally {
        closed = false
      }
    },
    invalidate(): void {
      importPermit = undefined
      stop('本次历史记录许可已失效；不会自动恢复。')
    }
  }
}
