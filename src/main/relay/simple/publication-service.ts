import { randomUUID } from 'node:crypto'
import type { RelayProfilePreparation, RelayStoredProfile } from '../../../shared/relay/profiles'
import { profileEvidence } from '../../../shared/relay/profiles'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import type { createProfileService, ProfilePublicationToken } from '../profiles/service'
import type { ProfileSource } from '../profiles/source'
import {
  boundedJSON,
  clone,
  hash,
  keys,
  revision,
  SimpleFailure,
  type SimpleRecord,
  type SimplePublicationReceipt
} from './model'
import type { createSimpleDraftService, SimpleOwner } from './service'
import { publicationPostimage, type SimpleDraftStore } from './store'
import {
  publicationMarker,
  type PublicationMarker,
  type PublicationJournalRecord,
  type SimplePublicationJournal
} from './publication-journal'

type Classification =
  'none' | 'complete' | 'abandoned' | 'incomplete-known-copy' | 'unknown-profile' | 'uncertain'
export interface SimplePublicationState {
  initialized: boolean
  pending: boolean
  closing: boolean
  blocking: boolean
  classification: Classification
  needsRetirement: boolean
  markerRevision: string
  operationId?: string
  profile?: RelayProfileSelection
}
export interface SimplePublicationResult {
  status: 'published' | 'cancelled' | 'failed' | 'uncertain' | 'abandoned'
  operationId: string
  profile?: RelayProfileSelection
  publishedRevision?: number
  revision?: string
  needsRecovery: boolean
}
interface Authority {
  epoch: number
  owner: SimpleOwner
  consumer?: SimpleOwner
}
interface Prepared {
  authority: Authority
  operationId: string
  record: SimpleRecord
  source: ProfileSource
  inputDigest: string
  payloadDigest: string
  report: RelayProfilePreparation
  token: ProfilePublicationToken
  markerRevision: string
  baselineMarker: PublicationJournalRecord
  at: number
}
interface Operation {
  kind: 'preparing' | 'confirming' | 'abandoning'
  authority: Authority
  owner: SimpleOwner
}
export function publishedPayloadDigest(record: SimpleRecord, side: 'draft' | 'published'): string {
  const value = {
    draft: record.document.state[side],
    bindings: record.document.bindings[side],
    configurationRevision: record.document.configurationRevision[side]
  }
  boundedJSON(value)
  return hash(JSON.stringify(value))
}
const sameReceipt = (record: SimpleRecord, marker: PublicationMarker): boolean => {
  const receipt = record.document.publication
  return (
    !!receipt &&
    !!marker.profile &&
    receipt.operationId === marker.operationId &&
    receipt.inputDigest === marker.inputDigest &&
    receipt.profile.id === marker.profile.id &&
    receipt.profile.sha256 === marker.profile.sha256 &&
    record.document.state.revision === marker.publishedRevision + 1 &&
    publishedPayloadDigest(record, 'published') === marker.publishedPayloadSHA256
  )
}
export function createSimplePublicationService(adapters: {
  store: Pick<SimpleDraftStore, 'read' | 'promotePublished'>
  journal: Pick<SimplePublicationJournal, 'read' | 'write' | 'retireMissing'>
  simple: Pick<
    ReturnType<typeof createSimpleDraftService>,
    'prepareProfile' | 'isBusy' | 'whenIdle'
  >
  profiles: Pick<
    ReturnType<typeof createProfileService>,
    'preparePublication' | 'savePublication' | 'isBusy' | 'whenIdle'
  >
  readProfile(
    selection: RelayProfileSelection
  ): Promise<{ profile: RelayStoredProfile; text: string }>
  now?(): number
}) {
  let epoch = 0,
    initialized = false,
    closing = false,
    restoring = false
  let operation: Operation | undefined, prepared: Prepared | undefined
  let classification: Classification = 'uncertain',
    needsRetirement = false
  let lastJournal: PublicationJournalRecord = { value: null, revision: '', exists: false }
  let expectedMarker: PublicationMarker | undefined
  let observedProfile: RelayProfileSelection | undefined
  let attemptedBaseline: PublicationJournalRecord | undefined
  let profileMayHaveStarted = false
  const now = adapters.now ?? Date.now
  const waiters: (() => void)[] = [],
    operationWaiters: (() => void)[] = []
  const ownerCurrent = (owner: SimpleOwner): void => {
    let current = false
    try {
      current = owner.isCurrent()
    } catch {
      /* revoked */
    }
    if (!current) throw new SimpleFailure('cancelled')
  }
  const authorityCurrent = (authority: Authority): void => {
    if (authority.epoch !== epoch || closing || restoring) throw new SimpleFailure('cancelled')
    ownerCurrent(authority.owner)
    if (authority.consumer) ownerCurrent(authority.consumer)
  }
  const current = (op: Operation): void => {
    if (operation !== op) throw new SimpleFailure('cancelled')
    authorityCurrent(op.authority)
    ownerCurrent(op.owner)
  }
  const factsCurrent = (op: Operation): void => {
    // Only the same admitted in-flight operation can finish bounded facts after
    // owner retirement. This is never a permission to start/promote anything.
    if (operation !== op) throw new SimpleFailure('uncertain')
  }
  const diskBlocking = (): boolean =>
    !initialized ||
    classification === 'uncertain' ||
    classification === 'unknown-profile' ||
    classification === 'incomplete-known-copy' ||
    needsRetirement
  const state = (): SimplePublicationState => ({
    initialized,
    pending: !!operation || restoring,
    closing,
    blocking: closing || !!operation || restoring || diskBlocking(),
    classification,
    needsRetirement,
    markerRevision: lastJournal.revision,
    ...(expectedMarker ? { operationId: expectedMarker.operationId } : {}),
    ...((observedProfile ?? lastJournal.value?.profile)
      ? { profile: clone(observedProfile ?? lastJournal.value?.profile ?? undefined) }
      : {})
  })
  const idle = (): void => {
    if (!operation && !restoring) waiters.splice(0).forEach((done) => done())
  }
  const whenIdle = (): Promise<void> =>
    operation || restoring ? new Promise((done) => waiters.push(done)) : Promise.resolve()
  const clear = (): void => {
    ++epoch
    prepared = undefined
  }
  const begin = (
    kind: Operation['kind'],
    owner: SimpleOwner,
    authority?: Authority,
    allowBlocked = false
  ): Operation => {
    ownerCurrent(owner)
    if (closing) throw new SimpleFailure('closed')
    if (operation || restoring || adapters.simple.isBusy() || adapters.profiles.isBusy())
      throw new SimpleFailure('busy')
    if (!initialized || (!allowBlocked && diskBlocking())) throw new SimpleFailure('uncertain')
    if (!authority) {
      clear()
      authority = { epoch, owner }
    }
    authorityCurrent(authority)
    const op = { kind, owner, authority }
    operation = op
    return op
  }
  const end = (op: Operation): void => {
    if (operation === op) {
      operation = undefined
      operationWaiters.splice(0).forEach((done) => done())
      idle()
    }
  }
  const verifyProfile = async (marker: PublicationMarker, check: () => void): Promise<void> => {
    if (!marker.profile) throw new SimpleFailure('uncertain')
    check()
    const actual = await adapters.readProfile(clone(marker.profile))
    check()
    boundedJSON(actual, 4 * 1024 * 1024, 2 * 1024 * 1024)
    if (
      actual.profile.id !== marker.profile.id ||
      actual.profile.sha256 !== marker.outputSHA256 ||
      hash(actual.text) !== marker.outputSHA256 ||
      hash(actual.profile.name) !== marker.profileNameSHA256
    )
      throw new SimpleFailure('uncertain')
  }
  const completed = async (
    record: SimpleRecord,
    marker: PublicationMarker,
    exact: boolean,
    check: () => void
  ): Promise<boolean> => {
    check()
    if (!sameReceipt(record, marker) || (exact && record.revision !== marker.postimageSHA256))
      return false
    await verifyProfile(marker, check)
    check()
    return true
  }
  const classify = async (check: () => void): Promise<void> => {
    check()
    try {
      const journal = await adapters.journal.read()
      check()
      const record = await adapters.store.read()
      check()
      lastJournal = journal
      needsRetirement = false
      if (!journal.value) {
        classification = expectedMarker || record.document.publication ? 'uncertain' : 'none'
        const journalAgain = await adapters.journal.read()
        check()
        const recordAgain = await adapters.store.read()
        check()
        if (journalAgain.revision !== journal.revision || recordAgain.revision !== record.revision)
          classification = 'uncertain'
        return
      }
      const marker = journal.value
      if (
        expectedMarker &&
        expectedMarker.operationId !== marker.operationId &&
        attemptedBaseline
      ) {
        classification = 'uncertain'
        return
      }
      expectedMarker = marker
      if (marker.profile) observedProfile = marker.profile
      if (marker.phase === 'complete') {
        // Later draft-only saves legitimately change the whole file SHA.
        classification = (await completed(record, marker, false, check)) ? 'complete' : 'uncertain'
      } else if (marker.phase === 'abandoned') {
        classification =
          record.document.publication?.operationId === marker.operationId
            ? 'uncertain'
            : 'abandoned'
      } else if (await completed(record, marker, true, check)) {
        classification = 'complete'
        needsRetirement = true
      } else if (
        record.document.publication?.operationId === marker.operationId ||
        record.revision !== marker.expectedSimpleRevision
      ) {
        classification = 'uncertain'
      } else if (marker.phase === 'profile-saved') {
        await verifyProfile(marker, check)
        check()
        classification = 'incomplete-known-copy'
      } else classification = 'unknown-profile'
      const journalAgain = await adapters.journal.read()
      check()
      const recordAgain = await adapters.store.read()
      check()
      if (journalAgain.revision !== journal.revision || recordAgain.revision !== record.revision) {
        classification = 'uncertain'
        needsRetirement = false
      }
    } catch (error) {
      if (error instanceof SimpleFailure && error.code === 'cancelled') throw error
      classification = 'uncertain'
      needsRetirement = false
    }
  }
  const restore = async (
    owner?: SimpleOwner,
    restored = false
  ): Promise<SimplePublicationState> => {
    if (owner) ownerCurrent(owner)
    if (restoring) throw new SimpleFailure('busy')
    closing = true
    clear()
    restoring = true
    const restoreEpoch = epoch
    const fresh = (): void => {
      if (epoch !== restoreEpoch) throw new SimpleFailure('cancelled')
      if (owner) ownerCurrent(owner)
    }
    try {
      if (operation) await new Promise<void>((done) => operationWaiters.push(done))
      fresh()
      await adapters.profiles.whenIdle()
      fresh()
      await adapters.simple.whenIdle()
      fresh()
      if (restored) {
        expectedMarker = undefined
        observedProfile = undefined
        attemptedBaseline = undefined
        profileMayHaveStarted = false
      }
      await classify(fresh)
      fresh()
      initialized = true
      closing = false
    } catch (error) {
      initialized = false
      classification = 'uncertain'
      throw error
    } finally {
      restoring = false
      idle()
    }
    return state()
  }
  const journalExact = async (
    marker: PublicationMarker,
    expectedRevision: string
  ): Promise<PublicationJournalRecord> => {
    const actual = await adapters.journal.read()
    if (
      !actual.exists ||
      actual.revision !== expectedRevision ||
      JSON.stringify(actual.value) !== JSON.stringify(marker)
    )
      throw new SimpleFailure('uncertain')
    return actual
  }
  return {
    state,
    isBusy: (): boolean => !!operation || restoring,
    isBlocking: (): boolean => state().blocking,
    whenIdle,
    clear,
    requestClose(): Promise<void> {
      closing = true
      clear()
      return whenIdle()
    },
    reopen(): void {
      if (operation || restoring) throw new SimpleFailure('busy')
      clear()
      closing = false
    },
    initialize: (): Promise<SimplePublicationState> => restore(),
    afterRestore: (): Promise<SimplePublicationState> => restore(undefined, true),
    recover: (owner: SimpleOwner): Promise<SimplePublicationState> => restore(owner),
    async prepare(
      raw: unknown,
      owner: SimpleOwner
    ): Promise<{ operationId: string; preparation: RelayProfilePreparation }> {
      boundedJSON(raw)
      keys(raw, ['expectedRevision', 'previewSHA256', 'name'])
      revision(raw.expectedRevision)
      if (
        typeof raw.previewSHA256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(raw.previewSHA256) ||
        typeof raw.name !== 'string'
      )
        throw new SimpleFailure('invalid')
      const op = begin('preparing', owner)
      try {
        await classify(() => current(op))
        current(op)
        if (diskBlocking()) throw new SimpleFailure('uncertain')
        const record = clone(await adapters.store.read())
        current(op)
        if (record.revision !== raw.expectedRevision) throw new SimpleFailure('stale')
        const source = await adapters.simple.prepareProfile(raw, owner)
        current(op)
        if (!source.assertCurrent) throw new SimpleFailure('invalid')
        await source.assertCurrent()
        current(op)
        if ((await adapters.store.read()).revision !== record.revision)
          throw new SimpleFailure('stale')
        current(op)
        const operationId = randomUUID(),
          payloadDigest = publishedPayloadDigest(record, 'draft')
        const manifest = {
          contract: 'simple-publication-v1',
          recordSHA256: record.revision,
          publishedRevision: record.document.state.revision,
          bindings: record.document.bindings.draft,
          configurationRevision: record.document.configurationRevision.draft,
          profileNameSHA256: hash(source.name),
          outputSHA256: hash(source.text),
          outputBytes: Buffer.byteLength(source.text),
          publishedPayloadSHA256: payloadDigest
        }
        boundedJSON(manifest)
        const inputDigest = hash(JSON.stringify(manifest))
        // Size-only placeholder: no directory or Profile ID is reserved here.
        publicationPostimage(record, {
          operationId,
          inputDigest,
          profile: { id: '00000000-0000-4000-8000-000000000000', sha256: manifest.outputSHA256 }
        })
        const guarded: ProfileSource = Object.freeze({
          name: source.name,
          text: source.text,
          assertCurrent: async () => {
            authorityCurrent(op.authority)
            await source.assertCurrent?.()
            authorityCurrent(op.authority)
          },
          readAgain: async () => {
            authorityCurrent(op.authority)
            const text = await source.readAgain()
            authorityCurrent(op.authority)
            return text
          }
        })
        const result = await adapters.profiles.preparePublication(guarded)
        current(op)
        if (
          result.report.sha256 !== manifest.outputSHA256 ||
          result.report.bytes !== manifest.outputBytes
        )
          throw new SimpleFailure('invalid')
        const at = now()
        if (!Number.isSafeInteger(at) || at < 0) throw new SimpleFailure('invalid')
        prepared = {
          authority: op.authority,
          operationId,
          record,
          source: guarded,
          inputDigest,
          payloadDigest,
          report: clone(result.report),
          token: result.token,
          markerRevision: lastJournal.revision,
          baselineMarker: clone(lastJournal),
          at
        }
        return { operationId, preparation: clone(result.report) }
      } catch (error) {
        clear()
        throw error instanceof SimpleFailure ? error : new SimpleFailure('invalid')
      } finally {
        end(op)
      }
    },
    async confirm(raw: unknown, owner: SimpleOwner): Promise<SimplePublicationResult> {
      boundedJSON(raw)
      const evidenceId = profileEvidence(raw),
        held = prepared
      if (!held || held.report.evidenceId !== evidenceId) throw new SimpleFailure('stale')
      const op = begin('confirming', owner, held.authority)
      held.authority.consumer = owner
      prepared = undefined
      const timely = (): void => {
        const at = now()
        if (!Number.isSafeInteger(at) || at < held.at || at - held.at > 60000)
          throw new SimpleFailure('cancelled')
      }
      const admission = (): void => {
        current(op)
        timely()
      }
      let lease: PublicationJournalRecord | undefined, candidate: PublicationMarker | undefined
      const result = (
        status: SimplePublicationResult['status'],
        committed?: SimpleRecord
      ): SimplePublicationResult => ({
        status,
        operationId: held.operationId,
        ...(expectedMarker?.operationId === held.operationId && observedProfile
          ? { profile: clone(observedProfile) }
          : {}),
        ...(committed
          ? { publishedRevision: committed.document.state.revision, revision: committed.revision }
          : {}),
        needsRecovery: diskBlocking()
      })
      try {
        const before = await adapters.journal.read()
        current(op)
        if (before.revision !== held.markerRevision) throw new SimpleFailure('stale')
        const saved = await adapters.profiles.savePublication(held.token, async () => {
          current(op)
          await held.source.assertCurrent?.()
          current(op)
          if ((await adapters.store.read()).revision !== held.record.revision)
            throw new SimpleFailure('stale')
          current(op)
          candidate = publicationMarker({
            version: 1,
            operationId: held.operationId,
            phase: 'intent',
            expectedSimpleRevision: held.record.revision,
            publishedRevision: held.record.document.state.revision,
            inputDigest: held.inputDigest,
            outputSHA256: held.report.sha256,
            profileNameSHA256: hash(held.source.name),
            publishedPayloadSHA256: held.payloadDigest,
            profile: null,
            postimageSHA256: null,
            createdAt: now()
          })
          expectedMarker = candidate
          attemptedBaseline = held.baselineMarker
          observedProfile = undefined
          profileMayHaveStarted = false
          lease = await adapters.journal.write(held.markerRevision, candidate, () => current(op))
          lastJournal = lease
          current(op)
          profileMayHaveStarted = true
        })
        if (saved.status !== 'saved' || !saved.profile) {
          if (saved.status === 'uncertain' && !expectedMarker) classification = 'uncertain'
          else await classify(() => (candidate ? factsCurrent(op) : current(op)))
          return result(
            saved.status === 'cancelled' && !candidate
              ? 'cancelled'
              : diskBlocking()
                ? 'uncertain'
                : 'failed'
          )
        }
        boundedJSON(saved.profile)
        const selection = profileSelection({ id: saved.profile.id, sha256: saved.profile.sha256 })
        if (
          !candidate ||
          !lease ||
          selection.sha256 !== held.report.sha256 ||
          hash(saved.profile.name) !== hash(held.source.name)
        )
          throw new SimpleFailure('uncertain')
        observedProfile = selection
        const receipt: SimplePublicationReceipt = {
          profile: selection,
          inputDigest: held.inputDigest,
          operationId: held.operationId
        }
        const predicted = publicationPostimage(held.record, receipt)
        candidate = publicationMarker({
          ...candidate,
          phase: 'profile-saved',
          profile: selection,
          postimageSHA256: predicted.revision
        })
        expectedMarker = candidate
        lease = await adapters.journal.write(lease.revision, candidate, () => factsCurrent(op))
        lastJournal = lease
        current(op)
        await verifyProfile(candidate, () => current(op))
        current(op)
        timely()
        const heldMarker = candidate,
          heldLease = lease
        await adapters.store.promotePublished(
          { expectedRevision: held.record.revision, receipt },
          async () => {
            current(op)
            await held.source.assertCurrent?.()
            current(op)
            await journalExact(heldMarker, heldLease.revision)
            current(op)
            timely()
          },
          admission
        )
        const committed = await adapters.store.read()
        if (!(await completed(committed, candidate, true, () => factsCurrent(op))))
          throw new SimpleFailure('uncertain')
        try {
          lastJournal = await adapters.journal.write(
            lease.revision,
            { ...candidate, phase: 'complete' },
            () => factsCurrent(op)
          )
          expectedMarker = lastJournal.value ?? candidate
          attemptedBaseline = undefined
        } catch {
          /* receipt below is authoritative; never save or promote again */
        }
        await classify(() => (candidate ? factsCurrent(op) : current(op)))
        return result('published', committed)
      } catch {
        if (!candidate) {
          try {
            current(op)
          } catch {
            return result('cancelled')
          }
        }
        // A rename may have committed before its sync/return failed. Only the
        // exact active postimage can certify it; no retry and no list guessing.
        if (candidate?.profile) {
          try {
            const committed = await adapters.store.read()
            if (await completed(committed, candidate, true, () => factsCurrent(op))) {
              if (lease) {
                try {
                  lastJournal = await adapters.journal.write(
                    lease.revision,
                    { ...candidate, phase: 'complete' },
                    () => factsCurrent(op)
                  )
                  expectedMarker = lastJournal.value ?? candidate
                  attemptedBaseline = undefined
                } catch {
                  /* retain unresolved marker */
                }
              }
              await classify(() => factsCurrent(op))
              return result('published', committed)
            }
          } catch {
            /* unconfirmed facts remain blocked */
          }
        }
        await classify(() => (candidate ? factsCurrent(op) : current(op)))
        return result(diskBlocking() ? 'uncertain' : 'failed')
      } finally {
        end(op)
      }
    },
    async abandon(raw: unknown, owner: SimpleOwner): Promise<SimplePublicationResult> {
      boundedJSON(raw)
      keys(raw, ['operationId', 'expectedMarkerRevision'])
      revision(raw.expectedMarkerRevision)
      const operationId = profileSelection({ id: raw.operationId, sha256: 'a'.repeat(64) }).id
      const op = begin('abandoning', owner, undefined, true)
      try {
        const journal = await adapters.journal.read()
        current(op)
        lastJournal = journal
        if (journal.revision !== raw.expectedMarkerRevision) throw new SimpleFailure('stale')
        const marker =
          journal.value?.operationId === operationId
            ? journal.value
            : expectedMarker?.operationId === operationId
              ? expectedMarker
              : undefined
        if (!marker) throw new SimpleFailure('stale')
        const record = await adapters.store.read()
        current(op)
        const isComplete = await completed(record, marker, marker.phase !== 'complete', () =>
          current(op)
        )
        current(op)
        if (
          !isComplete &&
          (record.document.publication?.operationId === operationId ||
            record.document.state.revision !== marker.publishedRevision)
        )
          throw new SimpleFailure('uncertain')
        if (journal.value && journal.value.operationId !== operationId) {
          // Failed intent never replaced the original terminal baseline and the
          // Profile core never got past the callback: retire only memory facts.
          if (
            profileMayHaveStarted ||
            !attemptedBaseline ||
            journal.revision !== attemptedBaseline.revision
          )
            throw new SimpleFailure('uncertain')
          expectedMarker = journal.value
          attemptedBaseline = undefined
          observedProfile = undefined
          await classify(() => current(op))
          current(op)
          return { status: 'abandoned', operationId, needsRecovery: diskBlocking() }
        }
        const phase = isComplete ? 'complete' : 'abandoned'
        lastJournal = journal.value
          ? journal.value.phase === phase
            ? journal
            : await adapters.journal.write(journal.revision, { ...marker, phase }, () =>
                current(op)
              )
          : await adapters.journal.retireMissing(marker, phase, () => current(op))
        expectedMarker = lastJournal.value ?? marker
        attemptedBaseline = undefined
        await classify(() => factsCurrent(op))
        return {
          status: isComplete ? 'published' : 'abandoned',
          operationId,
          ...(observedProfile ? { profile: clone(observedProfile) } : {}),
          ...(isComplete
            ? { publishedRevision: record.document.state.revision, revision: record.revision }
            : {}),
          needsRecovery: diskBlocking()
        }
      } catch (error) {
        try {
          await classify(() => current(op))
        } catch {
          /* retired reads stop; preserve unresolved state */
        }
        throw error instanceof SimpleFailure && error.code !== 'invalid'
          ? error
          : new SimpleFailure('uncertain')
      } finally {
        end(op)
      }
    }
  }
}
