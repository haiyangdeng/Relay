import { useEffect, useRef, useState } from 'react'
import { Button, Switch } from '@heroui/react'
import SettingCard from '@renderer/components/base/base-setting-card'
import type { ConfigurationEditRecord } from '../../../../shared/relay/configuration-edit'
import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import { relayProfileRead } from './profile-read-queue'
import {
  coreSettingsFields,
  updateCoreSettings,
  type CoreSettingsFields
} from './core-settings-model'

export function RelayCoreSettingsEditor({
  profile,
  active,
  busy,
  owned,
  onBusy,
  onChanged
}: {
  profile?: RelayStoredProfile
  active: boolean
  busy: boolean
  owned: boolean
  onBusy?(value: boolean): void
  onChanged?(): void
}): React.JSX.Element {
  const [record, setRecord] = useState<ConfigurationEditRecord>()
  const [fields, setFields] = useState<CoreSettingsFields>()
  const [loadedKey, setLoadedKey] = useState('')
  const [pending, setPending] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [notice, setNotice] = useState('')
  const key = profile ? `${profile.id}:${profile.sha256}` : ''
  const latestKey = useRef(key)
  latestKey.current = key
  const operation = useRef(false),
    attempted = useRef<string | undefined>(undefined),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const read = async (): Promise<void> => {
    if (!profile || operation.current || busy) return
    operation.current = true
    setPending(true)
    onBusy?.(true)
    try {
      const saved = (await window.electron.ipcRenderer.invoke(
        'relayConfigEditRead'
      )) as ConfigurationEditRecord
      if (!mounted.current || latestKey.current !== key) return
      const preview = await relayProfileRead('relayConfigEditPreview', {
        ...saved.document,
        profile: { id: profile.id, sha256: profile.sha256 }
      })
      if (!mounted.current || latestKey.current !== key) return
      setFields(coreSettingsFields(preview.configuration))
      setRecord(saved)
      setLoadedKey(key)
      setDirty(false)
      setNotice('')
    } catch {
      if (mounted.current && latestKey.current === key) {
        setRecord(undefined)
        setNotice('内核设置读取未完成，请刷新重试。')
      }
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy?.(false)
    }
  }
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    if (!active) {
      attempted.current = undefined
      return
    }
    if (key && !busy && !pending && !dirty && attempted.current !== key) {
      attempted.current = key
      void readRef.current()
    }
  }, [active, key, busy, pending, dirty])
  const stale = loadedKey !== key
  const locked = busy || pending || owned || !record || stale
  const save = async (): Promise<void> => {
    if (operation.current || locked || !profile || !record || !fields || !dirty) return
    operation.current = true
    setPending(true)
    onBusy?.(true)
    let sent = false
    try {
      const document = updateCoreSettings(record.document, profile.id, fields)
      sent = true
      const saved = (await window.electron.ipcRenderer.invoke('relayConfigEditSave', {
        document,
        expectedRevision: record.revision
      })) as ConfigurationEditRecord
      onChanged?.()
      if (mounted.current && latestKey.current === key) {
        setRecord(saved)
        setDirty(false)
        setNotice('已保存，下次启用所选配置时生效。')
      }
    } catch (error) {
      if (sent) onChanged?.()
      if (mounted.current && latestKey.current === key) {
        if (sent) setRecord(undefined)
        setNotice(
          sent
            ? '保存结果未确认，请刷新核对。'
            : error instanceof Error
              ? error.message
              : '设置格式无效。'
        )
      }
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy?.(false)
    }
  }
  const update = (patch: Partial<CoreSettingsFields>): void => {
    if (fields && !locked) {
      setFields({ ...fields, ...patch })
      setDirty(true)
    }
  }
  return (
    <SettingCard>
      <div className="relay-network-toolbar">
        <h2>内核通用设置</h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="light"
            isDisabled={busy || pending || !profile || (dirty && !!record && !stale)}
            onPress={() => void read()}
          >
            {dirty && (!record || stale) ? '放弃修改并读取' : '刷新设置'}
          </Button>
          <Button
            size="sm"
            color="primary"
            isDisabled={locked || !dirty}
            onPress={() => void save()}
          >
            保存设置
          </Button>
        </div>
      </div>
      {fields && !stale ? (
        <>
          <div className="relay-setting-row">
            <span>IPv6</span>
            <Switch
              size="sm"
              aria-label="内核 IPv6"
              isDisabled={locked}
              isSelected={fields.ipv6}
              onValueChange={(value) => update({ ipv6: value })}
            />
          </div>
          <div className="relay-setting-row">
            <span>使用 1-RTT 延迟测试</span>
            <Switch
              size="sm"
              aria-label="使用 1-RTT 延迟测试"
              isDisabled={locked}
              isSelected={fields.unifiedDelay}
              onValueChange={(value) => update({ unifiedDelay: value })}
            />
          </div>
          <div className="relay-setting-row">
            <span>TCP 并发</span>
            <Switch
              size="sm"
              aria-label="TCP 并发"
              isDisabled={locked}
              isSelected={fields.tcpConcurrent}
              onValueChange={(value) => update({ tcpConcurrent: value })}
            />
          </div>
          <div className="relay-setting-row">
            <span>进程识别</span>
            <select
              aria-label="进程识别"
              value={fields.findProcessMode}
              disabled={locked}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'off' || value === 'strict' || value === 'always')
                  update({ findProcessMode: value })
              }}
            >
              <option value="strict">严格</option>
              <option value="off">关闭</option>
              <option value="always">始终</option>
            </select>
          </div>
          <p className="relay-network-state">
            IPv6 与 TCP 并发用于所有配置，其余设置用于上方所选配置。IPv6 随配置内 DNS 一同启用。
          </p>
        </>
      ) : (
        <p className="relay-network-state">
          {!profile
            ? '导入配置后可编辑。'
            : dirty
              ? '所选配置已变化，请放弃旧草稿后读取。'
              : '正在读取所选配置的设置。'}
        </p>
      )}
      {owned && <p className="relay-network-state">停止当前代理后可修改下次启动的设置。</p>}
      {notice && <p role="status">{notice}</p>}
    </SettingCard>
  )
}
