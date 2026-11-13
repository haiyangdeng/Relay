import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/react'
import { useRef, useState } from 'react'
import { IoEllipsisVertical } from 'react-icons/io5'
import type {
  RelayStoredProfile,
  RelayProfileExportResult
} from '../../../../shared/relay/profiles'
import type { RelayLibraryInventory, RelayLibraryKind } from '../../../../shared/relay/library'

// Same immutable profile export and revision-checked library operations as the
// full library, exposed on the card like the upstream ProfileItem menu.
export function RelayProfileCardMenu({
  profile,
  source,
  disabled,
  onBusy,
  onChanged
}: {
  profile?: RelayStoredProfile
  source?: { id: string; name: string }
  disabled: boolean
  onBusy(value: boolean): void
  onChanged(): Promise<void>
}): React.JSX.Element {
  const [dialog, setDialog] = useState<'original' | 'rename' | 'hide'>()
  const [original, setOriginal] = useState('')
  const [name, setName] = useState('')
  const [inventory, setInventory] = useState<RelayLibraryInventory>()
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const working = useRef(false)
  const kind: RelayLibraryKind = source ? 'source' : 'profile'
  const id = source?.id ?? profile?.id
  const item = inventory?.items.find((entry) => entry.id === id && entry.kind === kind)
  const run = async (task: () => Promise<void>): Promise<void> => {
    if (working.current || disabled) return
    working.current = true
    setPending(true)
    setNotice('')
    onBusy(true)
    try {
      await task()
    } catch {
      setNotice('操作未完成，请重新打开菜单后重试。')
    } finally {
      working.current = false
      setPending(false)
      onBusy(false)
    }
  }
  const open = (action: 'original' | 'rename' | 'hide' | 'export'): void => {
    void run(async () => {
      if (action === 'export' && profile) {
        const result = (await window.electron.ipcRenderer.invoke('relayProfileExport', {
          id: profile.id,
          sha256: profile.sha256
        })) as RelayProfileExportResult
        setNotice(result.status === 'exported' ? '配置原文已导出。' : '已取消导出。')
      } else if (action === 'original' && profile) {
        setOriginal('')
        setDialog(action)
        const text: unknown = await window.electron.ipcRenderer.invoke('getProfileStr', {
          id: profile.id,
          sha256: profile.sha256
        })
        if (typeof text !== 'string') throw new Error('配置原文未确认')
        setOriginal(text)
      } else if (action === 'rename' || action === 'hide') {
        setInventory(undefined)
        setName(source?.name ?? profile?.name ?? '')
        setDialog(action)
        setInventory(await window.electron.ipcRenderer.invoke('relayLibraryList'))
      }
    })
  }
  const save = (): void => {
    if (!inventory || !item || !id || (dialog !== 'rename' && dialog !== 'hide')) return
    void run(async () => {
      await window.electron.ipcRenderer.invoke('relayLibraryChange', {
        kind,
        id,
        expectedRevision: inventory.revision,
        action: dialog,
        ...(dialog === 'rename' ? { name: name.trim() } : {})
      })
      setDialog(undefined)
      await onChanged()
    })
  }
  const close = (): void => {
    if (!pending) {
      setDialog(undefined)
      setOriginal('')
      setInventory(undefined)
    }
  }
  return (
    <>
      <Dropdown>
        <DropdownTrigger>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={`管理配置 ${source?.name ?? profile?.name ?? ''}`}
            isDisabled={disabled || pending}
          >
            <IoEllipsisVertical />
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label="配置操作"
          onAction={(key) => open(key as 'original' | 'rename' | 'hide' | 'export')}
          disabledKeys={profile ? [] : ['original', 'export']}
        >
          <DropdownItem key="original">查看原文</DropdownItem>
          <DropdownItem key="rename">重命名</DropdownItem>
          <DropdownItem key="export">导出原文</DropdownItem>
          <DropdownItem key="hide" color="danger">
            移出列表
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>
      {!dialog && notice && (
        <span role="status" className="text-xs px-2">
          {notice}
        </span>
      )}
      <Modal
        isOpen={!!dialog}
        onClose={close}
        size={dialog === 'original' ? '3xl' : 'md'}
        scrollBehavior="inside"
        isDismissable={!pending}
        isKeyboardDismissDisabled={pending}
        hideCloseButton={pending}
      >
        <ModalContent>
          <ModalHeader>
            {dialog === 'original' ? '配置原文' : dialog === 'rename' ? '重命名' : '移出列表'}
          </ModalHeader>
          <ModalBody>
            {dialog === 'original' ? (
              <pre className="text-xs whitespace-pre-wrap break-all select-text">
                {original || (pending ? '正在读取…' : '暂无内容')}
              </pre>
            ) : dialog === 'rename' ? (
              <Input
                aria-label="配置显示名称"
                value={name}
                maxLength={120}
                onValueChange={setName}
                isDisabled={pending}
              />
            ) : (
              <p className="text-sm">
                将“{source?.name ?? profile?.name}
                ”移出列表。原文件和历史版本保留，可在高级管理中恢复。
              </p>
            )}
            {item &&
              dialog === 'hide' &&
              (item.active || item.protectionReason || item.scheduled) && (
                <p className="text-warning text-sm">
                  当前配置正在使用、待核对或启用了定时更新，暂不能移出。
                </p>
              )}
            {notice && (
              <p role="status" className="text-sm">
                {notice}
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" isDisabled={pending} onPress={close}>
              关闭
            </Button>
            {dialog !== 'original' && (
              <Button
                color={dialog === 'hide' ? 'danger' : 'primary'}
                isLoading={pending}
                isDisabled={
                  pending ||
                  !item ||
                  (dialog === 'rename'
                    ? !name.trim()
                    : !!(item.active || item.protectionReason || item.scheduled))
                }
                onPress={save}
              >
                {dialog === 'rename' ? '保存' : '移出列表'}
              </Button>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
