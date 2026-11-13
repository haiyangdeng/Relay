import { initReactI18next } from 'react-i18next'
import i18n, { initI18n } from '../../shared/i18n'
import { RELAY_PREVIEW_ONLY } from './components/relay/preview-controls'
import { getAppConfig } from './utils/ipc'

// 初始化 React i18next
i18n.use(initReactI18next)

// Bootstrap owns this promise: neither the config read nor i18next initialization
// may fail outside its error handler. Repeated callers share the same attempt.
let initialization: Promise<void> | undefined
export function initializeI18n(): Promise<void> {
  return (initialization ??= getAppConfig().then(async (config) => {
    await initI18n({ lng: config.language })
  }))
}

// 通知主进程语言变更
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
  document.documentElement.dir = i18n.dir(lng)
  if (RELAY_PREVIEW_ONLY) return
  void window.electron.ipcRenderer.invoke('changeLanguage', lng).catch(() => {
    console.warn('Unable to synchronize the interface language.')
  })
})

export default i18n
