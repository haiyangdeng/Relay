import {
  Button,
  Card,
  CardBody,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Switch
} from '@heroui/react'
import { toast } from '@renderer/components/base/toast'
import { IoMdMore, IoMdRefresh } from 'react-icons/io'
import dayjs from '@renderer/utils/dayjs'
import React, { Key, useMemo, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { openFile, mihomoHotReloadConfig } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import type { RelayOverrideConfig } from '@renderer/hooks/use-relay-override-config'
import type { OverrideLibrarySummary } from '../../../../shared/relay/override-library'
import ExecLogModal from './exec-log-modal'
import EditInfoModal from './edit-info-modal'
import EditFileModal from './edit-file-modal'

interface Props {
  info: IOverrideItem
  addOverrideItem: (item: Partial<IOverrideItem>) => Promise<void>
  updateOverrideItem: (item: IOverrideItem) => Promise<void>
  removeOverrideItem: (id: string) => Promise<void>
  mutateOverrideConfig: () => void
  relay?: { config: RelayOverrideConfig; item: OverrideLibrarySummary }
  sortingDisabled?: boolean
}

interface MenuItem {
  key: string
  label: string
  showDivider: boolean
  color: 'default' | 'danger'
  className: string
}

const OverrideItem: React.FC<Props> = (props) => {
  const { t } = useTranslation()
  const {
    info,
    addOverrideItem,
    removeOverrideItem,
    mutateOverrideConfig,
    updateOverrideItem,
    relay
  } = props
  const bound = relay?.config.bindings?.globalRefs.find((ref) => ref.id === info.id)
  const locked = !!relay?.config.locked
  const [updating, setUpdating] = useState(false)
  const [savingGlobal, setSavingGlobal] = useState(false)
  const [openInfoEditor, setOpenInfoEditor] = useState(false)
  const [openFileEditor, setOpenFileEditor] = useState(false)
  const [openLog, setOpenLog] = useState(false)
  const {
    attributes,
    listeners,
    setNodeRef,
    transform: tf,
    transition,
    isDragging
  } = useSortable({
    id: info.id,
    disabled: locked || props.sortingDisabled
  })
  const transform = tf ? { x: tf.x, y: tf.y, scaleX: 1, scaleY: 1 } : null
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const menuItems: MenuItem[] = useMemo(() => {
    const list = [
      {
        key: 'edit-info',
        label: t('override.menuItems.editInfo'),
        showDivider: false,
        color: 'default',
        className: ''
      } as MenuItem,
      {
        key: 'edit-file',
        label: t('override.menuItems.editFile'),
        showDivider: false,
        color: 'default',
        className: ''
      } as MenuItem,
      {
        key: 'open-file',
        label: t('override.menuItems.openFile'),
        showDivider: false,
        color: 'default',
        className: ''
      } as MenuItem,
      {
        key: 'exec-log',
        label: t('override.menuItems.execLog'),
        showDivider: true,
        color: 'default',
        className: ''
      } as MenuItem,
      {
        key: 'delete',
        label: t('override.menuItems.delete'),
        showDivider: false,
        color: 'danger',
        className: 'text-danger'
      } as MenuItem
    ]
    if (info.ext === 'yaml') {
      list.splice(3, 1)
    }
    return relay ? list.filter((item) => item.key !== 'open-file' && item.key !== 'exec-log') : list
  }, [info, t, relay])
  const onMenuAction = (key: Key): void => {
    if (locked) return
    switch (key) {
      case 'edit-info': {
        setOpenInfoEditor(true)
        break
      }
      case 'edit-file': {
        setOpenFileEditor(true)
        break
      }
      case 'open-file': {
        openFile('override', info.id, info.ext)
        break
      }
      case 'exec-log': {
        setOpenLog(true)
        break
      }
      case 'delete': {
        if (relay) void relay.config.remove(relay.item).catch(() => {})
        else {
          removeOverrideItem(info.id)
          mutateOverrideConfig()
        }
        break
      }
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropdownOpen(true)
  }

  const stopCardInteraction = (e: React.SyntheticEvent): void => {
    e.stopPropagation()
  }

  const handleGlobalChange = async (global: boolean): Promise<void> => {
    setSavingGlobal(true)
    try {
      if (relay) await relay.config.global(relay.item, global)
      else {
        await updateOverrideItem({ ...info, global })
        await mihomoHotReloadConfig()
      }
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSavingGlobal(false)
    }
  }

  return (
    <div
      data-override-id={relay ? info.id : undefined}
      className="grid col-span-1"
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 'calc(infinity)' : undefined
      }}
    >
      {openFileEditor && (
        <EditFileModal
          id={info.id}
          relay={
            relay
              ? {
                  locked: relay.config.readLocked,
                  read: () => relay.config.readItem(info.id),
                  save: relay.config.saveBody
                }
              : undefined
          }
          language={info.ext === 'yaml' ? 'yaml' : 'javascript'}
          onClose={() => setOpenFileEditor(false)}
        />
      )}
      {openInfoEditor && (
        <EditInfoModal
          item={info}
          relay={
            relay
              ? {
                  locked: relay.config.readLocked,
                  read: () => relay.config.readItem(info.id),
                  save: relay.config.saveMetadata
                }
              : undefined
          }
          onClose={() => setOpenInfoEditor(false)}
          updateOverrideItem={updateOverrideItem}
        />
      )}
      {openLog && <ExecLogModal id={info.id} onClose={() => setOpenLog(false)} />}
      <Card
        as="div"
        fullWidth
        className="cursor-pointer"
        onContextMenu={handleContextMenu}
        onDoubleClick={(e) => {
          if (
            (e.target as Element)?.closest(
              '[data-interactive="true"], button, [role="menu"], [role="menuitem"]'
            )
          ) {
            return
          }
          if (!locked) setOpenFileEditor(true)
        }}
      >
        <div ref={setNodeRef} {...attributes} {...listeners} className="h-full w-full">
          <CardBody>
            <div className="flex justify-between h-[32px]">
              <h3
                title={info?.name}
                className={`text-ellipsis whitespace-nowrap overflow-hidden text-md font-bold leading-[32px] text-foreground`}
              >
                {info?.name}
              </h3>
              <div
                className="flex"
                data-interactive="true"
                onPointerDown={stopCardInteraction}
                onClick={stopCardInteraction}
                onDoubleClick={stopCardInteraction}
              >
                {info.type === 'remote' && (
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    color="default"
                    aria-label={relay ? `准备获取覆写 ${info.name}` : undefined}
                    disabled={updating || savingGlobal || locked}
                    onPress={async () => {
                      setUpdating(true)
                      try {
                        if (relay) await relay.config.prepareFetch(relay.item)
                        else {
                          await addOverrideItem(info)
                          await mihomoHotReloadConfig()
                        }
                      } catch (e) {
                        toast.error(String(e))
                      } finally {
                        setUpdating(false)
                      }
                    }}
                  >
                    <IoMdRefresh
                      color="default"
                      className={`text-[24px] ${updating ? 'animate-spin' : ''}`}
                    />
                  </Button>
                )}

                <Dropdown isOpen={dropdownOpen} onOpenChange={setDropdownOpen}>
                  <DropdownTrigger>
                    <Button
                      aria-label={relay ? `覆写操作 ${info.name}` : undefined}
                      isDisabled={locked}
                      isIconOnly
                      size="sm"
                      variant="light"
                      color="default"
                    >
                      <IoMdMore color="default" className={`text-[24px]`} />
                    </Button>
                  </DropdownTrigger>
                  <DropdownMenu onAction={onMenuAction}>
                    {menuItems.map((item) => (
                      <DropdownItem
                        showDivider={item.showDivider}
                        key={item.key}
                        color={item.color}
                        className={item.className}
                      >
                        {item.label}
                      </DropdownItem>
                    ))}
                  </DropdownMenu>
                </Dropdown>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center justify-start">
                <Chip size="sm" variant="bordered">
                  {info.ext === 'yaml' ? 'YAML' : 'JavaScript'}
                </Chip>
              </div>
              <div className="flex items-center justify-end gap-3">
                {relay && (
                  <small>
                    {
                      {
                        missing: '尚无缓存',
                        local: '本地正文',
                        manual: '手动缓存',
                        current: '当前来源缓存',
                        stale: '旧来源缓存，需重新获取'
                      }[relay.item.bodyState]
                    }{' '}
                    · {relay.item.bodyRevision.slice(0, 8) || '无正文'}
                  </small>
                )}
                {relay && bound && bound.bodyRevision !== relay.item.bodyRevision && (
                  <small>全局仍引用 {bound.bodyRevision.slice(0, 8)}</small>
                )}
                {relay &&
                  bound &&
                  bound.bodyRevision !== relay.item.bodyRevision &&
                  relay.config.usable(relay.item) && (
                    <Button
                      size="sm"
                      isDisabled={locked}
                      onPress={() => void relay.config.refresh([info.id]).catch(() => {})}
                    >
                      更新全局引用
                    </Button>
                  )}
                {info.type === 'remote' && <small>{dayjs(info.updated).fromNow()}</small>}
                <div
                  data-interactive="true"
                  className="flex items-center gap-2"
                  onClick={stopCardInteraction}
                  onDoubleClick={stopCardInteraction}
                  onPointerDown={stopCardInteraction}
                >
                  <span className="text-xs text-default-500">{t('override.editInfo.global')}</span>
                  <Switch
                    size="sm"
                    aria-label={relay ? `全局覆写 ${info.name}` : t('override.editInfo.global')}
                    isSelected={Boolean(info.global)}
                    isDisabled={
                      updating ||
                      savingGlobal ||
                      locked ||
                      (!!relay && !info.global && !relay.config.usable(relay.item))
                    }
                    onValueChange={handleGlobalChange}
                  />
                </div>
              </div>
            </div>
          </CardBody>
        </div>
      </Card>
    </div>
  )
}

export default OverrideItem
