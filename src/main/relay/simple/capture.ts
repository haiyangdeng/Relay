import { isDeepStrictEqual } from 'node:util'
import type { RelayStateContext } from '../context'
import { ProfileStore } from '../profiles/store'
import { profileHash } from '../profiles/source'
import { SubscriptionSourceStore } from '../subscriptions/source-store'
import {
  boundedJSON,
  clone,
  document,
  keys,
  revision,
  SimpleFailure,
  type SimpleRecord,
  type SimpleBinding
} from './model'
import { SimpleDraftStore } from './store'
import { createPinnedSimpleConfigurationReader } from './configuration'
import { snapshotInputs, type CapturedInputs, type SourceSnapshot } from './resolver'

const invalid = (): never => {
  throw new SimpleFailure('invalid')
}
const sameProfile = (
  a: { id: string; sha256: string },
  b: { id: string; sha256: string }
): boolean => a.id === b.id && a.sha256 === b.sha256

export type SimpleProfileSourceFacts = Omit<CapturedInputs['profiles'][number], 'bindingId'>

// Main-only fixed-store reader shared by existing capture and explicit binding admission.
export function createPinnedSimpleProfileSourceReader(context: RelayStateContext) {
  const location = Object.freeze({ home: context.home, stateRoot: context.stateRoot }),
    profiles = new ProfileStore(location),
    sources = new SubscriptionSourceStore(location)
  return async (
    binding: Pick<SimpleBinding, 'profile' | 'source'> & { profileRevision?: string },
    signal: AbortSignal,
    assertCurrent?: () => void
  ): Promise<SimpleProfileSourceFacts> => {
    const live = (): void => {
      if (signal.aborted) throw new SimpleFailure('cancelled')
      assertCurrent?.()
    }
    const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
      live()
      try {
        return await operation()
      } finally {
        live()
      }
    }
    try {
      const profile = await wait(() => profiles.read(binding.profile))
      if (
        (binding.profileRevision !== undefined && profile.revision !== binding.profileRevision) ||
        !sameProfile(profile.profile, binding.profile) ||
        profileHash(profile.text) !== binding.profile.sha256
      )
        throw new SimpleFailure('stale')
      let source: SourceSnapshot | undefined
      if (binding.source) {
        const stored = await wait(() => sources.read(binding.source))
        if (
          stored.info.locked ||
          !stored.info.versions.some((version) => sameProfile(version.profile, binding.profile))
        )
          throw new SimpleFailure('stale')
        if (
          Object.keys(stored.options.headers).some(
            (key) => !['user-agent', 'authorization'].includes(key)
          )
        )
          return invalid()
        // Pinned CURRENT origin intent plus historical membership, not acquisition credentials.
        source = {
          ...binding.source,
          profile: clone(binding.profile),
          url: stored.request.url,
          ...(Object.hasOwn(stored.options.headers, 'user-agent')
            ? { userAgent: stored.options.headers['user-agent'] }
            : {}),
          ...(Object.hasOwn(stored.options.headers, 'authorization')
            ? { authorization: stored.options.headers.authorization }
            : {}),
          ageSecretKey: stored.options.ageSecretKey
        }
      }
      live()
      return {
        profile: {
          selection: clone(binding.profile),
          revision: profile.revision,
          text: profile.text
        },
        ...(source ? { source } : {})
      }
    } catch (error) {
      live()
      throw error instanceof SimpleFailure ? error : new SimpleFailure('stale')
    }
  }
}

// Read-only fixed stores; no old Simple global getter/service, transfer, picker,
// renderer path, current/latest substitution or published-state modification.
export function createPinnedSimpleCapture(context: RelayStateContext) {
  const location = Object.freeze({ home: context.home, stateRoot: context.stateRoot }),
    simple = new SimpleDraftStore(location),
    readBinding = createPinnedSimpleProfileSourceReader(location),
    configurationReader = createPinnedSimpleConfigurationReader(location)
  return async (raw: SimpleRecord, signal: AbortSignal): Promise<CapturedInputs> => {
    const live = (): void => {
      if (signal.aborted) throw new SimpleFailure('cancelled')
    }
    const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
      live()
      try {
        return await operation()
      } finally {
        live()
      }
    }
    const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        live()
        return await operation()
      } catch (error) {
        live()
        throw error instanceof SimpleFailure ? error : new SimpleFailure('stale')
      }
    }
    return safe(async () => {
      boundedJSON(raw, 4 * 1024 * 1024, 2 * 1024 * 1024)
      keys(raw, ['document', 'revision', 'exists'])
      revision(raw.revision)
      if (typeof raw.exists !== 'boolean') return invalid()
      const expected: SimpleRecord = {
        revision: raw.revision,
        exists: raw.exists,
        document: document(raw.document)
      }
      const checkSimple = async (): Promise<void> => {
        const actual = await wait(() => simple.read())
        if (
          actual.revision !== expected.revision ||
          actual.exists !== expected.exists ||
          !isDeepStrictEqual(actual.document, expected.document)
        )
          throw new SimpleFailure('stale')
      }
      const readConfiguration = (): Promise<CapturedInputs['configuration']> =>
        configurationReader.readPinned(expected.document.configurationRevision.draft, signal)
      await checkSimple()
      const configuration = await readConfiguration(),
        captured: CapturedInputs['profiles'] = []
      const budget = (): void => {
        live()
        boundedJSON({ configuration, profiles: captured }, 4 * 1024 * 1024, 2 * 1024 * 1024)
      }
      budget()
      for (const binding of expected.document.bindings.draft) {
        const facts = await wait(() => readBinding(binding, signal))
        captured.push({ bindingId: binding.id, ...facts })
        budget()
      }
      const recheck = (): Promise<void> =>
        safe(async () => {
          await checkSimple()
          for (const binding of expected.document.bindings.draft)
            await wait(() => readBinding(binding, signal))
          if (!isDeepStrictEqual(await readConfiguration(), configuration))
            throw new SimpleFailure('stale')
          live()
        })
      await recheck()
      live()
      const immutable = snapshotInputs({ configuration, profiles: captured, recheck })
      live()
      return Object.freeze({ ...immutable, recheck })
    })
  }
}
