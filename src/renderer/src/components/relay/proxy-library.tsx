import { Button, Chip, Input, Select, SelectItem, Spinner } from '@heroui/react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { IoRefresh, IoSearch } from 'react-icons/io5'
import useSWR from 'swr'
import { getProfileConfig } from '@renderer/utils/ipc'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import {
  canSelectCachedGroupMember,
  type RelayProfileGroups,
  type RelayStoredProfile
} from '../../../../shared/relay/profiles'
import type { LocalProxyState, RelayProxyPageOwner } from '../../../../shared/relay/local-proxy'
import { cachedProxyGroups, preferredCachedProfile } from './proxy-library-model'
import { relayProfileRead } from './profile-read-queue'
import { RelayCachedProxyGroup } from './cached-proxy-group'
import {
  relayProxyCanPrepare,
  relayProxyRunning,
  chooseCachedProfile
} from './proxy-library-actions'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.electron.ipcRenderer.invoke(channel, ...args)

export function RelayProxyLibrary({
  state,
  owner,
  cached = true,
  runtimeError,
  onRuntimeChange
}: {
  state?: LocalProxyState
  owner?: RelayProxyPageOwner | null
  cached?: boolean
  runtimeError?: boolean
  onRuntimeChange(): Promise<void>
}): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const { profileConfig, mutateProfileConfig } = useProfileConfig()
  const [search, setSearch] = useState('')
  const [showHidden, setShowHidden] = useState(false)
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
  const readLibrary = async () => {
    const inventory = await relayProfileRead('relayProfileList')
    const sources = await relayProfileRead('relaySourceList')
    // Imports restored while the app is open may have replaced the empty startup selection.
    await mutateProfileConfig(() => getProfileConfig(true), { revalidate: false })
    return { inventory, sources }
  }
  const {
    data: library,
    error: libraryError,
    isValidating: libraryValidating,
    mutate: refreshLibrary
  } = useSWR('relayProxyLibrary', readLibrary, { revalidateOnFocus: false, errorRetryCount: 0 })
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
    cached && profile ? ['relayCachedGroups', profile.id, profile.sha256] : null,
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
  const currentId = owner?.profileId ?? profileConfig?.current
  const selected = !!profile && profile.id === currentId
  const canUse =
    !runtimeError &&
    (owner?.kind === 'tun-managed' || relayProxyCanPrepare(state) || relayProxyRunning(state))
  const selectionLocked =
    pending || refreshing || !canUse || !library || !!libraryError || libraryValidating
  const readState =
    libraryError || groupsError || refreshFailed
      ? 'error'
      : refreshing ||
          libraryValidating ||
          groupsValidating ||
          !library ||
          (cached && profile && !validSnapshot)
        ? 'loading'
        : 'ready'
  const refresh = async (): Promise<void> => {
    if (working.current || refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setRefreshFailed(false)
    try {
      if (cached && profile)
        await refreshGroups(
          () =>
            relayProfileRead('relayProfileGroupsRead', { id: profile.id, sha256: profile.sha256 }),
          { revalidate: false, throwOnError: true }
        )
      await refreshLibrary(readLibrary, { revalidate: false, throwOnError: true })
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
  const select = async (
    item: RelayStoredProfile,
    choice?: { group: string; member: string }
  ): Promise<void> => {
    if (selectionLocked || working.current || refreshingRef.current) return
    working.current = true
    setPending(true)
    setNotice('')
    try {
      if (currentId !== item.id) {
        if (choice && owner) {
          // Seed the destination before its listeners can serve the previous choice.
          await invoke('relayProfileGroupSelect', {
            profile: { id: item.id, sha256: item.sha256 },
            ...choice,
            owner
          })
        }
        if (owner?.kind === 'tun-managed') {
          setNotice('正在切换配置并恢复虚拟网卡…')
          await invoke('relayTunProfileSwitch', {
            profile: { id: item.id, sha256: item.sha256 },
            owner
          })
          if (mounted.current) setNotice('')
        } else await chooseCachedProfile(item, invoke)
      }
      if (choice) {
        const live = (await invoke('relayProxyPageOwner')) as RelayProxyPageOwner | undefined
        if (live) {
          if (live.profileId !== item.id) throw new Error('运行配置已变化，请重新选择节点。')
          await invoke('mihomoChangeProxy', choice.group, choice.member, live)
        } else {
          await invoke('relayProfileGroupSelect', {
            profile: { id: item.id, sha256: item.sha256 },
            ...choice
          })
        }
      }
      if (mounted.current) {
        if (params.has('profile')) {
          const next = new URLSearchParams(params)
          next.delete('profile')
          setParams(next, { replace: true })
        }
        if (!choice || currentId !== item.id) setSearch('')
        if (choice && cached && profile?.id === item.id) await refreshGroups()
      }
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : '选择未完成，请刷新后重试。')
    } finally {
      mutateProfileConfig()
      try {
        await onRuntimeChange()
      } catch {
        if (mounted.current) setNotice('运行状态未能刷新，请刷新代理组核对。')
      } finally {
        working.current = false
        if (mounted.current) setPending(false)
      }
    }
  }
  return (
    <div
      className="p-3 space-y-3"
      data-relay-proxy-mode={cached ? 'cached' : 'live-selection'}
      data-relay-cache-read-state={readState}
      data-relay-cache-refresh-generation={refreshGeneration}
      aria-busy={pending || readState === 'loading'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="当前配置"
          label="当前配置"
          placeholder="选择配置"
          disallowEmptySelection
          labelPlacement="outside-left"
          className="min-w-52 flex-1"
          size="sm"
          selectedKeys={
            currentId && library?.inventory.profiles.some((item) => item.id === currentId)
              ? [currentId]
              : []
          }
          isDisabled={selectionLocked}
          onSelectionChange={(keys) => {
            const id = [...keys][0]
            const item = library?.inventory.profiles.find((row) => row.id === id)
            if (item && (item.id !== currentId || (cached && profile?.id !== item.id)))
              void select(item)
          }}
        >
          {(library?.inventory.profiles ?? []).map((item) => (
            <SelectItem key={item.id}>{item.name}</SelectItem>
          ))}
        </Select>
        {cached && profile && (
          <Chip size="sm" variant="flat">
            {selected ? '已选用' : `预览 · ${profile.name}`}
          </Chip>
        )}
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
      {cached && profile && (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-content1 p-3">
            <div className="flex-1 min-w-52 text-sm">
              <p className="font-medium">
                {profile.summary.proxies} 个节点 · {profile.summary.groups} 个代理组
              </p>
            </div>
            <Link to="/relay?panel=core" className="text-xs text-primary">
              内核设置
            </Link>
          </div>
          {!!state && !canUse && owner?.kind !== 'tun-managed' && (
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
              selectedMember={
                validSnapshot?.savedSelectors?.find(([name]) => name === group.name)?.[1]
              }
              canSelect={(member) =>
                !!validSnapshot &&
                !selectionLocked &&
                canSelectCachedGroupMember(validSnapshot, group.name, member)
              }
              onSelect={(member) => void select(profile, { group: group.name, member })}
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
