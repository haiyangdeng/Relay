import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import {
  validateCoreSelectionSnapshot,
  type CoreSelectionSnapshot
} from '../../../shared/relay/lifecycle'
import type { ProfileStore } from '../profiles/store'

export function createCoreSelectionService(adapters: {
  profiles: Pick<ProfileStore, 'read'>
  read(): Promise<CoreSelectionSnapshot>
  save(selection: RelayProfileSelection, revision: string): Promise<CoreSelectionSnapshot>
  defaults?(): Promise<RelayProfileSelection[]>
}) {
  let writing = false
  const preferred = async (
    snapshot: CoreSelectionSnapshot
  ): Promise<RelayProfileSelection | undefined> => {
    if (snapshot.selection) {
      try {
        await adapters.profiles.read(snapshot.selection)
        return { ...snapshot.selection }
      } catch {
        // A removed/changed immutable profile cannot be restored by identity.
        // Native preference/permission failures occur before this fallback.
      }
    }
    for (const candidate of (await adapters.defaults?.()) ?? []) {
      const selection = profileSelection(candidate)
      try {
        await adapters.profiles.read(selection)
        return selection
      } catch {
        // Inventory may have changed; never start an unverified candidate.
      }
    }
    return undefined
  }
  return {
    async read(): Promise<RelayProfileSelection | undefined> {
      const report = validateCoreSelectionSnapshot(await adapters.read())
      if (report.selection) await adapters.profiles.read(report.selection)
      return report.selection ? { ...report.selection } : undefined
    },
    async readPreferred(): Promise<RelayProfileSelection | undefined> {
      return preferred(validateCoreSelectionSnapshot(await adapters.read()))
    },
    async resolveStartup(current: () => void): Promise<RelayProfileSelection | undefined> {
      current()
      const snapshot = validateCoreSelectionSnapshot(await adapters.read())
      current()
      const selection = await preferred(snapshot)
      current()
      if (
        !selection ||
        (selection.id === snapshot.selection?.id && selection.sha256 === snapshot.selection.sha256)
      )
        return selection
      if (writing) throw new Error('启动来源偏好正在保存，请等待结束。')
      writing = true
      try {
        // Use the revision captured before resolving the fallback, so a newer
        // manual choice cannot be overwritten while its inventory was read.
        const source = await adapters.profiles.read(selection)
        current()
        const saved = validateCoreSelectionSnapshot(
          await adapters.save(selection, snapshot.revision)
        )
        current()
        if (
          saved.selection?.id !== selection.id ||
          saved.selection.sha256 !== selection.sha256 ||
          (await adapters.profiles.read(selection)).revision !== source.revision
        )
          throw new Error('默认配置保存未确认。')
        current()
        return selection
      } finally {
        writing = false
      }
    },
    async remember(raw: RelayProfileSelection): Promise<void> {
      const selection = profileSelection(raw)
      if (writing) throw new Error('启动来源偏好正在保存，请等待结束。')
      writing = true
      try {
        const source = await adapters.profiles.read(selection),
          snapshot = validateCoreSelectionSnapshot(await adapters.read())
        const saved = validateCoreSelectionSnapshot(
          await adapters.save(selection, snapshot.revision)
        )
        if (
          saved.selection?.id !== selection.id ||
          saved.selection.sha256 !== selection.sha256 ||
          (await adapters.profiles.read(selection)).revision !== source.revision
        )
          throw new Error()
      } catch {
        throw new Error('启动来源偏好保存未确认，请重读核对；不回滚或重启已运行核心。')
      } finally {
        writing = false
      }
    }
  }
}
