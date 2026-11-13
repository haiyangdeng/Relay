import { useMemo } from 'react'
import type { RelaySimplePublicationIpcApi } from '../../../../shared/relay/simple-publication'
import type { RelaySimpleSourcesIpcApi } from '../../../../shared/relay/simple-sources'
import type { RelaySimpleIpcApi } from '../../../../shared/relay/simple'
import type { RelaySimpleConfigurationIpcApi } from '../../../../shared/relay/simple-configuration'
import type { RelayProfileSaveResult } from '../../../../shared/relay/profiles'
import type { SimpleModule } from '../../../../shared/simple-config'
import type { SimplePanelSourcesAdapter } from './simple-panel-state'
import { RelaySimplePanel } from './simple-panel'
import { createSimpleEditorScope } from './simple-scope'

const simpleApi: RelaySimpleIpcApi = {
  relaySimpleReadEditableDraft: () =>
    window.electron.ipcRenderer.invoke('relaySimpleReadEditableDraft'),
  relaySimpleSaveModule: (request) =>
    window.electron.ipcRenderer.invoke('relaySimpleSaveModule', request),
  relaySimplePreview: (revision) =>
    window.electron.ipcRenderer.invoke('relaySimplePreview', revision),
  relaySimplePrepareProfile: (request) =>
    window.electron.ipcRenderer.invoke('relaySimplePrepareProfile', request),
  relaySimpleRecover: () => window.electron.ipcRenderer.invoke('relaySimpleRecover')
}
const sourcesAdapter: SimplePanelSourcesAdapter = {
  relaySimpleReadSourceBindings: () =>
    window.electron.ipcRenderer.invoke('relaySimpleReadSourceBindings') as ReturnType<
      RelaySimpleSourcesIpcApi['relaySimpleReadSourceBindings']
    >,
  relaySimpleSaveSourceBinding: (request) =>
    window.electron.ipcRenderer.invoke('relaySimpleSaveSourceBinding', request) as ReturnType<
      RelaySimpleSourcesIpcApi['relaySimpleSaveSourceBinding']
    >,
  listProfiles: () => window.electron.ipcRenderer.invoke('relayProfileList'),
  listSources: () => window.electron.ipcRenderer.invoke('relaySourceList')
}
const configurationApi: RelaySimpleConfigurationIpcApi = {
  relaySimpleReadConfigurationBinding: () =>
    window.electron.ipcRenderer.invoke('relaySimpleReadConfigurationBinding'),
  relaySimpleSaveConfigurationBinding: (request) =>
    window.electron.ipcRenderer.invoke('relaySimpleSaveConfigurationBinding', request)
}
const publicationApi: RelaySimplePublicationIpcApi = {
  relaySimplePublicationState: () =>
    window.electron.ipcRenderer.invoke('relaySimplePublicationState') as ReturnType<
      RelaySimplePublicationIpcApi['relaySimplePublicationState']
    >,
  relaySimplePublicationPrepare: (request) =>
    window.electron.ipcRenderer.invoke('relaySimplePublicationPrepare', request) as ReturnType<
      RelaySimplePublicationIpcApi['relaySimplePublicationPrepare']
    >,
  relaySimplePublicationConfirm: (request) =>
    window.electron.ipcRenderer.invoke('relaySimplePublicationConfirm', request) as ReturnType<
      RelaySimplePublicationIpcApi['relaySimplePublicationConfirm']
    >,
  relaySimplePublicationRecover: () =>
    window.electron.ipcRenderer.invoke('relaySimplePublicationRecover') as ReturnType<
      RelaySimplePublicationIpcApi['relaySimplePublicationRecover']
    >,
  relaySimplePublicationAbandon: (request) =>
    window.electron.ipcRenderer.invoke('relaySimplePublicationAbandon', request) as ReturnType<
      RelaySimplePublicationIpcApi['relaySimplePublicationAbandon']
    >
}
const saveProfile = async (request: { evidenceId: string }): Promise<RelayProfileSaveResult> =>
  (await window.electron.ipcRenderer.invoke('relayProfileSave', request)) as RelayProfileSaveResult

export function RelaySimpleEditor({
  busy,
  onBusy,
  initialModule
}: {
  busy: boolean
  onBusy(busy: boolean): void
  initialModule?: SimpleModule
}): React.JSX.Element {
  const scope = useMemo(
    () =>
      createSimpleEditorScope({
        isVisible: () => document.visibilityState === 'visible',
        onInvalidated: (listener) =>
          window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', listener),
        onRestored: (listener) => window.electron.ipcRenderer.on('relayDataRestored', listener),
        onVisibilityChanged: (listener) => {
          document.addEventListener('visibilitychange', listener)
          return () => document.removeEventListener('visibilitychange', listener)
        }
      }),
    []
  )
  return (
    <RelaySimplePanel
      api={simpleApi}
      sources={sourcesAdapter}
      configuration={configurationApi}
      publication={publicationApi}
      saveProfile={saveProfile}
      scope={scope}
      busy={busy}
      onBusy={onBusy}
      initialModule={initialModule}
    />
  )
}
