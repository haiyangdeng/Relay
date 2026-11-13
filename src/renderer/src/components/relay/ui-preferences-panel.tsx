import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SIDER_CARD_LABELS } from '@renderer/utils/sider'
import { relayUpstreamReferences } from '../../../../shared/relay/upstream-reference'
import {
  isRelayAppLogSizeMiB,
  readRelayAppLogSizeRecord,
  readUIPreferencesState,
  relayAppLogSize,
  relayInterfaceLanguages,
  relayLanguageNames,
  relayProxyColumns,
  relaySidebarCards,
  relaySidebarCardSizes,
  type RelayAppLogSizeRecord,
  type RelayUIPreferencesState,
  type RelayUIPreferences
} from '../../../../shared/relay/ui-preferences'

const proxyColumnLabels: Record<RelayUIPreferences['proxyCols'], string> = {
  auto: 'mihomo.proxyColumns.auto',
  '1': 'mihomo.proxyColumns.one',
  '2': 'mihomo.proxyColumns.two',
  '3': 'mihomo.proxyColumns.three',
  '4': 'mihomo.proxyColumns.four'
}
const sidebarSizeLabels: Record<CardStatus, string> = {
  'col-span-1': 'sider.size.small',
  'col-span-2': 'sider.size.large',
  hidden: 'sider.size.hidden'
}
export function RelayUIPreferencesPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const { t } = useTranslation(),
    [state, setState] = useState<RelayUIPreferencesState>(),
    [draft, setDraft] = useState<RelayUIPreferences>(),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    [appLog, setAppLog] = useState<RelayAppLogSizeRecord>(),
    [appLogDraft, setAppLogDraft] = useState(''),
    [appLogNotice, setAppLogNotice] = useState(''),
    operation = useRef(false)
  const logSizeMiB = Number(appLogDraft)
  const run = async (save = false): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    try {
      const next = readUIPreferencesState(
        await window.electron.ipcRenderer.invoke(
          save ? 'relayUIPreferencesSave' : 'relayUIPreferencesRead',
          ...(save ? [{ value: draft, revision: state?.revision }] : [])
        )
      )
      setState(next)
      setDraft(next.value)
      setNotice(save ? '已保存本地界面偏好。' : '已读取本地界面偏好。')
    } catch {
      setNotice('偏好结果未确认，请重新读取；没有覆盖损坏或外部改动的文件。')
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const runAppLog = async (save = false): Promise<void> => {
    if (busy || operation.current || (save && (!appLog || !isRelayAppLogSizeMiB(logSizeMiB))))
      return
    operation.current = true
    setPending(true)
    onBusy(true)
    try {
      const next = readRelayAppLogSizeRecord(
        await window.electron.ipcRenderer.invoke(
          save ? 'relayAppLogSizeSave' : 'relayAppLogSizeRead',
          ...(save ? [{ revision: appLog?.revision, sizeMiB: logSizeMiB }] : [])
        )
      )
      setAppLog(next)
      setAppLogDraft(String(next.sizeMiB))
      setAppLogNotice(save ? '已保存应用日志文件上限。' : '已读取应用日志文件上限。')
    } catch {
      setAppLog(undefined)
      setAppLogNotice('应用日志偏好未确认，请重新读取。')
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const openReference = async (
    id: (typeof relayUpstreamReferences)[number]['id']
  ): Promise<void> => {
    if (busy || operation.current) return
    operation.current = true
    setPending(true)
    setNotice('')
    try {
      await window.electron.ipcRenderer.invoke('relayOpenUpstreamReference', id)
    } catch {
      setNotice('未能在默认浏览器中打开上游参考。')
    } finally {
      operation.current = false
      setPending(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>{t('settings.language')} / 本地界面偏好</h2>
      <p>Clash Party 上游参考在默认浏览器中打开。</p>
      <div className="relay-action">
        {relayUpstreamReferences.map(({ id, label }) => (
          <button key={id} disabled={busy || pending} onClick={() => void openReference(id)}>
            {t(label)}
          </button>
        ))}
      </div>
      <p>
        语言使用内置五语言资源，覆盖已有上游页面与导航。Relay专有工作区文案目前保留中文；不会调整系统语言、网络或Claude配置。
      </p>
      <button disabled={busy || pending} onClick={() => void run()}>
        读取本地界面偏好
      </button>
      {draft && state && (
        <fieldset disabled={busy || pending || state.uncertain || !state.initialized}>
          <label>
            {t('settings.language')}
            <select
              value={draft.language}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  language: event.target.value as RelayUIPreferences['language']
                })
              }
            >
              {relayInterfaceLanguages.map((language) => (
                <option key={language} value={language}>
                  {relayLanguageNames[language]}
                </option>
              ))}
            </select>
          </label>
          {(['disableAnimations', 'rememberSelectedSiderCard', 'lockSiderCards'] as const).map(
            (key) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={draft[key]}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })}
                />
                {t('settings.' + key)}
              </label>
            )
          )}
          <label>
            {t('mihomo.proxyColumns.title')}
            <select
              value={draft.proxyCols}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  proxyCols: event.target.value as RelayUIPreferences['proxyCols']
                })
              }
            >
              {relayProxyColumns.map((columns) => (
                <option key={columns} value={columns}>
                  {t(proxyColumnLabels[columns])}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>{t('sider.title')}</summary>
            {relaySidebarCards.map((id) => (
              <label key={id}>
                {t(SIDER_CARD_LABELS[id])}
                <select
                  value={draft.siderCardLayout[id]}
                  onChange={(event) => {
                    const size = relaySidebarCardSizes.find(
                      (choice) => choice === event.target.value
                    )
                    if (size)
                      setDraft({
                        ...draft,
                        siderCardLayout: { ...draft.siderCardLayout, [id]: size }
                      })
                  }}
                >
                  {relaySidebarCardSizes.map((size) => (
                    <option key={size} value={size}>
                      {t(sidebarSizeLabels[size])}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </details>
          <button onClick={() => void run(true)}>{t('common.save')}</button>
        </fieldset>
      )}
      {notice && <p role="status">{notice}</p>}
      <h3>应用日志大小</h3>
      <p>限制单个 Relay 应用诊断日志。下次写入时按上限保留近期日志。</p>
      <button disabled={busy || pending} onClick={() => void runAppLog()}>
        读取应用日志上限
      </button>
      {appLog && (
        <fieldset disabled={busy || pending}>
          <label>
            文件上限（MiB）
            <input
              type="number"
              min={relayAppLogSize.min}
              max={relayAppLogSize.max}
              step={1}
              value={appLogDraft}
              onChange={(event) => setAppLogDraft(event.target.value)}
            />
          </label>
          <button
            disabled={!isRelayAppLogSizeMiB(logSizeMiB) || logSizeMiB === appLog.sizeMiB}
            onClick={() => void runAppLog(true)}
          >
            保存应用日志上限
          </button>
        </fieldset>
      )}
      {appLogNotice && <p role="status">{appLogNotice}</p>}
    </section>
  )
}
