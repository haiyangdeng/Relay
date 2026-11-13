import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type { RelayStateContext } from '../context'
import { CORE_OWNER_CONTRACT, ownerReply, type OwnerReply } from './protocol'

type Initial =
  | { action: 'connect' }
  | {
      action: 'reserve'
      expectedRevision: string
      profileId: string
      sourceSHA256: string
      httpPort: number
      mode: 'rule'
    }
export type OwnerCommand =
  | { action: 'launch'; configuration: string }
  | { action: 'inspect' | 'cancelDetach' }
  | { action: 'reattach' | 'detachPrepare' | 'stop' | 'release'; expectedRevision: string }
  | { action: 'detachCommit'; expectedRevision: string; evidenceId: string }
export class CoreOwnerTransport {
  private readonly child: ChildProcessWithoutNullStreams
  private output = Buffer.alloc(0)
  private failed = false
  private ended = false
  private readonly exitWaiters: (() => void)[] = []
  private sequence = 0
  private negotiated: OwnerReply | undefined
  private stderrBytes = 0
  private inFlight = false
  private readonly waiting = new Map<
    string,
    {
      sequence: number
      resolve(reply: OwnerReply): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
      expired: boolean
    }
  >()
  readonly ready: Promise<OwnerReply>
  readonly role: 'serve' | 'client'
  constructor(
    executable: string,
    private readonly context: RelayStateContext,
    initial: Initial
  ) {
    this.role = initial.action === 'reserve' ? 'serve' : 'client'
    // Reject before spawning/reserving, including every socket, not just control.
    for (const socket of ['api.sock', 'owner.sock'])
      if (Buffer.byteLength(join(context.stateRoot, 'CoreOwner/.session', socket)) > 103)
        throw new Error('固定Unix接口路径超过系统预算，未创建会话。')
    this.child = spawn(executable, [initial.action === 'reserve' ? '--serve' : '--client'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
      env: { HOME: context.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }
    })
    this.child.on('error', () => this.fail())
    this.child.on('close', () => {
      this.ended = true
      this.exitWaiters.splice(0).forEach((resolve) => resolve())
      this.fail()
    })
    this.child.stdout.on('error', () => this.fail())
    this.child.stdout.on('aborted', () => this.fail())
    this.child.stdout.on('close', () => this.fail())
    this.child.stdin.on('error', () => this.fail())
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length
      if (this.stderrBytes > 65536) this.fail()
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.failed) return
      this.output = Buffer.concat([this.output, chunk])
      while (this.output.includes(10)) {
        const end = this.output.indexOf(10)
        if (end < 1 || end > 65536) {
          this.fail()
          return
        }
        const line = this.output.subarray(0, end)
        this.output = this.output.subarray(end + 1)
        try {
          const reply = ownerReply(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)),
            this.context
          )
          const pending = this.waiting.get(reply.requestId)
          if (!pending || reply.sequence !== pending.sequence) throw new Error()
          if (
            this.negotiated &&
            (reply.connectionId !== this.negotiated.connectionId ||
              reply.clientNonce !== this.negotiated.clientNonce ||
              reply.serverNonce !== this.negotiated.serverNonce ||
              reply.snapshot.sessionId !== this.negotiated.snapshot.sessionId)
          )
            throw new Error()
          this.negotiated ??= reply
          this.waiting.delete(reply.requestId)
          clearTimeout(pending.timer)
          if (!pending.expired) pending.resolve(reply)
        } catch {
          this.fail()
          return
        }
      }
      if (this.output.length > 65536) this.fail()
    })
    this.ready = this.send(
      { version: 1, contract: CORE_OWNER_CONTRACT, requestId: randomUUID(), ...initial, context },
      0
    ).catch((error) => {
      // A failed hello must not leave a forever-rejected ready promise behind
      // a nominally live bridge. Keep its process/pipe, permit explicit inspect
      // to open a separately authenticated observational client later.
      this.fail()
      throw error
    })
  }
  private fail(): void {
    if (this.failed) return
    this.failed = true
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer)
      if (!pending.expired)
        pending.reject(new Error('持久代理连接未确认；保留会话记录，不自动重试或启动其他核心。'))
    }
    this.waiting.clear()
    // No kill, end(stdin), record cleanup or fallback. EOF can have lifecycle
    // meaning; a lost transport never authorizes a PID operation.
  }
  private send(
    frame: Record<string, unknown>,
    sequence: number,
    timeout = 15000
  ): Promise<OwnerReply> {
    if (this.failed || this.child.stdin.destroyed)
      return Promise.reject(new Error('持久代理连接不可用。'))
    const wire = JSON.stringify(frame) + '\n',
      id = String(frame.requestId)
    if (Buffer.byteLength(wire) > 3 * 1024 * 1024)
      return Promise.reject(new Error('持久代理请求超过预算。'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.waiting.get(id)
        if (pending) {
          pending.expired = true
          reject(new Error('持久代理结果未确认；没有重试。'))
        }
      }, timeout)
      this.waiting.set(id, { sequence, resolve, reject, timer, expired: false })
      this.child.stdin.write(wire, 'utf8', (error) => {
        if (error) this.fail()
      })
    })
  }
  async request(command: OwnerCommand, assertIntent: () => void = () => {}): Promise<OwnerReply> {
    if (this.inFlight) throw new Error('已有持久代理请求。')
    this.inFlight = true
    try {
      assertIntent()
      await this.ready
      assertIntent()
      const hello = this.negotiated
      if (this.sequence >= Number.MAX_SAFE_INTEGER || this.waiting.size > 2) this.fail()
      if (!hello || this.failed) throw new Error('持久代理连接额度或身份未确认。')
      return await this.send(
        {
          version: 1,
          contract: CORE_OWNER_CONTRACT,
          requestId: randomUUID(),
          sessionId: hello.snapshot.sessionId,
          connectionId: hello.connectionId,
          clientNonce: hello.clientNonce,
          serverNonce: hello.serverNonce,
          sequence: ++this.sequence,
          ...command
        },
        this.sequence,
        command.action === 'launch' ? 35000 : 15000
      )
    } finally {
      this.inFlight = false
    }
  }
  live(): boolean {
    return !this.failed
  }
  gone(): boolean {
    return this.ended
  }
  pid(): number | undefined {
    return this.child.pid
  }
  async retireClosedClient(): Promise<void> {
    if (this.role !== 'client') throw new Error('不能以纯桥收尾替代owner退出证明。')
    await this.finishReleased()
  }
  unrefCommitted(): void {
    this.child.unref()
  }
  async finishReleased(): Promise<void> {
    // Only a durable released receipt permits orderly pipe retirement.
    this.child.stdin.end()
    if (this.ended) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('持久助手实际退出未确认。')), 5000)
      this.exitWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
