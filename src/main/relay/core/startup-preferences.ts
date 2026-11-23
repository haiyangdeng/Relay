import type { RelayStateContext } from '../context'
import { SimplePrivateDocumentFile } from '../simple/store'

interface StartupPreferences {
  systemProxy: boolean
  profileId?: string
  selectors: [string, string][]
  otherSelectors?: [string, [string, string][]][]
}
const defaults = (): StartupPreferences => ({ systemProxy: false, selectors: [] })

export function createStartupPreferences(context: RelayStateContext) {
  const file = new SimplePrivateDocumentFile(context, 'core-startup.json', decode, defaults, 'core')
  let tail = Promise.resolve()
  function validSelectors(pairs: unknown): pairs is [string, string][] {
    return (
      Array.isArray(pairs) &&
      pairs.length <= 81 &&
      pairs.every(
        (pair) =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          pair.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 512)
      )
    )
  }
  function decode(input: unknown): StartupPreferences {
    if (!input || typeof input !== 'object') throw new Error('启动偏好无效。')
    const value = input as Partial<StartupPreferences>
    if (
      typeof value.systemProxy !== 'boolean' ||
      (value.profileId !== undefined && typeof value.profileId !== 'string') ||
      !validSelectors(value.selectors) ||
      (value.otherSelectors !== undefined &&
        (!Array.isArray(value.otherSelectors) ||
          !value.otherSelectors.every(
            (row) =>
              Array.isArray(row) &&
              row.length === 2 &&
              typeof row[0] === 'string' &&
              row[0] !== value.profileId &&
              validSelectors(row[1])
          )))
    )
      throw new Error('启动偏好无效。')
    return {
      systemProxy: value.systemProxy,
      profileId: value.profileId,
      selectors: value.selectors,
      ...(value.otherSelectors?.length ? { otherSelectors: value.otherSelectors } : {})
    }
  }
  function update(
    change: (previous: StartupPreferences) => StartupPreferences,
    assertCurrent: () => void = () => {},
    recheck?: () => Promise<void>
  ) {
    const next = tail.then(async () => {
      assertCurrent()
      const previous = await file.read()
      assertCurrent()
      const value = change(previous.value)
      if (JSON.stringify(value) !== JSON.stringify(previous.value))
        await file.change(previous.revision, () => value, assertCurrent, recheck)
    })
    tail = next.catch(() => {})
    return next
  }
  const read = async () => {
    await tail
    return (await file.read()).value
  }
  return {
    read,
    async selectors(profileId: string): Promise<Map<string, string>> {
      const value = await read()
      return new Map(
        value.profileId === profileId
          ? value.selectors
          : new Map(value.otherSelectors).get(profileId)
      )
    },
    systemProxy: (enabled: boolean) =>
      update((previous) => ({ ...previous, systemProxy: enabled })),
    select: (
      profileId: string,
      group: string,
      member?: string,
      assertCurrent?: () => void,
      recheck?: () => Promise<void>
    ) =>
      update(
        (previous) => {
          const others = new Map(previous.otherSelectors)
          const selectors = new Map(
            previous.profileId === profileId ? previous.selectors : others.get(profileId)
          )
          if (previous.profileId && previous.profileId !== profileId && previous.selectors.length)
            others.set(previous.profileId, previous.selectors)
          others.delete(profileId)
          if (member) selectors.set(group, member)
          else selectors.delete(group)
          return {
            systemProxy: previous.systemProxy,
            profileId,
            selectors: [...selectors],
            ...(others.size ? { otherSelectors: [...others] } : {})
          }
        },
        assertCurrent,
        recheck
      )
  }
}
