import {
  tunRuleProvidersReadRequest,
  tunRuleProviderReplaceRequest,
  type TunRuleProviderEntry,
  type TunRuleProvidersResult
} from '../../../shared/relay/tun-rule-providers'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import type { RuleProviderResourceCandidate } from '../resources/rule-provider-candidate'
import { checkResourceJob, resourceRuleEntries } from '../resources/check-definition'
import type { TunResourceInbox } from './resource-inbox'
import type { TunRuleProviderBlobTicket } from './rule-provider-ticket'
import type {
  TunRuleProvidersChannel,
  TunRuleProvidersChannelResult,
  TunRuleProvidersNativeSnapshot
} from './rule-providers-contract'

export interface TunRuleProviderConfirmation {
  sessionId: string
  configurationRevision: string
  expectedGenerationSHA256: string
  provider: string
  linkedProviders: string[]
  kind: TunRuleProviderEntry['kind']
  behavior: TunRuleProviderEntry['behavior']
  oldSHA256: string
  newSHA256: string
  bytes: number
}
export interface TunRuleProviderLease {
  // The held session object is a private identity. Reading a snapshot never
  // clears quarantine, including after a lost acknowledgement.
  owner: object
  sessionId: string
  configurationRevision: string
  channel: TunRuleProvidersChannel
  inbox: Pick<TunResourceInbox, 'stageRuleProvider' | 'acknowledgeDiscard'>
  assertCurrent(): void
  release(): void
}
type Failure = Exclude<TunRuleProvidersResult['status'], 'snapshot' | 'updated' | 'unchanged'>
type Acquisition = { status: 'held'; lease: TunRuleProviderLease } | { status: Failure }

// Main-only coordinator. Native owns complete same-Core candidate acceptance,
// current Geo/provider budget, atomic publication, all alias PUTs and readback.
// This module supplies neither a pathname nor a claimed in-memory body digest.
export function createTunRuleProvidersService(adapters: {
  acquire(sessionId: string): Acquisition
  readCandidate(
    selection: RelayProfileSelection,
    expected: Pick<TunRuleProviderEntry, 'kind' | 'behavior'>
  ): Promise<RuleProviderResourceCandidate>
  confirm(report: TunRuleProviderConfirmation): Promise<boolean>
  now?(): number
}) {
  const isolated = new WeakSet<object>(),
    clock = adapters.now ?? (() => performance.now())
  let epoch = 0,
    pending:
      | {
          abort: AbortController
          channel: TunRuleProvidersChannel
          done: Promise<void>
        }
      | undefined
  const invalidate = (): void => {
    ++epoch
    const operation = pending
    if (!operation) return
    operation.abort.abort()
    void operation.channel.cancel().catch(() => {})
  }
  const run = async (
    raw: unknown,
    changing: boolean,
    assertUI: () => void
  ): Promise<TunRuleProvidersResult> => {
    const selection = changing ? tunRuleProviderReplaceRequest(raw) : undefined,
      request = selection ?? tunRuleProvidersReadRequest(raw),
      sessionId = request.sessionId,
      output = (status: Failure): TunRuleProvidersResult => ({ status, sessionId })
    if (pending) return output('busy')
    const generation = epoch,
      acquired = adapters.acquire(sessionId)
    if (acquired.status !== 'held') return output(acquired.status)
    const lease = acquired.lease,
      { owner, channel, inbox, configurationRevision } = lease,
      preparationDeadline = clock() + 30000
    let done!: () => void
    const operation = {
      channel,
      abort: new AbortController(),
      done: new Promise<void>((resolve) => (done = resolve))
    }
    pending = operation
    let started = false,
      replacementStatus: TunRuleProvidersChannelResult['status'] | undefined,
      invalid = false,
      staged: TunRuleProviderBlobTicket | undefined,
      outcome: TunRuleProvidersResult = output('unavailable')
    const live = (): void => {
      try {
        assertUI()
        lease.assertCurrent()
      } catch (error) {
        invalid = true
        operation.abort.abort()
        throw error
      }
      // Observers may synchronously revoke the operation. Their final callback
      // is followed by latch checks, never a later effectful callback.
      if (
        pending !== operation ||
        generation !== epoch ||
        operation.abort.signal.aborted ||
        // Once issued, the bound broker and Native use their single finite
        // transaction deadline. Preparation time cannot turn a valid confirmed
        // Native receipt into permanent owner uncertainty.
        (!started && clock() >= preparationDeadline) ||
        lease.sessionId !== sessionId ||
        isolated.has(owner)
      ) {
        invalid = true
        throw new Error('本次规则提供者范围已失效。')
      }
    }
    const quarantine = (): TunRuleProvidersResult => {
      isolated.add(owner)
      return output('uncertain')
    }
    const failedOutcome = (): TunRuleProvidersResult => {
      if (isolated.has(owner)) return output('uncertain')
      // A bound terminal cancellation/no-op means Native never crossed its
      // publication fence. Losing UI scope afterwards cannot turn that known
      // zero-write result into permanent uncertainty for this held owner.
      const noPublication =
        replacementStatus !== undefined &&
        [
          'cancelled',
          'unchanged',
          'busy',
          'stale',
          'expired',
          'unsupported',
          'unavailable'
        ].includes(replacementStatus)
      return started && !noPublication
        ? quarantine()
        : output(invalid ? 'cancelled' : 'unavailable')
    }
    const perform = async (): Promise<TunRuleProvidersResult> => {
      if (isolated.has(owner)) return output('uncertain')
      live()
      const observed = await channel.read(operation.abort.signal, live)
      live()
      if (!('snapshot' in observed))
        return observed.status === 'uncertain' ? quarantine() : output(observed.status)
      const before = structuredClone(observed.snapshot)
      if (observed.status !== 'snapshot' || before.configurationRevision !== configurationRevision)
        return output('stale')
      if (!selection) return { status: 'snapshot', sessionId, snapshot: { ...before, sessionId } }
      if (
        selection.configurationRevision !== before.configurationRevision ||
        selection.expectedGenerationSHA256 !== before.generationSHA256
      )
        return output('stale')
      const previous = before.providers.find((row) => row.name === selection.provider)
      if (!previous) return output('stale')
      const group = before.groups.find((names) => names.includes(previous.name))
      if (!group) return output('stale')
      const candidate = await adapters.readCandidate(selection.resource, {
        kind: previous.kind,
        behavior: previous.behavior
      })
      live()
      const job = candidate.job
      const declaredRuleCount = resourceRuleEntries(job).expected
      if (declaredRuleCount === undefined) return output('unsupported')
      const checkCandidate = async (): Promise<void> => {
        await candidate.recheck()
        live()
        checkResourceJob(job)
        if (
          job.sha256 !== selection.resource.sha256 ||
          job.descriptor.kind !== previous.kind ||
          job.descriptor.behavior !== previous.behavior
        )
          throw new Error('规则提供者候选已变化。')
      }
      await checkCandidate()
      const accepted = await adapters.confirm({
        sessionId,
        configurationRevision: before.configurationRevision,
        expectedGenerationSHA256: before.generationSHA256,
        provider: previous.name,
        linkedProviders: [...group],
        kind: previous.kind,
        behavior: previous.behavior,
        oldSHA256: previous.fileSHA256,
        newSHA256: job.sha256,
        bytes: job.bytes.length
      })
      live()
      if (!accepted) return output('cancelled')
      await checkCandidate()
      staged = await inbox.stageRuleProvider(job, operation.abort.signal, live)
      live()
      if (
        staged.kind !== previous.kind ||
        staged.sha256 !== job.sha256 ||
        staged.bytes !== job.bytes.length
      )
        return output('unavailable')
      await checkCandidate()
      if (!channel.isAvailable()) return output('unavailable')
      started = true
      const changed = await channel.replace(
        {
          configurationRevision: before.configurationRevision,
          expectedGenerationSHA256: before.generationSHA256,
          provider: previous.name,
          oldSHA256: previous.fileSHA256,
          newSHA256: staged.sha256,
          blobId: staged.blobId,
          kind: staged.kind,
          bytes: staged.bytes,
          filename: staged.filename,
          declaredRuleCount
        },
        operation.abort.signal,
        live
      )
      // Even a no-op must carry a consistent whole-table receipt before its
      // status can establish known zero publication after UI revocation.
      if (
        changed.status === 'unchanged' &&
        (previous.fileSHA256 !== staged.sha256 ||
          changed.snapshot.generationSHA256 !== before.generationSHA256 ||
          !matchesPublication(before, changed.snapshot, previous, staged, declaredRuleCount))
      )
        return quarantine()
      replacementStatus = changed.status
      live()
      if (!('snapshot' in changed))
        return changed.status === 'uncertain' ? quarantine() : output(changed.status)
      await checkCandidate()
      const after = changed.snapshot
      if (
        (changed.status !== 'updated' && changed.status !== 'unchanged') ||
        !matchesPublication(before, after, previous, staged, declaredRuleCount) ||
        (changed.status === 'updated' &&
          (previous.fileSHA256 === staged.sha256 ||
            before.generationSHA256 === after.generationSHA256)) ||
        (changed.status === 'unchanged' &&
          (previous.fileSHA256 !== staged.sha256 ||
            before.generationSHA256 !== after.generationSHA256))
      )
        return quarantine()
      return {
        status: changed.status,
        sessionId,
        snapshot: { ...structuredClone(after), sessionId }
      }
    }
    try {
      outcome = await perform()
    } catch {
      outcome = failedOutcome()
    } finally {
      try {
        await channel.whenIdle()
        // Unknown publication retains its new blob as well as Native's old
        // inode. A later successful read cannot adopt it or free this quota.
        if (staged && outcome.status !== 'uncertain') {
          const receipt = await channel.discardBlob(staged)
          if (receipt === 'discarded' || receipt === 'absent') inbox.acknowledgeDiscard(staged)
        }
      } catch {
        channel.invalidate()
        outcome = failedOutcome()
      } finally {
        try {
          if (outcome.status !== 'uncertain') live()
        } catch {
          outcome = failedOutcome()
        }
        try {
          lease.release()
          if (outcome.status !== 'uncertain') live()
        } catch {
          outcome = failedOutcome()
        } finally {
          if (pending === operation) pending = undefined
          done()
        }
      }
    }
    return outcome
  }
  return {
    read: (raw: unknown, assertUI: () => void) => run(raw, false, assertUI),
    replace: (raw: unknown, assertUI: () => void) => run(raw, true, assertUI),
    invalidate,
    isBusy: () => !!pending,
    whenIdle: (): Promise<void> => pending?.done ?? Promise.resolve()
  }
}

function matchesPublication(
  before: TunRuleProvidersNativeSnapshot,
  after: TunRuleProvidersNativeSnapshot,
  selected: TunRuleProviderEntry,
  staged: TunRuleProviderBlobTicket,
  declaredRuleCount: number
): boolean {
  if (
    after.configurationRevision !== before.configurationRevision ||
    after.providers.length !== before.providers.length ||
    JSON.stringify(after.groups) !== JSON.stringify(before.groups)
  )
    return false
  const group = new Set(before.groups.find((names) => names.includes(selected.name)))
  return before.providers.every((prior) => {
    const next = after.providers.find((row) => row.name === prior.name)
    if (!next) return false
    if (!group.has(prior.name)) return JSON.stringify(prior) === JSON.stringify(next)
    return (
      prior.kind === next.kind &&
      prior.behavior === next.behavior &&
      next.fileSHA256 === staged.sha256 &&
      next.bytes === staged.bytes &&
      next.ruleCount === declaredRuleCount
    )
  })
}
