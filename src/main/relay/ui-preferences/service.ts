import { SimplePrivateDocumentFile, type SimpleFileRecord } from '../simple/store'
import type { RelayStateContext } from '../context'
import {
  defaultUIPreferences,
  isRelayAppLogSizeMiB,
  readRelayAppLogSizeRecord,
  relayAppLogSize,
  relayConnectionSortPreferenceKeys,
  relayProxyDisplayPreferenceKeys,
  uiPreferences,
  type RelayAppLogSizeRecord,
  type RelayUIPreferences,
  type RelayUIPreferencesState
} from '../../../shared/relay/ui-preferences'

export function createUIPreferencesService(
  context: RelayStateContext,
  notify: () => void,
  applyAppLogSize: (sizeMiB: number) => void = () => {}
) {
  const file = new SimplePrivateDocumentFile(
    context,
    'ui-preferences.json',
    (raw) => uiPreferences(raw, 'stored'),
    defaultUIPreferences
  )
  // Keep the original UI preferences readable by earlier Relay builds.
  const appLog = new SimplePrivateDocumentFile(
    context,
    'app-log-preferences.json',
    (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('应用日志偏好无效。')
      const value = raw as Record<string, unknown>
      if (
        Object.keys(value).sort().join(',') !== 'sizeMiB,version' ||
        value.version !== 1 ||
        !isRelayAppLogSizeMiB(value.sizeMiB)
      )
        throw new Error('应用日志偏好无效。')
      return { version: 1, sizeMiB: value.sizeMiB }
    },
    () => ({ version: 1, sizeMiB: relayAppLogSize.default })
  )
  let record: SimpleFileRecord<RelayUIPreferences> = {
      value: defaultUIPreferences(),
      revision: '',
      exists: false
    },
    initialized = false,
    pending = false,
    uncertain = false
  const waiters: (() => void)[] = []
  const state = (): RelayUIPreferencesState => ({
    ...structuredClone(record),
    initialized,
    pending,
    uncertain
  })
  const finish = () => {
    pending = false
    waiters.splice(0).forEach((resolve) => resolve())
    notify()
  }
  const save = async (
    raw: unknown,
    expectedRevision: unknown,
    assertCurrent: () => void
  ): Promise<RelayUIPreferencesState> => {
    const next = uiPreferences(raw)
    if (!initialized || pending || uncertain || expectedRevision !== record.revision)
      throw new Error('请重新读取本地界面偏好。')
    pending = true
    try {
      assertCurrent()
      record = await file.change(record.revision, () => next, assertCurrent)
      return { ...state(), pending: false }
    } catch (error) {
      uncertain = true
      throw error
    } finally {
      finish()
    }
  }
  const readOrSaveAppLog = async (
    assertCurrent: () => void,
    save?: RelayAppLogSizeRecord,
    recheck?: () => Promise<void>
  ): Promise<RelayAppLogSizeRecord> => {
    if (pending) throw new Error('本地偏好操作尚未结束。')
    pending = true
    try {
      assertCurrent()
      if (save) await recheck?.()
      const result = save
        ? await appLog.change(
            save.revision,
            () => ({ version: 1, sizeMiB: save.sizeMiB }),
            assertCurrent,
            recheck
          )
        : await appLog.read()
      if (!save) assertCurrent()
      applyAppLogSize(result.value.sizeMiB)
      return { sizeMiB: result.value.sizeMiB, revision: result.revision }
    } finally {
      finish()
    }
  }
  return {
    state,
    inspect: () => file.read(),
    isBusy: () => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    async initialize(assertCurrent: () => void = () => {}): Promise<RelayUIPreferencesState> {
      if (pending) throw new Error('界面偏好操作尚未结束。')
      pending = true
      try {
        assertCurrent()
        const current = await file.read()
        assertCurrent()
        record = current
        initialized = true
        uncertain = false
        return { ...state(), pending: false }
      } catch (error) {
        uncertain = true
        throw error
      } finally {
        finish()
      }
    },
    save,
    readAppLogSize: (assertCurrent: () => void = () => {}) => readOrSaveAppLog(assertCurrent),
    saveAppLogSize(
      raw: unknown,
      assertCurrent: () => void,
      recheck: () => Promise<void>
    ): Promise<RelayAppLogSizeRecord> {
      return readOrSaveAppLog(assertCurrent, readRelayAppLogSizeRecord(raw), recheck)
    },
    async patchView(raw: unknown, assertCurrent: () => void): Promise<void> {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('本地界面变更无效。')
      const patch = raw as Record<string, unknown>
      if (
        Object.keys(patch).length !== 1 ||
        !Object.keys(patch).every((key) =>
          [
            'siderWidth',
            'lastSelectedSiderCard',
            'siderOrder',
            'profileDisplayDate',
            ...relayProxyDisplayPreferenceKeys,
            ...relayConnectionSortPreferenceKeys
          ].includes(key)
        )
      )
        throw new Error('此入口只接受一项本地侧栏、代理显示、订阅日期或连接排序偏好。')
      await save({ ...record.value, ...patch }, record.revision, assertCurrent)
    }
  }
}
