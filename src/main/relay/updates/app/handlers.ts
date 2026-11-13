import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { APP_UPDATE_IPC_CHANNELS } from '../../../../shared/relay/app-updates'
import type { createAppUpdateService } from './service'

// Main must supply its existing authorized-window/frame guard. This registration
// function has no startup effect until called, and no default/Boolean bypass.
export function registerAppUpdateIPC(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  assertSender: (event: IpcMainInvokeEvent) => void,
  service: ReturnType<typeof createAppUpdateService>
): () => void {
  const noInput = (input: unknown): void => {
    if (input !== undefined) throw new Error('此应用更新动作不接受附加参数。')
  }
  const methods = {
    relayAppUpdateState: (input: unknown) => {
      noInput(input)
      return service.state()
    },
    relayAppUpdateCheck: (input: unknown) => service.check(input),
    relayAppUpdatePrepareDownload: (input: unknown) => service.prepareDownload(input),
    relayAppUpdateDownload: (input: unknown) => service.download(input),
    relayAppUpdatePrepareInstall: (input: unknown) => service.prepareInstall(input),
    relayAppUpdateInstall: (input: unknown) => service.install(input),
    relayAppUpdateRecover: (input: unknown) => {
      noInput(input)
      return service.recover(false)
    },
    relayAppUpdateDismiss: (input: unknown) => {
      noInput(input)
      return service.recover(true)
    },
    relayAppUpdateRemove: (input: unknown) => service.remove(input),
    relayAppUpdateCancel: (input: unknown) => {
      noInput(input)
      service.cancel()
      return { status: 'cancel-requested' }
    }
  }
  const registered: string[] = []
  try {
    for (const channel of APP_UPDATE_IPC_CHANNELS) {
      ipc.handle(channel, (event, input: unknown) => {
        assertSender(event)
        return methods[channel](input)
      })
      registered.push(channel)
    }
  } catch (error) {
    for (const channel of registered) ipc.removeHandler(channel)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const channel of registered) ipc.removeHandler(channel)
  }
}
