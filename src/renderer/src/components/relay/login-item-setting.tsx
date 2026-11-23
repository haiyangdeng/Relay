import { Switch } from '@heroui/react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'
import type { RelayLoginItemResult, RelayLoginItemState } from '../../../../shared/relay/shell'

const readLoginItem = (): Promise<RelayLoginItemState> =>
  window.electron.ipcRenderer.invoke('relayLoginItemState')

export function RelayLoginItemSetting({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { data, error, mutate } = useSWR('relayLoginItemState', readLoginItem, {
    shouldRetryOnError: false,
    revalidateOnFocus: true,
    focusThrottleInterval: 0
  })
  const changing = useRef(false)
  const [notice, setNotice] = useState('')
  const refresh = async (): Promise<void> => {
    try {
      await mutate()
    } catch {
      setNotice('无法重新读取登录项，请重试。')
    }
  }
  const change = async (enabled: boolean): Promise<void> => {
    if (busy || changing.current || !data || error || data.configured === enabled) return
    changing.current = true
    onBusy(true)
    setNotice('')
    try {
      const result: RelayLoginItemResult = await window.electron.ipcRenderer.invoke(
        enabled ? 'enableAutoRun' : 'disableAutoRun'
      )
      if (result.status === 'cancelled') setNotice('操作已取消。')
      else if (result.warnings.length) setNotice(result.warnings.join(' '))
    } catch {
      setNotice('更改未确认，请核对当前状态后重试。')
    } finally {
      await refresh()
      changing.current = false
      onBusy(false)
    }
  }
  let detail = '登录当前 macOS 用户账户时自动打开 Relay。'
  if (error) detail = '无法读取登录项。'
  else if (!data) detail = '正在读取登录项…'
  else if (data.configured) {
    if (data.approval === 'requiresApproval')
      detail = '请在「系统设置 → 通用 → 登录项」中允许 Relay 的后台活动。'
    else if (data.approval === 'unknown') detail = '已设置开机自启动，系统许可尚未确认。'
    else if (data.approval !== 'enabled') detail = '登录项已写入，macOS 尚未确认登记。'
  }
  const label = t('settings.autoStart')
  return (
    <section className="relay-panel" aria-label={label}>
      <div className="relay-heading">
        <h2>{label}</h2>
        {data && !error && (
          <Switch
            size="sm"
            aria-label={label}
            aria-describedby="relay-login-item-status"
            isSelected={data.configured}
            isDisabled={busy}
            onValueChange={(enabled) => void change(enabled)}
          />
        )}
      </div>
      <p id="relay-login-item-status" role="status">
        {detail}
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <button disabled={busy} onClick={() => void refresh()}>
          重新读取登录项
        </button>
      )}
    </section>
  )
}
