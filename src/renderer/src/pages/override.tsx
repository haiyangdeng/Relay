import {
  Button,
  Divider,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input
} from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { toast } from '@renderer/components/base/toast'
import { getFilePath, readTextFile } from '@renderer/utils/ipc'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MdContentPaste } from 'react-icons/md'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { useRelayInitialRead } from '@renderer/hooks/use-relay-initial-read'
import { useOverrideConfig } from '@renderer/hooks/use-override-config'
import OverrideItem from '@renderer/components/override/override-item'
import { FaPlus } from 'react-icons/fa6'
import { HiOutlineDocumentText } from 'react-icons/hi'
import { RiArchiveLine } from 'react-icons/ri'
import { useTranslation } from 'react-i18next'
import {
  useRelayOverrideConfig,
  type RelayOverrideConfig
} from '@renderer/hooks/use-relay-override-config'
import type { OverrideLibraryBindRequest } from '../../../shared/relay/override-library'

interface ManagerProps {
  legacy?: ReturnType<typeof useOverrideConfig>
  relay?: RelayOverrideConfig
}
export function OverrideManagerView({ legacy, relay }: ManagerProps): React.JSX.Element {
  const { t } = useTranslation()
  const relayMode = !!relay
  const [remoteName, setRemoteName] = useState('远端覆写'),
    [remoteKind, setRemoteKind] = useState<'yaml' | 'js'>('yaml'),
    [remotePort, setRemotePort] = useState('17891')
  const legacyItems = legacy?.overrideConfig?.items,
    inventory = relay?.inventory,
    bindings = relay?.bindings
  const items = useMemo(() => {
    if (legacyItems) return legacyItems
    const order = bindings?.order ?? []
    return [...(inventory?.items ?? [])]
      .sort((a, b) => {
        const ai = order.indexOf(a.id),
          bi = order.indexOf(b.id)
        return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
      })
      .map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        ext: item.kind,
        updated: item.lastFetchedAt ?? item.bodyUpdatedAt ?? item.metadataUpdatedAt,
        global: !!bindings?.globalRefs.some((ref) => ref.id === item.id)
      }))
  }, [legacyItems, inventory, bindings])
  const {
    setOverrideConfig,
    addOverrideItem,
    updateOverrideItem,
    removeOverrideItem,
    mutateOverrideConfig
  } = legacy ?? {
    setOverrideConfig: async (config: IOverrideConfig): Promise<void> => {
      if (!relay) throw new Error('管理库尚未就绪。')
      await relay.reorder(config.items.map((item) => item.id))
    },
    addOverrideItem: async (item: Partial<IOverrideItem>): Promise<void> => {
      if (!relay) throw new Error('管理库尚未就绪。')
      if (item.type === 'remote')
        await relay.createRemote(item.name || '远端覆写', remoteKind, {
          url: item.url ?? '',
          proxyPort: Number(remotePort)
        })
      else await relay.createLocal(item.ext === 'js' ? 'js' : 'yaml')
    },
    updateOverrideItem: async (): Promise<void> => {
      throw new Error('元信息与全局选择须使用独立覆写命令。')
    },
    removeOverrideItem: async (): Promise<void> => {
      throw new Error('删除须绑定当前库修订。')
    },
    mutateOverrideConfig: (): void => {}
  }
  const [sortedItems, setSortedItems] = useState(items)
  const [importing, setImporting] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  const [url, setUrl] = useState('')
  const [filter, setFilter] = useState('')
  const visibleItems = sortedItems.filter((item) =>
    `${item.name} ${item.ext} ${item.type}`
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase())
  )
  const sensors = useSensors(useSensor(PointerSensor))
  const handleImport = async (): Promise<void> => {
    if (relay?.locked) return
    setImporting(true)
    try {
      const urlObj = new URL(url)
      const name = relay ? remoteName : urlObj.pathname.split('/').pop()
      await addOverrideItem({
        name: relay ? name : name ? decodeURIComponent(name) : undefined,
        type: 'remote',
        url,
        ext: urlObj.pathname.endsWith('.js') ? 'js' : 'yaml'
      })
    } catch (e) {
      toast.error(
        relay
          ? e instanceof Error && e.name === 'OverrideLibraryRefreshError'
            ? '定义已保存，但刷新未完成；请重新读取核对，不要重复新建。'
            : '远端定义保存未确认；请核对地址、代理和库修订，尚未获取正文。'
          : t('override.error.importFailed', { error: String(e) })
      )
    } finally {
      setImporting(false)
    }
  }
  const pageRef = useRef<HTMLDivElement>(null)

  const onDragEnd = async (event: DragEndEvent): Promise<void> => {
    if (relay?.locked || filter.trim()) return
    const { active, over } = event
    if (over) {
      if (active.id !== over.id) {
        const newOrder = sortedItems.slice()
        const activeIndex = newOrder.findIndex((item) => item.id === active.id)
        const overIndex = newOrder.findIndex((item) => item.id === over.id)
        if (activeIndex === -1 || overIndex === -1) return
        // 必须插回从 newOrder 里移除的那一项：items 与 sortedItems 会在写入失败时分叉，
        // 用 items[activeIndex] 会插入错误的元素，导致一项重复、一项丢失
        const [movedItem] = newOrder.splice(activeIndex, 1)
        newOrder.splice(overIndex, 0, movedItem)
        setSortedItems(newOrder)
        try {
          await setOverrideConfig({ items: newOrder })
        } catch {
          setSortedItems(items)
          toast.error('排序保存未确认，已恢复先前顺序，请重新核对修订。')
        }
      }
    }
  }

  const addOverrideItemRef = useRef(addOverrideItem)
  addOverrideItemRef.current = addOverrideItem

  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    if (relayMode) return
    const element = pageRef.current
    if (!element) return

    const handleDragOver = (e: DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setFileOver(true)
    }

    const handleDragLeave = (e: DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setFileOver(false)
    }

    const handleDrop = async (event: DragEvent): Promise<void> => {
      event.preventDefault()
      event.stopPropagation()
      try {
        if (event.dataTransfer?.files) {
          const file = event.dataTransfer.files[0]
          // 拖入选中文字或链接时 files 长度为 0（FileList 本身仍是真值），file 可能为 undefined
          const name = file?.name.toLowerCase() ?? ''
          if (name.endsWith('.js') || name.endsWith('.yaml')) {
            // Electron 32 起已移除 File 上的非标准 path 属性，只能通过 webUtils 拿真实路径
            const path = window.api.webUtils.getPathForFile(file)
            const content = await readTextFile(path)
            await addOverrideItemRef.current({
              name: file.name,
              type: 'local',
              file: content,
              ext: name.endsWith('.js') ? 'js' : 'yaml'
            })
          } else if (file) {
            toast.warning(tRef.current('override.unsupportedFileType'))
          }
        }
      } catch (e) {
        toast.error(String(e))
      } finally {
        // 无论成功失败都要复位，否则页面会一直卡在 blur-sm 模糊态
        setFileOver(false)
      }
    }

    element.addEventListener('dragover', handleDragOver)
    element.addEventListener('dragleave', handleDragLeave)
    element.addEventListener('drop', handleDrop)

    return (): void => {
      element.removeEventListener('dragover', handleDragOver)
      element.removeEventListener('dragleave', handleDragLeave)
      element.removeEventListener('drop', handleDrop)
    }
  }, [relayMode])

  useEffect(() => {
    setSortedItems(items)
  }, [items])

  const content = (
    <>
      <div className="sticky top-0 z-40 bg-background">
        <div className="flex flex-wrap gap-2 p-2">
          <Input
            size="sm"
            className="flex-1 min-w-[12rem]"
            placeholder={t('override.input.placeholder')}
            aria-label={relay ? '新增远端覆写地址' : undefined}
            isDisabled={!!relay && relay.locked}
            value={url}
            onValueChange={setUrl}
            endContent={
              <Button
                size="sm"
                isIconOnly
                variant="light"
                aria-label="粘贴覆写地址"
                isDisabled={!!relay?.locked}
                onPress={() => {
                  navigator.clipboard
                    .readText()
                    .then((text) => {
                      setUrl(text)
                    })
                    .catch(() => toast.error('无法读取剪贴板，请粘贴到地址栏。'))
                }}
              >
                <MdContentPaste className="text-lg" />
              </Button>
            }
          />
          <Button
            size="sm"
            color="primary"
            className="ml-2"
            isDisabled={
              url === '' || (!!relay && (relay.locked || !relay.inventory || !remoteName.trim()))
            }
            isLoading={importing}
            onPress={handleImport}
          >
            {relay ? '添加来源' : t('override.import')}
          </Button>
          <Dropdown>
            <DropdownTrigger>
              <Button
                aria-label={relay ? '新建本地覆写' : undefined}
                isDisabled={!!relay && (relay.locked || !relay.inventory)}
                className="ml-2"
                size="sm"
                isIconOnly
                color="primary"
              >
                <FaPlus />
              </Button>
            </DropdownTrigger>
            <DropdownMenu
              onAction={async (key) => {
                if (relay?.locked) return
                try {
                  if (key === 'open') {
                    if (relay) return
                    try {
                      const files = await getFilePath(['js', 'yaml'])
                      if (files?.length) {
                        const content = await readTextFile(files[0])
                        const fileName = files[0].split('/').pop()?.split('\\').pop()
                        await addOverrideItem({
                          name: fileName,
                          type: 'local',
                          file: content,
                          ext: fileName?.endsWith('.js') ? 'js' : 'yaml'
                        })
                      }
                    } catch (e) {
                      toast.error(String(e))
                    }
                  } else if (key === 'new-yaml') {
                    await addOverrideItem({
                      name: t('override.newFile.yaml'),
                      type: 'local',
                      file: t('override.defaultContent.yaml'),
                      ext: 'yaml'
                    })
                  } else if (key === 'new-js') {
                    await addOverrideItem({
                      name: t('override.newFile.js'),
                      type: 'local',
                      file: t('override.defaultContent.js'),
                      ext: 'js'
                    })
                  }
                } catch (error) {
                  toast.error(
                    error instanceof Error && error.name === 'OverrideLibraryRefreshError'
                      ? '定义已保存，但刷新失败；请重新读取核对，不要重复新建。'
                      : '定义保存未确认，请核对输入与修订；没有自动获取或应用。'
                  )
                }
              }}
            >
              {(relay ? ['new-yaml', 'new-js'] : ['open', 'new-yaml', 'new-js']).map((key) => (
                <DropdownItem key={key}>
                  {key === 'open'
                    ? t('override.actions.open')
                    : key === 'new-yaml'
                      ? t('override.actions.newYaml')
                      : t('override.actions.newJs')}
                </DropdownItem>
              ))}
            </DropdownMenu>
          </Dropdown>
        </div>
        {relay && (
          <>
            <details className="px-2 pb-2 text-xs">
              <summary>远端来源选项：名称、类型与代理端口</summary>
              <div className="grid sm:grid-cols-3 gap-2 mt-2">
                <Input
                  aria-label="远端覆写公共名称"
                  label="名称"
                  size="sm"
                  value={remoteName}
                  isDisabled={relay.locked}
                  onValueChange={setRemoteName}
                />
                <label>
                  类型
                  <select
                    aria-label="远端覆写类型"
                    disabled={relay.locked}
                    value={remoteKind}
                    onChange={(event) => setRemoteKind(event.target.value as 'yaml' | 'js')}
                  >
                    <option value="yaml">YAML</option>
                    <option value="js">JavaScript</option>
                  </select>
                </label>
                <Input
                  aria-label="新增覆写代理端口"
                  label="代理端口"
                  size="sm"
                  value={remotePort}
                  isDisabled={relay.locked}
                  onValueChange={setRemotePort}
                  inputMode="numeric"
                />
              </div>
            </details>
            <div className="p-2">
              <Input
                aria-label="筛选覆写"
                placeholder="筛选名称、类型"
                size="sm"
                isClearable
                value={filter}
                onValueChange={setFilter}
              />
            </div>
          </>
        )}
        <Divider />
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div
          className={`${fileOver ? 'blur-sm' : ''} grid sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 m-2`}
        >
          <SortableContext
            items={visibleItems.map((item) => {
              return item.id
            })}
          >
            {visibleItems.map((item) => {
              const summary = relay?.inventory?.items.find((entry) => entry.id === item.id)
              if (relay && !summary) return null
              return (
                <OverrideItem
                  key={item.id}
                  addOverrideItem={addOverrideItem}
                  removeOverrideItem={removeOverrideItem}
                  mutateOverrideConfig={mutateOverrideConfig}
                  updateOverrideItem={updateOverrideItem}
                  info={item}
                  sortingDisabled={!!filter.trim()}
                  relay={relay && summary ? { config: relay, item: summary } : undefined}
                />
              )
            })}
          </SortableContext>
        </div>
      </DndContext>
      {relay?.inventory && !visibleItems.length && (
        <p className="p-3 text-sm text-default-500">
          {filter.trim()
            ? '没有匹配的覆写。'
            : '暂无覆写。点击 + 新建 YAML 或 JavaScript，再打开卡片编辑内容。'}
        </p>
      )}
    </>
  )
  if (relay) return content
  return (
    <BasePage
      ref={pageRef}
      title={t('override.title')}
      header={
        <>
          <Button
            size="sm"
            variant="light"
            title={t('override.docs')}
            isIconOnly
            className="app-nodrag"
            onPress={() => {
              open('https://clashparty.org/docs/guide/override')
            }}
          >
            <HiOutlineDocumentText className="text-lg" />
          </Button>
          <Button
            className="app-nodrag"
            title={t('override.repository')}
            isIconOnly
            variant="light"
            size="sm"
            onPress={() => {
              open('https://github.com/mihomo-party-org/override-hub')
            }}
          >
            <RiArchiveLine className="text-lg" />
          </Button>
        </>
      }
    >
      {content}
    </BasePage>
  )
}

const Override: React.FC = () => <OverrideManagerView legacy={useOverrideConfig()} />

function RelayProfileOverrideSelection({
  config
}: {
  config: RelayOverrideConfig
}): React.JSX.Element {
  const refs = useMemo(() => config.bindings?.profileRefs ?? [], [config.bindings?.profileRefs]),
    signature = JSON.stringify(refs),
    [draft, setDraft] = useState<OverrideLibraryBindRequest['refs']>(refs)
  useEffect(() => setDraft(refs), [refs, config.target?.id, config.target?.revision])
  const dirty = JSON.stringify(draft) !== signature,
    items = config.inventory?.items ?? [],
    global = new Set(config.bindings?.globalRefs.map((ref) => ref.id)),
    locked = config.locked || !config.bindings
  return (
    <section aria-label="配置级有序覆写选择">
      <h3>全局与配置级引用</h3>
      <p>
        先使用全局库顺序，再使用配置级顺序；被全局遮蔽的旧引用仍保留。库正文保存或获取不会自动更新这些快照。
      </p>
      <label>
        配置级作用域
        <select
          aria-label="覆写作用域"
          disabled={locked || dirty}
          value={config.target?.id ?? ''}
          onChange={(event) => void config.selectTarget(event.target.value).catch(() => {})}
        >
          <option value="">全局（用卡片开关与排序）</option>
          {config.profiles?.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      {config.target && (
        <>
          {draft.map((ref, index) => {
            const item = items.find((entry) => entry.id === ref.id)
            return (
              <div key={ref.id}>
                <span>
                  {index + 1}. {item?.name ?? ref.id} · 引用{ref.bodyRevision.slice(0, 8)}
                  {global.has(ref.id) ? '（全局优先，旧引用保留）' : ''}
                  {item && item.bodyRevision !== ref.bodyRevision ? ' · 库有新修订' : ''}
                </span>
                <button
                  disabled={locked || index === 0}
                  onClick={() =>
                    setDraft((current) => {
                      const next = [...current]
                      ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                      return next
                    })
                  }
                >
                  前移
                </button>
                <button
                  disabled={locked || index === draft.length - 1}
                  onClick={() =>
                    setDraft((current) => {
                      const next = [...current]
                      ;[next[index + 1], next[index]] = [next[index], next[index + 1]]
                      return next
                    })
                  }
                >
                  后移
                </button>
                <button
                  disabled={locked}
                  onClick={() =>
                    setDraft((current) => current.filter((entry) => entry.id !== ref.id))
                  }
                >
                  移除此引用
                </button>
                <button
                  disabled={
                    locked ||
                    dirty ||
                    !item ||
                    !config.usable(item) ||
                    item.bodyRevision === ref.bodyRevision
                  }
                  onClick={() => void config.refresh([ref.id], true).catch(() => {})}
                >
                  显式更新此引用
                </button>
              </div>
            )
          })}
          <label>
            追加库定义
            <select
              aria-label="追加配置级覆写"
              disabled={locked}
              value=""
              onChange={(event) => {
                const item = items.find((entry) => entry.id === event.target.value)
                if (item)
                  setDraft((current) => [
                    ...current,
                    { id: item.id, bodyRevision: item.bodyRevision }
                  ])
              }}
            >
              <option value="">选择后追加到末尾</option>
              {items
                .filter(
                  (item) =>
                    config.usable(item) &&
                    !global.has(item.id) &&
                    !draft.some((ref) => ref.id === item.id)
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={locked || !dirty}
            onClick={() => void config.bindProfile(draft).catch(() => {})}
          >
            保存此配置有序选择
          </button>
          <button disabled={locked || !dirty} onClick={() => setDraft(refs)}>
            撤销选择草稿
          </button>
        </>
      )}
    </section>
  )
}

export function RelayOverrideLibraryManager({
  active = true,
  busy,
  onBusy,
  onBindingsChanged
}: {
  active?: boolean
  busy: boolean
  onBusy(value: boolean): void
  onBindingsChanged?(): void
}): React.JSX.Element {
  const config = useRelayOverrideConfig({ busy, onBusy, onBindingsChanged })
  useRelayInitialRead(active, !!config.inventory, config.readLocked, config.read)
  return (
    <section className="relay-panel" id="relay-override-library">
      <h2>覆写管理</h2>
      <p className="text-xs">维护 YAML 或 JavaScript 覆写，按需关联到配置。</p>
      <button disabled={config.readLocked} onClick={() => void config.read().catch(() => {})}>
        刷新
      </button>
      <OverrideManagerView relay={config} />
      <details className="mt-4">
        <summary>高级：配置关联与执行顺序</summary>
        <RelayProfileOverrideSelection config={config} />
      </details>
      {config.fetchPlan && (
        <div>
          <p>
            待确认单次获取：{config.fetchPlan.name} · 固定代理{config.fetchPlan.proxyPort} ·
            来源摘要{config.fetchPlan.sourceFingerprint.slice(0, 12)}
            。只更新库缓存，不更新引用或热载。
          </p>
          <button
            disabled={config.locked}
            onClick={() => void config.executeFetch().catch(() => {})}
          >
            单独确认获取覆写缓存
          </button>
        </div>
      )}
      {config.canCancelFetch && (
        <button disabled={!config.canCancelFetch} onClick={() => void config.cancelFetch()}>
          取消本次覆写获取
        </button>
      )}
      {config.notice && <p role="status">{config.notice}</p>}
    </section>
  )
}

export default Override
