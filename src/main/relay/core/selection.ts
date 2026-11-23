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
}) {
  let writing = false
  return {
    async read(): Promise<RelayProfileSelection | undefined> {
      const report = validateCoreSelectionSnapshot(await adapters.read())
      if (report.selection) await adapters.profiles.read(report.selection)
      return report.selection ? { ...report.selection } : undefined
    },
    async readPreferred(): Promise<RelayProfileSelection | undefined> {
      const report = validateCoreSelectionSnapshot(await adapters.read())
      if (!report.selection) return undefined
      try {
        await adapters.profiles.read(report.selection)
        return { ...report.selection }
      } catch {
        return undefined // A removed source must not select an unrelated subscription.
      }
    },
    async remember(raw: RelayProfileSelection, ifEmpty?: () => void): Promise<void> {
      const selection = profileSelection(raw)
      if (writing) throw new Error('启动来源偏好正在保存，请等待结束。')
      writing = true
      try {
        const source = await adapters.profiles.read(selection),
          snapshot = validateCoreSelectionSnapshot(await adapters.read())
        ifEmpty?.()
        // A first-use choice may fill an empty preference, never replace a
        // concurrent explicit choice. Native save compares this same revision.
        if (ifEmpty && snapshot.selection) {
          if (
            snapshot.selection.id === selection.id &&
            snapshot.selection.sha256 === selection.sha256
          )
            return
          throw new Error()
        }
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
