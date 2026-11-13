import { validateGuardReadiness, type RelayGuardReadiness } from '../../shared/relay/guard'

// Explicit, single-flight read. No cached previous success after a failed read,
// startup work, extension activation or paths supplied by the renderer.
export function createGuardReadinessService(read: () => Promise<RelayGuardReadiness>) {
  let reading: Promise<RelayGuardReadiness> | undefined
  return {
    read(raw?: unknown): Promise<RelayGuardReadiness> {
      if (raw !== undefined) throw new Error('保护构建检查不接受路径或参数。')
      if (!reading)
        reading = Promise.resolve()
          .then(read)
          .then(validateGuardReadiness)
          .finally(() => {
            reading = undefined
          })
      return reading.then((report) => structuredClone(report))
    }
  }
}
