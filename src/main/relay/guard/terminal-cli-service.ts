import { createHash } from 'crypto'
import type { LocalRuntimeCapture, LocalRuntimeCaptureResult } from '../core/local-proxy-service'
import type { GuardNativeBridge } from './native-addon'
import { createScopedHTTPSBroker } from './scoped-https-broker'

export interface TerminalCLIGrant {
  proxyURL: string
  caPEM: string
}

export interface TerminalLeaseChannel {
  start(): Promise<boolean>
  next(): Promise<{ kind: 'request' | 'commit' | 'closed'; id: string } | null>
  respond(id: string, grant: TerminalCLIGrant | null): Promise<boolean>
  confirm(id: string, allow: boolean): Promise<boolean>
  close(id: string): Promise<void>
  stop(): Promise<void>
}

type Broker = Awaited<ReturnType<typeof createScopedHTTPSBroker>>
interface Session {
  id: string
  abort: AbortController
  phase: 'preparing' | 'offered' | 'committing' | 'running' | 'closing'
  work?: Promise<void>
  broker?: Broker
  proof?: LocalRuntimeCapture
  nativeTouched: boolean
  closing?: Promise<boolean>
}

// The native listener accepts only the paired launcher. No renderer message,
// arguments, terminal contents, environment or account credentials reach Main.
export function createTerminalCLIService(adapters: {
  channel: TerminalLeaseChannel
  bridge: Pick<GuardNativeBridge, 'verifyScoped' | 'revokeScoped'>
  capture(signal: AbortSignal): Promise<LocalRuntimeCaptureResult>
  owned(): { instanceId?: string; pid?: number }
  assertIdle(): void
  broker?: typeof createScopedHTTPSBroker
}) {
  let session: Session | undefined
  let accepting = false
  let watcher: ReturnType<typeof setInterval> | undefined
  let started: Promise<void> | undefined

  const live = (target: Session): boolean =>
    accepting && session === target && !target.abort.signal.aborted

  const requireLive = (target: Session): void => {
    if (!live(target)) throw new Error('本次终端代理租约已失效。')
  }

  const retire = (target: Session): Promise<boolean> => {
    if (target.closing) return target.closing
    target.abort.abort()
    target.phase = 'closing'
    if (watcher) clearInterval(watcher)
    watcher = undefined
    // close() destroys broker streams before waiting for server shutdown. Do
    // this before the control channel tells the launcher to stop.
    const brokerClosing = target.broker?.close()
    target.closing = (async () => {
      let controlClosed = true
      try {
        await adapters.channel.close(target.id)
      } catch {
        controlClosed = false
      }
      try {
        await target.work?.catch(() => {})
        await brokerClosing
        await target.broker?.close()
        if (target.nativeTouched) {
          const result = await adapters.bridge.revokeScoped()
          if (result.pending || result.scopedPolicy?.phase !== 'unbound') return false
          target.nativeTouched = false
        }
        if (!controlClosed) return false
        if (session === target) session = undefined
        return true
      } catch {
        return false
      }
    })().finally(() => {
      target.closing = undefined
    })
    return target.closing
  }

  const prepare = async (target: Session): Promise<void> => {
    const { signal } = target.abort
    const result = await adapters.capture(signal)
    requireLive(target)
    if (result.status !== 'captured') throw new Error('自有专用代理尚未就绪。')
    const capture = result.capture
    const { instanceId, configuration } = capture.snapshot
    const digest = createHash('sha256').update(configuration).digest('hex')
    const owner = adapters.owned()
    await capture.assertOwner(signal)
    requireLive(target)
    if (!capture.isCurrent() || owner.instanceId !== instanceId || !owner.pid)
      throw new Error('自有专用代理归属未确认。')

    const assertProof = (proof: Awaited<ReturnType<GuardNativeBridge['verifyScoped']>>): void => {
      if (
        proof.pending ||
        proof.phase === 'blocked' ||
        proof.scopedPolicy?.phase !== 'prepared' ||
        proof.scopedPolicy.instanceID !== instanceId ||
        proof.scopedPolicy.configurationSHA256 !== digest
      )
        throw new Error('本次专用代理证明未确认。')
    }
    // Even a rejected response can follow a native state change. Retire this
    // proof before releasing the single session slot in Main.
    target.nativeTouched = true
    assertProof(
      await adapters.bridge.verifyScoped({ instanceID: instanceId, configuration, pid: owner.pid })
    )
    requireLive(target)
    const proof: LocalRuntimeCapture = {
      ...capture,
      isCurrent: () => live(target) && capture.isCurrent(),
      assertOwner: async (active) => {
        requireLive(target)
        await capture.assertOwner(active)
        requireLive(target)
        assertProof(await adapters.bridge.verifyScoped())
        requireLive(target)
      }
    }
    target.proof = proof
    const broker = await (adapters.broker ?? createScopedHTTPSBroker)(proof)
    target.broker = broker
    requireLive(target)
    if (!broker.isAlive()) throw new Error('本次代理通道未就绪。')
    watcher = setInterval(() => {
      if (!broker.isAlive()) void retire(target)
    }, 500)
    watcher.unref()
    target.phase = 'offered'
    if (
      !(await adapters.channel.respond(target.id, {
        proxyURL: broker.proxyURL,
        caPEM: String(broker.ca)
      }))
    )
      throw new Error('启动器已撤销本次请求。')
  }

  const confirm = async (target: Session): Promise<void> => {
    if (!target.proof || !target.broker?.isAlive()) throw new Error()
    await target.proof.assertOwner(target.abort.signal)
    requireLive(target)
    if (!target.broker.isAlive() || !(await adapters.channel.confirm(target.id, true)))
      throw new Error()
    requireLive(target)
    target.phase = 'running'
  }

  const track = (target: Session, work: Promise<void>): void => {
    target.work = work
    void work.catch(() => retire(target))
  }

  const handle = async (
    event: NonNullable<Awaited<ReturnType<TerminalLeaseChannel['next']>>>
  ): Promise<void> => {
    if (event.kind === 'closed') {
      if (session?.id === event.id) void retire(session)
      return
    }
    if (event.kind === 'commit') {
      if (!session || session.id !== event.id || session.phase !== 'offered') {
        await adapters.channel.confirm(event.id, false)
        return
      }
      const target = session
      const offered = target.work
      target.phase = 'committing'
      track(
        target,
        (async () => {
          await offered
          requireLive(target)
          await confirm(target)
        })()
      )
      return
    }
    try {
      if (!accepting || session) throw new Error()
      adapters.assertIdle()
    } catch {
      await adapters.channel.respond(event.id, null)
      return
    }
    const target: Session = {
      id: event.id,
      abort: new AbortController(),
      phase: 'preparing',
      nativeTouched: false
    }
    session = target
    track(target, prepare(target))
  }

  return {
    start(): Promise<void> {
      started ??= (async () => {
        try {
          accepting = await adapters.channel.start()
          while (accepting) {
            const event = await adapters.channel.next()
            if (!event || !accepting) break
            await handle(event)
          }
        } catch {
          // A malformed/failed channel cannot hand off a launcher.
        } finally {
          accepting = false
          if (session) await retire(session)
          await adapters.channel.stop().catch(() => {})
        }
      })()
      return started
    },
    isBlocking: () => !!session,
    async requestClose(): Promise<boolean> {
      return session ? retire(session) : true
    }
  }
}
