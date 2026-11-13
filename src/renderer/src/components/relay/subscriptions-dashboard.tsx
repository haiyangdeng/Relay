import {
  Button,
  Card,
  CardFooter,
  Chip,
  Spinner,
  Input,
  Popover,
  PopoverTrigger,
  PopoverContent
} from '@heroui/react'
import { useEffect, useRef, useState } from 'react'
import { IoMdRefresh } from 'react-icons/io'
import { FiClipboard, FiFolderPlus, FiSettings, FiSliders } from 'react-icons/fi'
import ProfileCardContent from '@renderer/components/profiles/profile-card-content'
import { errorMessage } from '@renderer/utils/error-message'
import type {
  RelayProfileInventory,
  RelayStoredProfile,
  RelayProfilePreparation,
  RelayProfileSaveResult
} from '../../../../shared/relay/profiles'
import type {
  SubscriptionSourceInfo,
  SubscriptionSourceInventory,
  SubscriptionSourceResult
} from '../../../../shared/relay/subscription-sources'
import { relayProfileRead } from './profile-read-queue'
import { RelayProfileCardMenu } from './profile-card-menu'
import {
  importDashboardSubscription,
  subscriptionDashboardEntries,
  updateDashboardSubscription,
  type SubscriptionDashboardOperation
} from './subscriptions-dashboard-model'
import './subscriptions-dashboard.css'

interface Props {
  active?: boolean
  inventory?: RelayProfileInventory
  currentSelection?: string | null
  activeProfileId?: string
  busy: boolean
  onBusy(value: boolean): void
  onRefresh(): Promise<void>
  onChoose(profile: RelayStoredProfile): void | Promise<void>
  onBrowse(profile: RelayStoredProfile): void
  onAdvanced(): void
}

export function RelaySubscriptionsDashboard({
  active = true,
  inventory,
  currentSelection,
  activeProfileId,
  busy,
  onBusy,
  onRefresh,
  onChoose,
  onBrowse,
  onAdvanced
}: Props): React.JSX.Element {
  const [sources, setSources] = useState<SubscriptionSourceInventory>()
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [pendingSource, setPendingSource] = useState<string>()
  const [choosing, setChoosing] = useState<string>()
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [url, setURL] = useState('')
  const [port, setPort] = useState('7890')
  const mounted = useRef(true)
  const operating = useRef(false)
  const readAttempted = useRef(false)
  const cancelled = useRef(false)
  const ownedEvidence = useRef<string | undefined>(undefined)
  const generation = useRef(0)
  const refreshProfiles = useRef(onRefresh)
  refreshProfiles.current = onRefresh

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelled.current = true
    }
  }, [])

  const read = async (): Promise<void> => {
    const at = ++generation.current
    const value = await relayProfileRead('relaySourceList')
    await refreshProfiles.current()
    if (mounted.current && at === generation.current) setSources(value)
  }
  const refresh = async (): Promise<void> => {
    if (operating.current || busy) return
    operating.current = true
    onBusy(true)
    setLoading(true)
    try {
      await read()
      if (mounted.current) setNotice('')
    } catch {
      if (mounted.current) {
        setSources(undefined)
        setNotice('配置列表读取失败，请稍后刷新。')
      }
    } finally {
      operating.current = false
      onBusy(false)
      if (mounted.current) setLoading(false)
    }
  }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (!active) {
      readAttempted.current = false
      return
    }
    if (!busy && !readAttempted.current) {
      readAttempted.current = true
      void refreshRef.current()
    }
  }, [active, busy])

  const resultNotice = (result: SubscriptionSourceResult, registered: boolean): string => {
    if (result.status === 'saved') return '订阅已保存。点击卡片即可使用。'
    if (result.status === 'unchanged') return '订阅已是最新内容，配置保持不变。'
    if (result.status === 'cancelled')
      return registered
        ? '订阅地址已保存，后续下载已取消。可点击卡片上的更新按钮继续。'
        : '已取消本次操作。'
    return registered
      ? '订阅地址已保存，下载或保存配置未完成。请刷新后重试更新。'
      : '订阅更新未确认，请刷新列表核对。'
  }
  const run = async (source?: SubscriptionSourceInfo): Promise<void> => {
    if (operating.current || busy || loading) return
    const proxyPort = Number(port)
    if (
      !source &&
      (!url.trim() || !Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535)
    ) {
      setNotice('请填写订阅地址和有效的本地 HTTP 代理端口。')
      return
    }
    operating.current = true
    cancelled.current = false
    ownedEvidence.current = undefined
    setPending(true)
    setPendingSource(source?.id)
    onBusy(true)
    const operation: SubscriptionDashboardOperation = {
      invoke: (channel, input) => window.electron.ipcRenderer.invoke(channel, input),
      onPlan: (plan) => {
        ownedEvidence.current = plan.evidenceId
      },
      onProgress: (message) => {
        if (mounted.current) setNotice(message)
      },
      cancelled: () => cancelled.current || !mounted.current
    }
    try {
      if (source) {
        const result = await updateDashboardSubscription(operation, source)
        if (mounted.current) setNotice(resultNotice(result, false))
      } else {
        const outcome = await importDashboardSubscription(operation, {
          name: name.trim() || '新订阅',
          url: url.trim(),
          proxyPort
        })
        if (mounted.current) {
          setNotice(resultNotice(outcome.result, outcome.registered))
          if (outcome.registered) {
            setURL('')
            setName('')
          }
        }
      }
    } catch {
      if (mounted.current) setNotice('订阅操作未完成，请检查地址、代理端口或刷新列表后重试。')
    } finally {
      ownedEvidence.current = undefined
      try {
        if (mounted.current) await read()
      } catch {
        if (mounted.current) {
          setSources(undefined)
          setNotice('操作已返回，但列表未能刷新。请刷新列表核对结果。')
        }
      }
      operating.current = false
      onBusy(false)
      if (mounted.current) {
        setPending(false)
        setPendingSource(undefined)
      }
    }
  }
  const cancel = async (): Promise<void> => {
    cancelled.current = true
    const evidenceId = ownedEvidence.current
    if (!evidenceId) return
    try {
      const result = (await window.electron.ipcRenderer.invoke('relaySourceCancel', {
        evidenceId
      })) as { status: string }
      if (mounted.current)
        setNotice(
          result.status === 'busy' ? '保存已开始，正在等待结果。' : '已请求取消，正在收尾。'
        )
    } catch {
      if (mounted.current) setNotice('取消请求未确认，请等待当前操作结果。')
    }
  }
  const choose = async (profile: RelayStoredProfile): Promise<void> => {
    if (operating.current || busy || loading) return
    operating.current = true
    setChoosing(profile.id)
    try {
      await onChoose(profile)
      if (mounted.current) setNotice(`正在使用“${profile.name}”。`)
    } catch (error) {
      if (mounted.current) setNotice(errorMessage(error, '配置启用未确认，请核对当前状态后重试。'))
    } finally {
      operating.current = false
      if (mounted.current) setChoosing(undefined)
    }
  }
  const locked = busy || pending || loading || !!choosing
  const importLocal = async (): Promise<void> => {
    if (operating.current || locked) return
    operating.current = true
    cancelled.current = false
    onBusy(true)
    setPending(true)
    try {
      const prepared = (await window.electron.ipcRenderer.invoke('relayProfilePrepare')) as
        RelayProfilePreparation | undefined
      if (!prepared || cancelled.current) {
        setNotice('已取消导入。')
        return
      }
      if (prepared.inspection.structure !== 'passed') {
        setNotice(prepared.inspection.issues.join('；') || '配置格式检查未通过。')
        return
      }
      const result = (await window.electron.ipcRenderer.invoke('relayProfileSave', {
        evidenceId: prepared.evidenceId
      })) as RelayProfileSaveResult
      setNotice(
        result.status === 'saved'
          ? '本地配置已导入。点击卡片即可使用。'
          : result.status === 'cancelled'
            ? '已取消保存。'
            : '保存未确认，请刷新列表核对。'
      )
      if (result.status === 'saved' || result.status === 'uncertain') await read()
    } catch {
      setNotice('本地配置导入未完成，请检查文件后重试。')
    } finally {
      operating.current = false
      onBusy(false)
      if (mounted.current) setPending(false)
    }
  }
  const pasteURL = async (): Promise<void> => {
    try {
      setURL((await navigator.clipboard.readText()).trim())
      setNotice('')
    } catch {
      setNotice('未能读取剪贴板，请在地址栏直接粘贴。')
    }
  }
  const entries = subscriptionDashboardEntries(inventory?.profiles ?? [], sources?.sources ?? [])
  const primaryLocal =
    entries.localProfiles.find((profile) => profile.id === currentSelection) ??
    entries.localProfiles[0]
  const otherLocalProfiles = entries.localProfiles.filter(
    (profile) => profile.id !== primaryLocal?.id
  )
  const card = (
    profile: RelayStoredProfile | undefined,
    source?: SubscriptionSourceInfo
  ): React.JSX.Element => {
    const selected = !!profile && profile.id === currentSelection
    const running = !!profile && profile.id === activeProfileId
    const oldSelected =
      !!source && !selected && source.versions.some((v) => v.profile.id === currentSelection)
    const oldRunning =
      !!source && !running && source.versions.some((v) => v.profile.id === activeProfileId)
    const highlighted = selected || running || oldSelected || oldRunning
    const unavailable = !profile || source?.locked === true
    const quota = source?.observation?.quota
    const info: Pick<IProfileItem, 'name' | 'type' | 'updated' | 'extra'> = {
      name: source?.name ?? profile?.name ?? '配置',
      type: source ? 'remote' : 'local',
      updated: Date.parse(
        source?.observation?.checkedAt ?? profile?.createdAt ?? source?.createdAt ?? ''
      ),
      extra:
        quota &&
        quota.upload !== undefined &&
        quota.download !== undefined &&
        quota.total !== undefined &&
        quota.expire !== undefined
          ? {
              upload: quota.upload,
              download: quota.download,
              total: quota.total,
              expire: quota.expire
            }
          : undefined
    }
    return (
      <Card
        key={source?.id ?? profile?.id}
        shadow="none"
        className="relay-subscription-card bg-content1 text-foreground"
        data-selected={highlighted ? 'true' : undefined}
        data-relay-subscription-card={source?.id}
        data-relay-profile-card={profile?.id}
      >
        <button
          type="button"
          className="relay-subscription-activate"
          aria-label={`使用${source ? '订阅' : '配置'} ${info.name}`}
          aria-pressed={selected || running}
          title={running ? '正在使用' : selected ? '已选中，点击运行此配置' : '点击使用此配置'}
          disabled={locked || unavailable || running}
          onClick={() => {
            if (profile) void choose(profile)
          }}
        >
          <span className="sr-only">{running ? '正在使用' : '使用此配置'}</span>
        </button>
        <ProfileCardContent
          info={info}
          quota={
            quota?.upload !== undefined && quota.download !== undefined && quota.total !== undefined
              ? {
                  upload: quota.upload,
                  download: quota.download,
                  total: quota.total,
                  expire: quota.expire
                }
              : undefined
          }
          actions={
            <div className="flex shrink-0">
              {source && (
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  aria-label={`更新订阅 ${source.name}`}
                  title="更新订阅"
                  isDisabled={locked || source.locked}
                  isLoading={pending && pendingSource === source.id}
                  onPress={() => void run(source)}
                >
                  <IoMdRefresh className="text-lg" />
                </Button>
              )}
              <RelayProfileCardMenu
                profile={profile}
                source={source}
                disabled={locked || source?.locked === true}
                onBusy={onBusy}
                onChanged={read}
              />
            </div>
          }
        />
        <div className="px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
          {profile ? (
            <span>
              {profile.summary.proxies} 个节点 · {profile.summary.groups} 个代理组
            </span>
          ) : (
            <span>{source?.versions.length ? '配置未读取，请刷新' : '尚未下载配置'}</span>
          )}
          {selected && !running && (
            <Chip size="sm" variant="flat">
              已选，未运行
            </Chip>
          )}
          {running && (
            <Chip size="sm" variant="flat">
              运行中
            </Chip>
          )}
          {(oldSelected || oldRunning) && (
            <Chip size="sm" variant="flat">
              {oldRunning ? '旧版本运行中' : '旧版本已选用'}
            </Chip>
          )}
          {source?.locked && <span>来源待核对</span>}
          {!!profile && choosing === profile.id && <Spinner size="sm" aria-label="正在启用配置" />}
        </div>
        <CardFooter className="gap-2 pt-1">
          <Button
            size="sm"
            variant="flat"
            isDisabled={locked || unavailable}
            onPress={() => {
              if (profile) onBrowse(profile)
            }}
          >
            查看代理组
          </Button>
        </CardFooter>
      </Card>
    )
  }
  return (
    <section className="relay-subscriptions-dashboard" aria-label="订阅与配置">
      <form
        className="relay-subscription-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        <Popover placement="bottom-start">
          <PopoverTrigger>
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              aria-label="订阅导入选项"
              title="订阅导入选项"
              isDisabled={locked}
            >
              <FiSliders />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="p-3 gap-3 items-stretch">
            <Input
              size="sm"
              label="订阅名称（可选）"
              aria-label="订阅名称"
              value={name}
              maxLength={120}
              isDisabled={locked}
              onValueChange={setName}
            />
            <Input
              size="sm"
              label="下载代理端口"
              aria-label="订阅下载代理端口"
              type="number"
              min={1024}
              max={65535}
              value={port}
              isDisabled={locked}
              onValueChange={setPort}
            />
          </PopoverContent>
        </Popover>
        <label className="relay-subscription-url">
          <span className="sr-only">订阅地址</span>
          <input
            aria-label="订阅地址"
            type="password"
            placeholder="请输入订阅地址"
            autoComplete="off"
            spellCheck={false}
            value={url}
            maxLength={4096}
            disabled={locked}
            onChange={(event) => setURL(event.target.value)}
          />
        </label>
        <Button
          isIconOnly
          size="sm"
          variant="light"
          aria-label="粘贴订阅地址"
          title="粘贴订阅地址"
          isDisabled={locked}
          onPress={() => void pasteURL()}
        >
          <FiClipboard />
        </Button>
        <Button
          type="submit"
          color="primary"
          size="sm"
          isDisabled={locked || !url.trim()}
          isLoading={pending && !pendingSource}
        >
          导入
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="flat"
          aria-label="导入本地配置"
          title="导入本地配置"
          isDisabled={locked}
          onPress={() => void importLocal()}
        >
          <FiFolderPlus />
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="flat"
          aria-label="刷新订阅与配置"
          title="刷新列表"
          isDisabled={locked}
          onPress={() => void refresh()}
        >
          <IoMdRefresh />
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="flat"
          aria-label="高级订阅管理"
          title="高级管理"
          isDisabled={locked}
          onPress={onAdvanced}
        >
          <FiSettings />
        </Button>
      </form>
      {notice && (
        <div className="relay-subscription-notice" role="status">
          <span>{notice}</span>
          {pending && (
            <Button size="sm" variant="light" onPress={() => void cancel()}>
              取消
            </Button>
          )}
        </div>
      )}
      {loading && (
        <div className="py-5">
          <Spinner size="sm" label="正在读取订阅与配置" />
        </div>
      )}
      {!loading && sources && inventory && (
        <>
          {(sources.incomplete > 0 || inventory.incomplete > 0) && (
            <p role="status">部分记录尚未确认，可在高级管理中核对。</p>
          )}
          {(primaryLocal || entries.subscriptions.length > 0) && (
            <div className="relay-subscription-grid">
              {primaryLocal && card(primaryLocal)}
              {entries.subscriptions.map(({ source, profile }) => card(profile, source))}
            </div>
          )}
          {otherLocalProfiles.length > 0 && (
            <details className="relay-local-profiles">
              <summary>其他本地配置（{otherLocalProfiles.length}）</summary>
              <div className="relay-subscription-grid">
                {otherLocalProfiles.map((profile) => card(profile))}
              </div>
            </details>
          )}
          {!entries.subscriptions.length && !entries.localProfiles.length && (
            <div className="relay-subscription-empty">
              <h2>添加第一个订阅</h2>
              <p>在上方粘贴 Clash / Mihomo 订阅地址，或导入本地配置文件。</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
