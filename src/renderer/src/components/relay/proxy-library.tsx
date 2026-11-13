import { Button, Chip, Input, Select, SelectItem, Spinner } from '@heroui/react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { IoRefresh, IoSearch } from 'react-icons/io5'
import useSWR from 'swr'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import type { RelayProfileGroups } from '../../../../shared/relay/profiles'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import { cachedProxyGroups, preferredCachedProfile } from './proxy-library-model'
import { relayProfileRead } from './profile-read-queue'
import { RelayCachedProxyGroup } from './cached-proxy-group'
import {
  relayProxyCanPrepare,
  relayProxyRunning,
  activateCachedProfile
} from './proxy-library-actions'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.electron.ipcRenderer.invoke(channel, ...args)

export function RelayProxyLibrary({
  state,
  runtimeError,
  onRuntimeChange
}: {
  state?: LocalProxyState
  runtimeError?: boolean
  onRuntimeChange(): Promise<void>
}): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const { profileConfig, mutateProfileConfig } = useProfileConfig()
  const [search, setSearch] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [port, setPort] = useState('18191')
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [notice, setNotice] = useState('')
  const working = useRef(false)
  const refreshingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const {
    data: library,
    error: libraryError,
    isValidating: libraryValidating,
    mutate: refreshLibrary
  } = useSWR(
    'relayProxyLibrary',
    async () => {
      const inventory = await relayProfileRead('relayProfileList')
      const sources = await relayProfileRead('relaySourceList')
      return { inventory, sources }
    },
    { revalidateOnFocus: false, errorRetryCount: 0 }
  )
  const profile =
    library &&
    preferredCachedProfile({
      queryId: params.get('profile') ?? undefined,
      currentSelection: profileConfig?.current,
      sources: library.sources.sources,
      profiles: library.inventory.profiles
    })
  const {
    data: snapshot,
    error: groupsError,
    isLoading,
    isValidating: groupsValidating,
    mutate: refreshGroups
  } = useSWR<RelayProfileGroups>(
    profile ? ['relayCachedGroups', profile.id, profile.sha256] : null,
    () => {
      if (!profile) throw new Error('请先选择要浏览的配置。')
      return relayProfileRead('relayProfileGroupsRead', {
        id: profile.id,
        sha256: profile.sha256
      })
    },
    { revalidateOnFocus: false, errorRetryCount: 0, keepPreviousData: false }
  )
  const validSnapshot =
    !libraryValidating &&
    !groupsValidating &&
    !refreshing &&
    !refreshFailed &&
    !libraryError &&
    !groupsError &&
    snapshot &&
    profile &&
    snapshot.profile.id === profile.id &&
    snapshot.profile.sha256 === profile.sha256
      ? snapshot
      : undefined
  const groups = validSnapshot ? cachedProxyGroups(validSnapshot, { search, showHidden }) : []
  const selected = profile?.id === profileConfig?.current
  const canUse = !runtimeError && (relayProxyCanPrepare(state) || relayProxyRunning(state))
  const readState =
    libraryError || groupsError || refreshFailed
      ? 'error'
      : refreshing ||
          libraryValidating ||
          groupsValidating ||
          !library ||
          (profile && !validSnapshot)
        ? 'loading'
        : 'ready'
  const refresh = async (): Promise<void> => {
    if (working.current || refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setRefreshFailed(false)
    try {
      if (profile)
        await refreshGroups(
          () =>
            relayProfileRead('relayProfileGroupsRead', { id: profile.id, sha256: profile.sha256 }),
          { revalidate: false, throwOnError: true }
        )
      await refreshLibrary(
        async () => ({
          inventory: await relayProfileRead('relayProfileList'),
          sources: await relayProfileRead('relaySourceList')
        }),
        { revalidate: false, throwOnError: true }
      )
      await onRuntimeChange()
      if (mounted.current) {
        setRefreshGeneration((value) => value + 1)
        setNotice('')
      }
    } catch {
      if (mounted.current) {
        setRefreshFailed(true)
        setNotice('读取未完成，请稍后重试。')
      }
    } finally {
      refreshingRef.current = false
      if (mounted.current) setRefreshing(false)
    }
  }
  const act = async (): Promise<void> => {
    if (!profile || working.current || refreshingRef.current || !validSnapshot || !canUse) return
    working.current = true
    setPending(true)
    setNotice('正在检查配置，随后请确认使用。')
    try {
      await activateCachedProfile(profile, Number(port), invoke)
      if (mounted.current) setNotice('正在使用此配置。')
      mutateProfileConfig()
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : '操作未完成，请重新读取后重试。')
    } finally {
      working.current = false
      if (mounted.current) setPending(false)
      try {
        await onRuntimeChange()
      } catch {
        if (mounted.current) setNotice('运行状态未能刷新，请在内核设置核对。')
      }
    }
  }
  return (
    <div
      className="p-3 space-y-3"
      data-relay-proxy-mode="cached"
      data-relay-cache-read-state={readState}
      data-relay-cache-refresh-generation={refreshGeneration}
      aria-busy={pending || readState === 'loading'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="浏览配置"
          label="浏览配置"
          labelPlacement="outside-left"
          className="min-w-52 flex-1"
          size="sm"
          selectedKeys={profile ? [profile.id] : []}
          isDisabled={pending || refreshing || !library}
          onSelectionChange={(keys) => {
            const id = [...keys][0]
            if (id) {
              setParams({ profile: String(id) })
              setSearch('')
              setNotice('')
            }
          }}
        >
          {(library?.inventory.profiles ?? []).map((item) => (
            <SelectItem key={item.id}>{item.name}</SelectItem>
          ))}
        </Select>
        <Chip size="sm" variant="flat">
          {selected ? '已选用 · 缓存预览' : '缓存预览'}
        </Chip>
        <Button
          isIconOnly
          size="sm"
          variant="flat"
          aria-label="刷新配置与代理组"
          isDisabled={pending || refreshing}
          onPress={() => void refresh()}
        >
          <IoRefresh />
        </Button>
      </div>
      {libraryError && (
        <p role="alert" className="text-danger text-sm">
          配置列表读取失败。请点击刷新重试。
        </p>
      )}
      {runtimeError && (
        <p role="alert" className="text-warning text-sm">
          运行状态读取失败，当前仅展示缓存配置。
        </p>
      )}
      {!library && !libraryError && <Spinner label="读取已保存配置" />}
      {library && !profile && (
        <div className="rounded-xl border border-default-200 p-8 text-center">
          <p>还没有可展示的配置。</p>
          <Link to="/relay?panel=profiles" className="text-primary">
            导入订阅或本地配置
          </Link>
        </div>
      )}
      {profile && (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-content1 p-3">
            <div className="flex-1 min-w-52 text-sm">
              <p className="font-medium">
                {profile.summary.proxies} 个节点 · {profile.summary.groups} 个代理组
              </p>
              <p className="text-default-500 text-xs mt-1">
                当前显示已保存的节点。使用此配置后可切换节点并查看运行状态。
              </p>
            </div>
            {!relayProxyRunning(state) && (
              <Input
                type="number"
                aria-label="Relay HTTP 端口"
                label="HTTP 端口"
                size="sm"
                className="w-28"
                value={port}
                onValueChange={setPort}
                isDisabled={pending || refreshing}
              />
            )}
            <Button
              color="primary"
              size="sm"
              isLoading={pending}
              isDisabled={pending || !canUse || !validSnapshot}
              onPress={() => void act()}
            >
              使用此配置
            </Button>
            <Link to="/relay?panel=core" className="text-xs text-primary">
              内核设置
            </Link>
          </div>
          {!!state && !canUse && (
            <p className="text-sm text-warning">
              当前代理有运行或恢复状态待核对，请在内核设置中处理。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Input
              aria-label="筛选缓存代理组和节点"
              placeholder="搜索代理组或节点"
              size="sm"
              value={search}
              onValueChange={setSearch}
              startContent={<IoSearch />}
              className="flex-1"
            />
            <label className="text-xs text-default-500 flex items-center gap-2">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(event) => setShowHidden(event.target.checked)}
              />
              显示隐藏组
            </label>
          </div>
          {(isLoading || readState === 'loading') && <Spinner label="读取代理组" />}
          {groupsError && (
            <p role="alert" className="text-danger text-sm">
              代理组读取失败，配置可能已更新。请刷新重试。
            </p>
          )}
          {!isLoading && validSnapshot && !groups.length && (
            <p className="text-default-500 text-sm">
              {search
                ? '没有匹配的代理组或节点。'
                : '这份配置没有可显示的代理组，可在配置管理中编辑。'}
            </p>
          )}
          {groups.map((group) => (
            <RelayCachedProxyGroup
              key={`${profile.id}:${profile.sha256}:${group.name}`}
              group={group}
              profile={profile}
              locked={pending || refreshing}
              beginProbe={() => {
                if (working.current || refreshingRef.current) return false
                working.current = true
                setPending(true)
                return true
              }}
              endProbe={() => {
                working.current = false
                if (mounted.current) setPending(false)
              }}
            />
          ))}
        </>
      )}
      {notice && (
        <p role="status" className="text-sm whitespace-pre-wrap">
          {notice}
        </p>
      )}
    </div>
  )
}
