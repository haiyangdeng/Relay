import type { RelayStateContext } from '../context'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import { boundedJSON, keys, revision, SimpleFailure } from './model'
import { SimplePrivateDocumentFile, type SimpleFileRecord } from './store'

export type PublicationPhase = 'intent' | 'profile-saved' | 'complete' | 'abandoned'
export interface PublicationMarker {
  version: 1
  operationId: string
  phase: PublicationPhase
  expectedSimpleRevision: string
  publishedRevision: number
  inputDigest: string
  outputSHA256: string
  profileNameSHA256: string
  publishedPayloadSHA256: string
  profile: RelayProfileSelection | null
  postimageSHA256: string | null
  createdAt: number
}
export type PublicationJournalRecord = SimpleFileRecord<PublicationMarker | null>
const digest = (raw: unknown): string => {
  revision(raw)
  if (typeof raw !== 'string' || !raw) throw new SimpleFailure('invalid')
  return raw
}
export function publicationMarker(raw: unknown): PublicationMarker {
  boundedJSON(raw, 16 * 1024, 16 * 1024)
  keys(raw, [
    'version',
    'operationId',
    'phase',
    'expectedSimpleRevision',
    'publishedRevision',
    'inputDigest',
    'outputSHA256',
    'profileNameSHA256',
    'publishedPayloadSHA256',
    'profile',
    'postimageSHA256',
    'createdAt'
  ])
  if (
    raw.version !== 1 ||
    typeof raw.phase !== 'string' ||
    !['intent', 'profile-saved', 'complete', 'abandoned'].includes(raw.phase) ||
    !Number.isSafeInteger(raw.publishedRevision) ||
    Number(raw.publishedRevision) < 0 ||
    !Number.isSafeInteger(raw.createdAt) ||
    Number(raw.createdAt) < 0
  )
    throw new SimpleFailure('invalid')
  const inputDigest = digest(raw.inputDigest)
  const operationId = profileSelection({ id: raw.operationId, sha256: inputDigest }).id
  revision(raw.expectedSimpleRevision)
  const profile = raw.profile === null ? null : profileSelection(raw.profile)
  const postimageSHA256 = raw.postimageSHA256 === null ? null : digest(raw.postimageSHA256)
  const outputSHA256 = digest(raw.outputSHA256)
  if (
    !!profile !== !!postimageSHA256 ||
    (profile && profile.sha256 !== outputSHA256) ||
    (raw.phase === 'intent' && profile !== null) ||
    ((raw.phase === 'profile-saved' || raw.phase === 'complete') && profile === null)
  )
    throw new SimpleFailure('invalid')
  return {
    version: 1,
    operationId,
    phase: raw.phase as PublicationPhase,
    expectedSimpleRevision: raw.expectedSimpleRevision,
    publishedRevision: Number(raw.publishedRevision),
    inputDigest,
    outputSHA256,
    profileNameSHA256: digest(raw.profileNameSHA256),
    publishedPayloadSHA256: digest(raw.publishedPayloadSHA256),
    profile,
    postimageSHA256,
    createdAt: Number(raw.createdAt)
  }
}
const facts = (value: PublicationMarker): string =>
  JSON.stringify({
    operationId: value.operationId,
    expectedSimpleRevision: value.expectedSimpleRevision,
    publishedRevision: value.publishedRevision,
    inputDigest: value.inputDigest,
    outputSHA256: value.outputSHA256,
    profileNameSHA256: value.profileNameSHA256,
    publishedPayloadSHA256: value.publishedPayloadSHA256,
    createdAt: value.createdAt
  })
export class SimplePublicationJournal {
  readonly path: string
  private readonly file: SimplePrivateDocumentFile<PublicationMarker | null>
  constructor(context: RelayStateContext) {
    this.file = new SimplePrivateDocumentFile<PublicationMarker | null>(
      context,
      'simple-publication.json',
      publicationMarker,
      () => null
    )
    this.path = this.file.path
  }
  read(): Promise<PublicationJournalRecord> {
    return this.file.read()
  }
  // Only an explicit coordinator recovery with its previously held facts may
  // retire a lost lease. Existing/unknown bytes are never replaced this way.
  async retireMissing(
    known: PublicationMarker,
    phase: 'complete' | 'abandoned',
    assertCurrent: () => void
  ): Promise<PublicationJournalRecord> {
    const next = publicationMarker({ ...known, phase })
    return this.file.change(
      '',
      (previous) => {
        if (previous.exists) throw new SimpleFailure('uncertain')
        return next
      },
      assertCurrent
    )
  }
  async write(
    expectedRevision: string,
    raw: unknown,
    assertCurrent: () => void
  ): Promise<PublicationJournalRecord> {
    const next = publicationMarker(raw)
    try {
      return await this.file.change(
        expectedRevision,
        (previous) => {
          const old = previous.value
          if (!old || old.phase === 'complete' || old.phase === 'abandoned') {
            if (next.phase !== 'intent' || old?.operationId === next.operationId)
              throw new SimpleFailure('invalid')
          } else {
            if (facts(old) !== facts(next)) throw new SimpleFailure('stale')
            if (!(
              (old.phase === 'intent' && next.phase === 'profile-saved') ||
              (old.phase === 'profile-saved' && next.phase === 'complete') ||
              next.phase === 'abandoned'
            ))
              throw new SimpleFailure('invalid')
            if (
              old.profile &&
              (JSON.stringify(old.profile) !== JSON.stringify(next.profile) ||
                old.postimageSHA256 !== next.postimageSHA256)
            )
              throw new SimpleFailure('stale')
            if (!old.profile && next.phase === 'abandoned' && next.profile)
              throw new SimpleFailure('invalid')
          }
          return next
        },
        assertCurrent
      )
    } catch (error) {
      // A caller with an existing lease must not treat an unexpectedly missing
      // or replaced marker as a fresh journal. It remains an unresolved write.
      if (expectedRevision && error instanceof SimpleFailure && error.code === 'stale')
        throw new SimpleFailure('uncertain')
      throw error
    }
  }
}
