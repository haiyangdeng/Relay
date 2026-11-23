import type { RelayStateContext } from '../context'
import type { CoreLeaseRuntime, CoreStoreLease } from '../core/store'
import type { OwnedCoreCleanupRegistration, RelayOwnedCore } from '../core/owned-runtime'
import { localProxyConfiguration } from '../core/local-proxy-runtime'
import { resourceHash } from '../resources/source'
import type { CoreOwnerState } from '../../../shared/relay/core-owner'
import { coreOwnerResources, coreOwnerReleaseEnabled } from './release'
import { coreOwnerWorkspaceAbsent } from './presence'
import { createCoreOwnerAPI } from './api'
import { CoreOwnerTransport, type OwnerCommand } from './transport'
import type { OwnerReply, OwnerSnapshot } from './protocol'
import { recoverCoreOwner, type CoreOwnerRecovery } from './recovery'
import { openCoreOwnerWorkDirectory } from './work-directory'

export function persistentCoreConfiguration(
  source: string,
  port: number,
  selectors?: ReadonlyMap<string, string>
): ReturnType<typeof localProxyConfiguration> {
  const built = localProxyConfiguration(
      source,
      port,
      'off',
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      selectors
    ),
    value = JSON.parse(built.configuration)
  if (
    built.dedicated ||
    built.resolution.enabled ||
    value['proxy-groups'].length > 80 ||
    built.groups.some(
      (group) => group.type === 'smart' || group.dynamic || group.providers?.length
    ) ||
    Object.keys(value['proxy-providers'] ?? {}).length ||
    Object.keys(value['rule-providers'] ?? {}).length ||
    value.listeners?.length ||
    value.dns?.enable !== false ||
    value.tun?.enable !== false ||
    value.sniffer?.enable !== false ||
    value['geodata-mode'] === true ||
    (Array.isArray(value.rules) &&
      value.rules.some(
        (rule: unknown) => typeof rule !== 'string' || /^(?:GEOIP|GEOSITE|RULE-SET),/iu.test(rule)
      ))
  )
    throw new Error('持久普通代理不接入DNS、Smart、动态提供者、嗅探、地理库、规则集或专用监听。')
  return built
}
export function createCoreOwnerRuntime(context: RelayStateContext, nativeExecutable: () => string) {
  let transport: CoreOwnerTransport | undefined, snapshot: OwnerSnapshot | undefined
  let retiredTransports: CoreOwnerTransport[] = []
  let reservationOwner: CoreOwnerTransport | undefined
  let closedEvidence: OwnerSnapshot | undefined, closedClearSession: string | undefined
  let launchAttempted = false,
    observedForeignOwner = false
  let lifecycleNotice: string[] = []
  let leaseDelegated = false,
    noLaunchRetiredDelegate = false
  let resources: Awaited<ReturnType<typeof coreOwnerResources>> | undefined
  let pending = false,
    uncertain = false,
    recordPresent = false,
    attached = false
  let apiBusy = false,
    expectedConfiguration: string | undefined
  let recovery: CoreOwnerRecovery | undefined
  let originalReservation = false,
    primaryConnection = false,
    recoveryAttachment = false
  const current = (): OwnerSnapshot => {
    if (!snapshot || !transport?.live() || uncertain) throw new Error('持久代理归属或连接未确认。')
    return snapshot
  }
  const accept = (reply: OwnerReply, allowUncertain = false): OwnerSnapshot => {
    const next = reply.snapshot,
      resource = resources
    if (
      !resource ||
      next.owner.resourceSHA256 !== resource.sha256 ||
      next.owner.executable !== resource.executable ||
      next.owner.uid !== process.getuid?.() ||
      (originalReservation && reservationOwner && next.owner.pid !== reservationOwner.pid()) ||
      next.runtime.coreResourceSHA256 !== resource.core.sha256 ||
      (next.core &&
        (next.core.executable !== resource.core.executable ||
          next.core.resourceSHA256 !== resource.core.sha256 ||
          next.core.uid !== process.getuid?.())) ||
      (snapshot && next.sessionId !== snapshot.sessionId) ||
      (expectedConfiguration &&
        ['ready', 'detachPrepared', 'detached'].includes(next.phase) &&
        next.runtime.configurationSHA256 !== expectedConfiguration)
    )
      throw new Error('持久代理实际资源、进程或配置绑定未确认。')
    snapshot = next
    if (!originalReservation) observedForeignOwner = true
    if (next.phase === 'closed') closedEvidence = structuredClone(next)
    recordPresent = !next.released
    uncertain = reply.status === 'uncertain' || next.phase === 'uncertain'
    attached =
      primaryConnection &&
      next.attachedMain?.pid === process.pid &&
      !next.controlLost &&
      (!next.detached || (recoveryAttachment && next.phase === 'uncertain'))
    if (reply.status !== 'ok' && !(allowUncertain && reply.status === 'uncertain'))
      throw new Error('持久代理操作拒绝或结果未确认；保留现场。')
    return next
  }
  const command = async (input: OwnerCommand, assertIntent?: () => void): Promise<OwnerReply> => {
    if (!transport) throw new Error('没有已鉴别的持久代理连接。')
    try {
      const reply = await transport.request(input, assertIntent)
      accept(reply)
      return reply
    } catch (error) {
      uncertain = true
      throw error
    }
  }
  const inspect = async (): Promise<OwnerSnapshot> => {
    try {
      const before = snapshot
      const result = accept(
        await (async () => {
          if (!transport) throw new Error('没有已鉴别的连接。')
          return transport.request({ action: 'inspect' })
        })(),
        true
      )
      if (
        before &&
        (result.owner.pid !== before.owner.pid ||
          result.owner.bornSeconds !== before.owner.bornSeconds ||
          result.owner.bornMicroseconds !== before.owner.bornMicroseconds)
      )
        throw new Error('持久代理父进程已变化。')
      return result
    } catch (error) {
      uncertain = true
      throw error
    }
  }
  const assertPrimary = (): OwnerSnapshot => {
    const held = current()
    if (!attached || held.detached || held.phase !== 'ready' || !held.core)
      throw new Error('本次Main尚未明确接回此持久实例。')
    return held
  }
  const channels = (): CoreOwnerTransport[] => [
    ...new Set(
      [transport, reservationOwner, ...retiredTransports].filter(
        (channel): channel is CoreOwnerTransport => !!channel
      )
    )
  ]
  const sameOwner = (left: OwnerSnapshot['owner'], right: OwnerSnapshot['owner']): boolean =>
    (Object.keys(left) as (keyof OwnerSnapshot['owner'])[]).every((key) => left[key] === right[key])
  const originalServeGone = (): boolean =>
    !!closedEvidence &&
    !!reservationOwner &&
    reservationOwner.gone() &&
    reservationOwner.pid() === closedEvidence.owner.pid
  const witnessedOwnerGone = (): boolean => {
    const proof = recovery?.closedOwnerWitness
    return (
      !!closedEvidence &&
      proof?.absent === true &&
      proof.sessionId === closedEvidence.sessionId &&
      sameOwner(proof.owner, closedEvidence.owner)
    )
  }
  const retirementProven = (): boolean =>
    !!closedEvidence &&
    (originalServeGone() || witnessedOwnerGone()) &&
    !recordPresent &&
    recovery?.status === 'clear' &&
    closedClearSession === closedEvidence.sessionId
  const resetInactiveReferences = (notice: string[] = []): void => {
    transport = undefined
    reservationOwner = undefined
    retiredTransports = []
    snapshot = undefined
    closedEvidence = undefined
    closedClearSession = undefined
    expectedConfiguration = undefined
    originalReservation = false
    observedForeignOwner = false
    launchAttempted = false
    primaryConnection = false
    recoveryAttachment = false
    attached = false
    recordPresent = false
    uncertain = false
    recovery = undefined
    leaseDelegated = false
    lifecycleNotice = notice
  }
  const clearNeverLaunched = (): boolean => {
    if (
      recordPresent ||
      launchAttempted ||
      observedForeignOwner ||
      channels().some((channel) => !channel.gone())
    )
      return false
    const delegated = leaseDelegated
    resetInactiveReferences()
    noLaunchRetiredDelegate ||= delegated
    return true
  }
  const observeRecovery = async (): Promise<void> => {
    resources = await coreOwnerResources(nativeExecutable())
    recovery = await recoverCoreOwner(
      resources.executable,
      context,
      undefined,
      closedEvidence
        ? { sessionId: closedEvidence.sessionId, owner: structuredClone(closedEvidence.owner) }
        : undefined
    )
    recordPresent = !(await coreOwnerWorkspaceAbsent(context))
    closedClearSession =
      recovery.status === 'clear' &&
      !recordPresent &&
      closedEvidence &&
      (originalServeGone() || witnessedOwnerGone())
        ? closedEvidence.sessionId
        : undefined
  }
  const state = (): CoreOwnerState => ({
    phase: retirementProven()
      ? 'closed'
      : uncertain || (transport && !transport.live())
        ? 'uncertain'
        : (snapshot?.phase ??
          (!coreOwnerReleaseEnabled() ? 'unavailable' : recordPresent ? 'unknown' : 'absent')),
    pending: pending || apiBusy,
    hasRecord: recordPresent,
    canArchive: recordPresent && !pending && !apiBusy && recovery?.canArchive === true,
    canFinalize:
      !pending &&
      !apiBusy &&
      (retirementProven() ||
        (attached && !!transport?.live() && !uncertain && snapshot?.phase === 'closed')),
    attached: attached && !!transport?.live(),
    canDetach:
      recordPresent &&
      !pending &&
      !apiBusy &&
      attached &&
      !uncertain &&
      !!transport?.live() &&
      snapshot?.phase === 'ready',
    canReattach:
      !pending &&
      !apiBusy &&
      (['detached', 'uncertain'].includes(snapshot?.phase ?? '') ||
        (!primaryConnection && ['ready', 'closed'].includes(snapshot?.phase ?? '')) ||
        (!primaryConnection &&
          snapshot?.phase === 'reserved' &&
          snapshot.attachedMain?.pid === process.pid)) &&
      !!transport?.live() &&
      !attached,
    canStop:
      !pending &&
      !apiBusy &&
      attached &&
      !!transport?.live() &&
      ['ready', 'uncertain', 'closed'].includes(snapshot?.phase ?? ''),
    ...(snapshot
      ? { sessionId: snapshot.sessionId, httpPort: snapshot.runtime.httpPort }
      : closedEvidence
        ? { sessionId: closedEvidence.sessionId }
        : recovery?.sessionId
          ? { sessionId: recovery.sessionId }
          : {}),
    warnings: retirementProven()
      ? ['Core及本Main原owner均已证实退出；可明确收尾旧控制桥。先前归档同步仍未称为已确认。']
      : uncertain
        ? ['持久代理结果或连接未确认；保留Main、Core和记录，不自动重启或清理。']
        : (snapshot?.warnings ??
          (lifecycleNotice.length
            ? lifecycleNotice
            : !coreOwnerReleaseEnabled()
              ? ['持久owner配对签名资源尚未发布；原本次Main代理方式保持可用。']
              : []))
  })
  const stop = async (): Promise<void> => {
    if (pending || apiBusy) throw new Error('持久代理已有操作。')
    pending = true
    try {
      const before = await inspect()
      if (
        !attached ||
        !['reserved', 'starting', 'ready', 'closed', 'stopping', 'uncertain'].includes(before.phase)
      )
        throw new Error('必须先明确接回同一持久实例。')
      const closed = accept(await command({ action: 'stop', expectedRevision: before.revision }))
      if (closed.phase !== 'closed') throw new Error('持久核心实际退出未确认。')
    } finally {
      pending = false
    }
  }
  const release = async (): Promise<void> => {
    if (pending || apiBusy) throw new Error('Persistent operation pending')
    pending = true
    try {
      const held = await inspect()
      if (!(
        held.phase === 'closed' ||
        (originalReservation && held.phase === 'reserved' && held.core === null)
      ))
        throw new Error('实际子进程退出未确认，不释放核心lease。')
      const released = accept(await command({ action: 'release', expectedRevision: held.revision }))
      if (released.phase !== 'released' || !released.released)
        throw new Error('持久会话归档未确认。')
      await Promise.all(
        [transport, ...retiredTransports]
          .filter((channel): channel is CoreOwnerTransport => !!channel)
          .map((channel) => channel.finishReleased())
      )
      resetInactiveReferences()
    } finally {
      pending = false
    }
  }
  return {
    state,
    captureWorkDirectory(): ((open: (path: string) => Promise<void>) => Promise<void>) | undefined {
      const channel = transport,
        captured = snapshot
      if (!channel || !captured?.core || apiBusy) return undefined
      const core = captured.core
      const live = (): boolean =>
        coreOwnerReleaseEnabled() &&
        transport === channel &&
        channel.live() &&
        recordPresent &&
        !pending &&
        !uncertain &&
        !!snapshot?.core &&
        snapshot.sessionId === captured.sessionId &&
        snapshot.revision === captured.revision &&
        snapshot.phase === captured.phase &&
        sameOwner(snapshot.core, core) &&
        ((snapshot.phase === 'ready' && attached) ||
          (snapshot.phase === 'detached' && snapshot.detached))
      if (!live()) return undefined
      return async (open) => {
        const assertLive = (): void => {
          if (!live()) throw new Error('本次持久核心或工作目录归属已变化。')
        }
        assertLive()
        if (apiBusy) throw new Error('持久代理接口已有操作。')
        apiBusy = true
        try {
          const fresh = await inspect()
          assertLive()
          await openCoreOwnerWorkDirectory(context, fresh, open, assertLive)
        } finally {
          apiBusy = false
        }
      }
    },
    noLaunchRetirementPending: (): boolean => noLaunchRetiredDelegate,
    acknowledgeNoLaunchRetirement(): void {
      noLaunchRetiredDelegate = false
    },
    captureRetirementIntent(): () => void {
      if (!retirementProven() || !closedEvidence)
        throw new Error('缺少原owner实际退出和原Core关闭证明。')
      const target = closedEvidence.sessionId,
        owner = structuredClone(closedEvidence.owner),
        serve = reservationOwner
      return () => {
        if (
          !retirementProven() ||
          closedEvidence?.sessionId !== target ||
          reservationOwner !== serve ||
          !sameOwner(closedEvidence.owner, owner)
        )
          throw new Error('本次纯控制桥收尾凭据已变化。')
      }
    },
    async retireClosedBridges(assertIntent: () => void): Promise<void> {
      if (pending || apiBusy || !retirementProven()) throw new Error('纯控制桥收尾尚无完整事实。')
      pending = true
      try {
        assertIntent()
        await observeRecovery()
        assertIntent()
        if (!retirementProven() || !(await coreOwnerWorkspaceAbsent(context)))
          throw new Error('原退出或无活动目录事实已变化。')
        const clients = channels().filter((channel) => channel.role === 'client')
        await Promise.all(clients.map((channel) => channel.retireClosedClient()))
        if (
          channels().some((channel) => !channel.gone()) ||
          !(await coreOwnerWorkspaceAbsent(context))
        )
          throw new Error('仍有未退出助手或新活动目录。')
        resetInactiveReferences([
          'Core及原owner已退出，仅收尾本Main旧控制桥引用；没有把此前归档同步结果标为成功。'
        ])
      } catch (error) {
        uncertain = true
        throw error
      } finally {
        pending = false
      }
    },
    async finalizeRelease(assertIntent: () => void): Promise<void> {
      if (pending || apiBusy) throw new Error('Persistent operation pending')
      assertIntent()
      const observed = await inspect()
      if (!attached || observed.phase !== 'closed' || observed.released)
        throw new Error('No actual closed owner proof')
      assertIntent()
      await release()
    },
    captureControlIntent(): () => void {
      const channel = transport,
        target = snapshot
      if (!channel || !target) throw new Error('没有已鉴别的持久实例。')
      return () => {
        if (
          transport !== channel ||
          !channel.live() ||
          snapshot?.sessionId !== target.sessionId ||
          snapshot.owner.pid !== target.owner.pid ||
          snapshot.owner.bornSeconds !== target.owner.bornSeconds ||
          snapshot.owner.bornMicroseconds !== target.owner.bornMicroseconds
        )
          throw new Error('本次确认对应的持久实例或连接已变化。')
      }
    },
    captureArchiveIntent(): () => void {
      const target = recovery
      if (!target?.canArchive || !target.revision || !target.sessionId)
        throw new Error('缺少完整的原归档凭据。')
      return () => {
        if (
          !recovery?.canArchive ||
          recovery.revision !== target.revision ||
          recovery.sessionId !== target.sessionId
        )
          throw new Error('本次确认对应的归档凭据已变化。')
      }
    },
    isOperating: (): boolean => pending,
    isBlocking: (): boolean =>
      noLaunchRetiredDelegate ||
      pending ||
      apiBusy ||
      recordPresent ||
      !!transport ||
      retiredTransports.some((channel) => !channel.gone()) ||
      (!!closedEvidence && !!reservationOwner),
    async refreshPresence(): Promise<CoreOwnerState> {
      recordPresent = !(await coreOwnerWorkspaceAbsent(context))
      if (recordPresent) closedClearSession = undefined
      else clearNeverLaunched()
      return state()
    },
    resources: async () => (await coreOwnerResources(nativeExecutable())).core,
    async acquire(runtime: CoreLeaseRuntime, revision: string): Promise<CoreStoreLease> {
      if (pending || transport || recordPresent || runtime.resolverMode !== 'off')
        throw new Error('持久会话已有记录或不支持此解析方式。')
      pending = true
      try {
        resources = await coreOwnerResources(nativeExecutable())
        if (!(await coreOwnerWorkspaceAbsent(context))) throw new Error('持久会话已存在。')
        recordPresent = true // Reserve can partially create records before failing.
        originalReservation = true
        transport = new CoreOwnerTransport(resources.executable, context, {
          action: 'reserve',
          expectedRevision: revision,
          profileId: runtime.profileId,
          sourceSHA256: runtime.sourceSHA256,
          httpPort: runtime.httpPort,
          mode: 'rule'
        })
        reservationOwner = transport
        const reply = await transport.ready
        accept(reply)
        if (
          reply.status === 'ok' &&
          reply.snapshot.phase === 'reserved' &&
          reply.snapshot.attachedMain?.pid === process.pid
        )
          primaryConnection = true
        const reserved = accept(reply)
        if (
          reserved.phase !== 'reserved' ||
          reserved.runtime.profileId !== runtime.profileId ||
          reserved.runtime.sourceSHA256 !== runtime.sourceSHA256 ||
          reserved.runtime.httpPort !== runtime.httpPort ||
          !attached
        )
          throw new Error('持久代理预留未确认。')
        leaseDelegated = true
        return {
          async update(phase, pid): Promise<void> {
            const fresh = await inspect()
            if (
              !attached ||
              pid !== fresh.core?.pid ||
              (phase === 'running' && fresh.phase !== 'ready') ||
              phase === 'starting'
            )
              throw new Error('原生持久lease状态未确认。')
            // Native owns both lease records. Main never rewrites their bytes.
          },
          release
        }
      } catch (error) {
        uncertain = true
        throw error
      } finally {
        pending = false
      }
    },
    async start(
      source: string,
      port: number,
      register: OwnedCoreCleanupRegistration,
      assertIntent: () => void = () => {},
      selectors?: ReadonlyMap<string, string>
    ): Promise<RelayOwnedCore> {
      const built = persistentCoreConfiguration(source, port, selectors),
        held = current()
      if (
        !originalReservation ||
        !attached ||
        held.phase !== 'reserved' ||
        port !== held.runtime.httpPort ||
        pending
      )
        throw new Error('持久代理预留已变化。')
      expectedConfiguration = resourceHash(Buffer.from(built.configuration))
      register(stop) // Native already owns the lease and every future parser/Core.
      pending = true
      try {
        launchAttempted = true
        const ready = accept(
          await command({ action: 'launch', configuration: built.configuration }, assertIntent)
        )
        if (ready.phase !== 'ready' || !ready.core || !attached)
          throw new Error('持久代理启动未确认。')
        const api = createCoreOwnerAPI({
          directory: ready.runtime.directory,
          socket: ready.runtime.socket,
          live: () => {
            if (pending || uncertain || !attached || current().phase !== 'ready')
              throw new Error('持久代理上下文已撤销。')
          },
          inspect: async () => {
            const fresh = await inspect()
            if (
              fresh.phase !== 'ready' ||
              !attached ||
              fresh.runtime.configurationSHA256 !== expectedConfiguration
            )
              throw new Error('持久代理新读回未确认。')
          }
        })
        const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
          if (apiBusy || pending) throw new Error('持久代理接口已有操作。')
          apiBusy = true
          try {
            return await operation()
          } finally {
            apiBusy = false
          }
        }
        return {
          pid: ready.core.pid,
          version: 'v1.19.33',
          directory: ready.runtime.directory,
          socket: ready.runtime.socket,
          state: () =>
            !transport?.live() || uncertain || !attached
              ? 'unexpectedExit'
              : snapshot?.phase === 'closed' || snapshot?.phase === 'released'
                ? 'stopped'
                : snapshot?.phase === 'stopping'
                  ? 'stopping'
                  : 'running',
          read: (endpoint, guards) => guarded(() => api.read(endpoint, guards)),
          group: (name) => guarded(() => api.group(name)),
          select: (group, member) => guarded(() => api.select(group, member)),
          stop
        }
      } finally {
        pending = false
      }
    },
    async connect(): Promise<CoreOwnerState> {
      if (pending || apiBusy) throw new Error('已有持久代理操作。')
      pending = true
      try {
        recordPresent = !(await coreOwnerWorkspaceAbsent(context))
        retiredTransports = retiredTransports.filter((channel) => !channel.gone())
        if (transport && !transport.live()) {
          if (retiredTransports.length >= 4)
            throw new Error('持久代理旧连接达到保留预算；原owner和Core不受影响。')
          retiredTransports.push(transport)
          transport = undefined
          primaryConnection = false
          recoveryAttachment = false
        }
        if (!recordPresent && !transport) {
          if (!clearNeverLaunched() && closedEvidence) await observeRecovery()
          pending = false
          return state()
        }
        if (!transport) {
          resources = await coreOwnerResources(nativeExecutable())
          recordPresent = !(await coreOwnerWorkspaceAbsent(context))
          if (!recordPresent) return state()
          transport = new CoreOwnerTransport(resources.executable, context, { action: 'connect' })
          accept(await transport.ready)
        }
        await inspect()
        pending = false
        return state()
      } catch (error) {
        uncertain = recordPresent || !!transport
        throw error
      } finally {
        pending = false
      }
    },
    async inspectRecovery(): Promise<CoreOwnerState> {
      if (pending || apiBusy) throw new Error('Recovery busy')
      pending = true
      try {
        recordPresent = !(await coreOwnerWorkspaceAbsent(context))
        if (!recordPresent && !transport && clearNeverLaunched()) {
          pending = false
          return state()
        }
        await observeRecovery()
        if (recovery?.status === 'clear') clearNeverLaunched()
        pending = false
        return state()
      } catch (error) {
        uncertain = recordPresent || !!transport
        throw error
      } finally {
        pending = false
      }
    },
    async archive(assertIntent: () => void): Promise<void> {
      if (pending || apiBusy || !recovery?.canArchive || !recovery.revision)
        throw new Error('No dead-owner proof')
      const expected = recovery.revision
      pending = true
      try {
        assertIntent()
        resources = await coreOwnerResources(nativeExecutable())
        const fresh = await recoverCoreOwner(resources.executable, context)
        assertIntent()
        if (!fresh.canArchive || fresh.revision !== expected)
          throw new Error('Recovery revision changed')
        const result = await recoverCoreOwner(resources.executable, context, expected)
        if (result.status !== 'archived' || result.canArchive)
          throw new Error('Archive unconfirmed')
        recordPresent = !(await coreOwnerWorkspaceAbsent(context))
        if (recordPresent) throw new Error('Owner workspace remains')
        await Promise.all(
          [transport, ...retiredTransports]
            .filter((channel): channel is CoreOwnerTransport => !!channel)
            .map((channel) => channel.finishReleased())
        )
        resetInactiveReferences()
      } catch (error) {
        uncertain = true
        throw error
      } finally {
        pending = false
      }
    },
    async reattach(assertIntent: () => void): Promise<CoreOwnerState> {
      if (pending || apiBusy) throw new Error('已有持久代理操作。')
      pending = true
      try {
        assertIntent()
        const before = await inspect()
        if (!(
          ['detached', 'uncertain'].includes(before.phase) ||
          (!primaryConnection && ['ready', 'closed'].includes(before.phase)) ||
          (!primaryConnection &&
            before.phase === 'reserved' &&
            before.attachedMain?.pid === process.pid)
        ))
          throw new Error('仅允许明确接回已分离实例。')
        assertIntent()
        const reply = await command(
          { action: 'reattach', expectedRevision: before.revision },
          assertIntent
        )
        if (reply.status === 'ok' && reply.snapshot.attachedMain?.pid === process.pid) {
          primaryConnection = true
          recoveryAttachment = reply.snapshot.phase === 'uncertain'
        }
        const ready = accept(reply)
        assertIntent()
        if (!attached || !['ready', 'uncertain', 'closed'].includes(ready.phase))
          throw new Error('接回未确认。')
        pending = false
        return state()
      } finally {
        pending = false
      }
    },
    async detach(
      assertIntent: () => void,
      assertSideIdle: () => Promise<void>
    ): Promise<{ sessionId: string; revision: string }> {
      if (pending || apiBusy) throw new Error('已有持久代理操作。')
      assertPrimary()
      recoveryAttachment = false
      pending = true
      try {
        assertIntent()
        await assertSideIdle()
        assertIntent()
        const before = await inspect()
        if (!attached || before.phase !== 'ready') throw new Error('持久代理当前归属已变化。')
        const prepared = await command({
          action: 'detachPrepare',
          expectedRevision: before.revision
        })
        if (
          !prepared.detach ||
          prepared.snapshot.phase !== 'detachPrepared' ||
          prepared.detach.revision !== prepared.snapshot.revision ||
          Date.now() >= prepared.detach.expiresAt
        )
          throw new Error('分离凭据未确认。')
        assertIntent()
        await assertSideIdle()
        assertIntent()
        try {
          await command(
            {
              action: 'detachCommit',
              expectedRevision: prepared.detach.revision,
              evidenceId: prepared.detach.evidenceId
            },
            assertIntent
          )
        } catch {
          // A timed-out commit can already be durable. Read on the SAME
          // authenticated connection; do not resend commit or ordinary-stop.
          await inspect()
        }
        const committed = current()
        if (committed.phase !== 'detached' || !committed.detached)
          throw new Error('持久分离未确认；保留Main。')
        return { sessionId: committed.sessionId, revision: committed.revision }
      } catch (error) {
        if (snapshot?.phase === 'detachPrepared')
          await command({ action: 'cancelDetach' }).catch(() => {})
        throw error
      } finally {
        pending = false
      }
    },
    async verifyCommitted(
      pass: { sessionId: string; revision: string },
      assertIntent: () => void
    ): Promise<void> {
      assertIntent()
      const fresh = await inspect()
      assertIntent()
      if (
        fresh.phase !== 'detached' ||
        !fresh.detached ||
        fresh.sessionId !== pass.sessionId ||
        fresh.revision !== pass.revision
      )
        throw new Error('Detached owner changed')
    },
    unrefCommitted(): void {
      if (snapshot?.phase !== 'detached' || uncertain) throw new Error('Core detach unconfirmed')
      transport?.unrefCommitted()
    },
    committed(pass: { sessionId: string; revision: string }): boolean {
      return (
        !pending &&
        !apiBusy &&
        !uncertain &&
        transport?.live() === true &&
        snapshot?.phase === 'detached' &&
        snapshot.detached &&
        snapshot.sessionId === pass.sessionId &&
        snapshot.revision === pass.revision
      )
    },
    stop,
    release,
    ownsLocalInstance: (): boolean => originalReservation && (!!transport || !!reservationOwner),
    retained: (): boolean =>
      noLaunchRetiredDelegate ||
      snapshot?.phase === 'detached' ||
      uncertain ||
      (!!transport && !primaryConnection) ||
      (!!closedEvidence && !!reservationOwner),
    snapshot: (): OwnerSnapshot | undefined => (snapshot ? structuredClone(snapshot) : undefined)
  }
}
