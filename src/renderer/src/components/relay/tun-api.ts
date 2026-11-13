import {
  tunEvidenceRequest,
  tunSessionPreparation,
  tunSessionRequest,
  tunSessionResult,
  tunSessionState,
  tunStatus,
  type TunIpcApi
} from '../../../../shared/relay/tun'

export function createTunRendererApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown> = (channel, ...args) =>
    window.electron.ipcRenderer.invoke(channel, ...args)
): TunIpcApi {
  return {
    relayTunStatus: async () => tunStatus(await invoke('relayTunStatus')),
    relayTunPrepare: async (request) =>
      tunSessionPreparation(await invoke('relayTunPrepare', tunEvidenceRequest(request))),
    relayTunStart: async (request) =>
      tunSessionResult(await invoke('relayTunStart', tunEvidenceRequest(request))),
    relayTunStop: async (request) =>
      tunSessionResult(await invoke('relayTunStop', tunSessionRequest(request))),
    relayTunInspect: async () => tunSessionState(await invoke('relayTunInspect')),
    relayTunCancel: async (request) => {
      const result = await invoke('relayTunCancel', tunEvidenceRequest(request))
      if (result !== undefined && result !== null) throw new Error('TUN准备取消结果未确认。')
    }
  }
}
