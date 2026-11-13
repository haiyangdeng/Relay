import { useEffect, useRef, useState } from 'react'
import { Button, Switch, Tab, Tabs } from '@heroui/react'
import SettingCard from '@renderer/components/base/base-setting-card'
import type { ConfigurationEditRecord } from '../../../../shared/relay/configuration-edit'
import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import { relayProfileRead } from './profile-read-queue'
import { tunSettingsFields, updateTunSettings, type TunSettingsFields } from './tun-settings-model'

export function RelayTunSettingsEditor({
  active,
  busy,
  owned,
  onBusy,
  preferredProfileId,
  onChanged,
  onDirty
}: {
  active: boolean
  busy: boolean
  owned: boolean
  onBusy(value: boolean): void
  preferredProfileId?: string
  onChanged?(): void
  onDirty?(value: boolean): void
}): React.JSX.Element {
  const [record, setRecord] = useState<ConfigurationEditRecord>()
  const [profile, setProfile] = useState<RelayStoredProfile>()
  const [fields, setFields] = useState<TunSettingsFields>()
  const [loadedKey, setLoadedKey] = useState<string>()
  const [pending, setPending] = useState(false),
    [dirty, setDirty] = useState(false),
    [notice, setNotice] = useState('')
  useEffect(() => {
    onDirty?.(dirty)
  }, [dirty, onDirty])
  const latestProfileId = useRef(preferredProfileId)
  latestProfileId.current = preferredProfileId
  const operation = useRef(false),
    readFor = useRef<string | undefined>(undefined),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const read = async (): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    setPending(true)
    onBusy(true)
    try {
      const inventory = await relayProfileRead('relayProfileList')
      const selected = (await window.electron.ipcRenderer.invoke(
        'getProfileConfig'
      )) as IProfileConfig
      const source =
        inventory.profiles.find((item) => item.id === (preferredProfileId ?? selected.current)) ??
        inventory.profiles[0]
      if (!source) throw Error('没有配置')
      const saved = (await window.electron.ipcRenderer.invoke(
        'relayConfigEditRead'
      )) as ConfigurationEditRecord
      if (!mounted.current || latestProfileId.current !== preferredProfileId) return
      const preview = await relayProfileRead('relayConfigEditPreview', {
        profile: { id: source.id, sha256: source.sha256 },
        ...saved.document
      })
      if (mounted.current && latestProfileId.current === preferredProfileId) {
        const dns = preview.configuration.dns
        setRecord(saved)
        setProfile(source)
        setFields(
          tunSettingsFields(
            preview.configuration.tun,
            !!dns && typeof dns === 'object' && 'enable' in dns && dns.enable === true
          )
        )
        setLoadedKey(preferredProfileId ?? '')
        setDirty(false)
        setNotice('')
      }
    } catch {
      if (mounted.current && latestProfileId.current === preferredProfileId) {
        setRecord(undefined)
        setNotice('TUN 配置读取未完成，请刷新后重试。')
      }
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    if (!active) {
      readFor.current = undefined
      return
    }
    const key = preferredProfileId ?? ''
    if (!busy && !pending && !operation.current && !dirty && readFor.current !== key) {
      readFor.current = key
      void readRef.current()
    }
  }, [active, busy, preferredProfileId, dirty, pending])
  const stale = loadedKey !== (preferredProfileId ?? '')
  const save = async (): Promise<void> => {
    if (operation.current || busy || !fields || !record || !profile || owned || stale) return
    operation.current = true
    setPending(true)
    onBusy(true)
    let sent = false
    try {
      const document = updateTunSettings(record.document, profile.id, fields)
      sent = true
      const result = (await window.electron.ipcRenderer.invoke('relayConfigEditSave', {
        document,
        expectedRevision: record.revision
      })) as ConfigurationEditRecord
      onChanged?.()
      if (mounted.current && latestProfileId.current === preferredProfileId) {
        setRecord(result)
        setDirty(false)
        setNotice('已保存。完整配置检查通过后可启用 TUN。')
      }
    } catch (error) {
      if (mounted.current && latestProfileId.current === preferredProfileId) {
        if (sent) setRecord(undefined)
        setNotice(
          sent
            ? '保存结果未确认，请刷新后核对。'
            : error instanceof Error
              ? error.message
              : '设置格式无效。'
        )
      }
      if (sent) onChanged?.()
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const update = (patch: Partial<TunSettingsFields>): void => {
    if (fields) {
      setFields({ ...fields, ...patch })
      setDirty(true)
    }
  }
  const locked = busy || pending || owned || !record || stale
  return (
    <SettingCard>
      <div className="relay-network-toolbar">
        <h2>TUN 设置{profile ? ` · ${profile.name}` : ''}</h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="light"
            isDisabled={busy || pending || (dirty && !!record && !stale)}
            onPress={() => void read()}
          >
            {dirty && (!record || stale) ? '放弃修改并刷新' : '刷新设置'}
          </Button>
          <Button
            size="sm"
            color="primary"
            isDisabled={locked || !dirty}
            isLoading={pending}
            onPress={() => void save()}
          >
            保存设置
          </Button>
        </div>
      </div>
      {dirty && stale && <p>所选配置已变化，请放弃旧草稿后读取。</p>}
      {fields && !stale && (
        <fieldset disabled={locked}>
          <div className="relay-setting-row">
            <span>自动设置系统 DNS</span>
            <Switch
              size="sm"
              aria-label="TUN 自动设置系统 DNS"
              isSelected={fields.dnsMode === 'native' || fields.dnsMode === 'hijack'}
              isDisabled={locked}
              onValueChange={(enabled) => update({ dnsMode: enabled ? 'native' : 'disabled' })}
            />
          </div>
          {fields.dnsMode !== 'disabled' && (
            <p className="relay-network-state">
              随本次 TUN 会话设置并恢复系统 DNS；需启用配置内 DNS 并通过路由检查。
            </p>
          )}
          <div className="relay-setting-row">
            <span>TUN 模式堆栈</span>
            <Tabs
              size="sm"
              color="primary"
              aria-label="TUN 协议栈"
              selectedKey={fields.stack}
              isDisabled={locked}
              onSelectionChange={(key) => update({ stack: String(key) })}
            >
              <Tab key="gvisor" title="gVisor" />
              <Tab key="mixed" title="Mixed" />
              <Tab key="system" title="System" />
              {!['gvisor', 'mixed', 'system'].includes(fields.stack) && (
                <Tab key={fields.stack} title={`${fields.stack}（需核对）`} />
              )}
            </Tabs>
          </div>
          <div className="relay-setting-row">
            <span>网卡名称</span>
            <input
              aria-label="TUN 网卡名称"
              value={fields.device}
              onChange={(e) => update({ device: e.target.value })}
            />
          </div>
          <div className="relay-setting-row">
            <span>自动设置路由</span>
            <Switch
              size="sm"
              aria-label="TUN 自动设置路由"
              isSelected={fields.autoRoute}
              isDisabled={locked}
              onValueChange={(enabled) => update({ autoRoute: enabled })}
            />
          </div>
          <div className="relay-setting-row">
            <span>自动选择出口网卡</span>
            <Switch
              size="sm"
              aria-label="TUN 自动选择出口网卡"
              isSelected={fields.autoDetect}
              isDisabled={locked}
              onValueChange={(enabled) => update({ autoDetect: enabled })}
            />
          </div>
          <div className="relay-setting-row">
            <span>严格路由</span>
            <Switch
              size="sm"
              aria-label="TUN 严格路由"
              isSelected={fields.strictRoute}
              isDisabled={locked}
              onValueChange={(enabled) => update({ strictRoute: enabled })}
            />
          </div>
          <div className="relay-setting-row">
            <span>MTU</span>
            <input
              aria-label="TUN MTU"
              type="number"
              min={1280}
              max={65535}
              value={fields.mtu}
              onChange={(e) => update({ mtu: Number(e.target.value) })}
            />
          </div>
          <div className="relay-setting-row">
            <span>DNS 劫持</span>
            <input
              aria-label="TUN DNS 劫持"
              value={fields.dnsHijack.join(',')}
              placeholder="any:53"
              onChange={(e) =>
                update({
                  dnsHijack: e.target.value.split(',')
                })
              }
            />
          </div>
          <label>
            排除网段（每行一项）
            <textarea
              aria-label="TUN 排除网段"
              rows={3}
              value={fields.exclude.join('\n')}
              onChange={(e) =>
                update({
                  exclude: e.target.value.split('\n')
                })
              }
            />
          </label>
        </fieldset>
      )}
      {owned && <p>停用当前 TUN 后可修改下次启用的设置。</p>}
      {notice && <p role="status">{notice}</p>}
    </SettingCard>
  )
}
