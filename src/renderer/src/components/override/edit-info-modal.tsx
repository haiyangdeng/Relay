import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Switch
} from '@heroui/react'
import React, { useEffect, useRef, useState } from 'react'
import { mihomoHotReloadConfig } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import SettingItem from '../base/base-setting-item'
import type {
  OverrideLibraryRecord,
  OverrideLibraryRemote
} from '../../../../shared/relay/override-library'

interface Props {
  item: IOverrideItem
  updateOverrideItem: (item: IOverrideItem) => Promise<void>
  onClose: () => void
  relay?: {
    locked: boolean
    read(): Promise<OverrideLibraryRecord>
    save(record: OverrideLibraryRecord, name: string, remote?: OverrideLibraryRemote): Promise<void>
  }
}
const EditInfoModal: React.FC<Props> = (props) => {
  const { item, updateOverrideItem, onClose, relay } = props
  const [values, setValues] = useState(item)
  const { t } = useTranslation()
  const [record, setRecord] = useState<OverrideLibraryRecord>(),
    [remoteURL, setRemoteURL] = useState(''),
    [port, setPort] = useState('17891'),
    [name, setName] = useState(''),
    [loading, setLoading] = useState(!!relay),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [refreshNeeded, setRefreshNeeded] = useState(false)
  const relayRef = useRef(relay),
    alive = useRef(true)
  relayRef.current = relay
  const relayMode = !!relay
  useEffect(() => {
    alive.current = true
    let current = true
    if (relayMode) {
      setLoading(true)
      setRecord(undefined)
      void relayRef.current
        ?.read()
        .then((result) => {
          if (!current) return
          setRecord(result)
          setName(result.item.name)
          setRemoteURL(result.item.remote?.url ?? '')
          setPort(String(result.item.remote?.proxyPort ?? 17891))
        })
        .catch(() => {
          if (current) setError('元信息读取未确认，请关闭后重新读取；未修改资料。')
        })
        .finally(() => {
          if (current) setLoading(false)
        })
    }
    return () => {
      current = false
      alive.current = false
    }
  }, [item.id, relayMode])
  const locked = loading || saving || !!relay?.locked

  const onSave = async (): Promise<void> => {
    if (relay) {
      if (!record || locked) return
      setSaving(true)
      setError('')
      try {
        await relay.save(
          record,
          name,
          record.item.type === 'remote' ? { url: remoteURL, proxyPort: Number(port) } : undefined
        )
        if (alive.current) onClose()
      } catch (error) {
        if (alive.current) {
          const saved = error instanceof Error && error.name === 'OverrideLibraryRefreshError'
          setRefreshNeeded(saved)
          setError(
            saved
              ? '本次库写入已确认，但刷新失败；草稿保留，请关闭后重新读取核对，不要重复提交旧修订。'
              : '版本变化或保存未确认；草稿保留，请核对修订，没有获取、执行或应用核心配置。'
          )
        }
      } finally {
        if (alive.current) setSaving(false)
      }
      return
    }
    await updateOverrideItem(values)
    await mihomoHotReloadConfig()
    onClose()
  }

  return (
    <Modal
      backdrop="blur"
      classNames={{ backdrop: 'top-[48px]' }}
      hideCloseButton
      isOpen={true}
      onOpenChange={() => {
        if (!relay || !locked) onClose()
      }}
      isDismissable={!relay || !locked}
      isKeyboardDismissDisabled={!!relay && locked}
      scrollBehavior="inside"
    >
      <ModalContent>
        <ModalHeader className="flex app-drag">{t('override.editInfo.title')}</ModalHeader>
        <ModalBody>
          {relay && <p>仅保存名称与远端定义；类型不可更改，不获取正文、不更新引用或热载核心。</p>}
          {loading && <p role="status">正在读取所选覆写元信息…</p>}
          {error && <p role="alert">{error}</p>}
          <SettingItem title={t('override.editInfo.name')}>
            <Input
              size="sm"
              className="w-[200px]"
              aria-label={relay ? '覆写名称' : undefined}
              isDisabled={!!relay && locked}
              value={relay ? name : values.name}
              onValueChange={(v) => {
                if (relay) setName(v)
                else setValues({ ...values, name: v })
              }}
            />
          </SettingItem>
          {(relay ? record?.item.type : values.type) === 'remote' && (
            <SettingItem title={t('override.editInfo.url')}>
              <Input
                size="sm"
                className="w-[200px]"
                aria-label={relay ? '覆写远端地址' : undefined}
                isDisabled={!!relay && locked}
                value={relay ? remoteURL : values.url}
                onValueChange={(v) => {
                  if (relay) setRemoteURL(v)
                  else setValues({ ...values, url: v })
                }}
              />
            </SettingItem>
          )}
          {relay && record?.item.type === 'remote' && (
            <SettingItem title="固定本地HTTP代理端口">
              <Input
                aria-label="覆写代理端口"
                size="sm"
                value={port}
                isDisabled={locked}
                onValueChange={setPort}
              />
            </SettingItem>
          )}
          {!relay && (
            <SettingItem title={t('override.editInfo.global')}>
              <Switch
                size="sm"
                isSelected={values.global}
                onValueChange={(v) => {
                  setValues({ ...values, global: v })
                }}
              />
            </SettingItem>
          )}
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="light" isDisabled={!!relay && locked} onPress={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            color="primary"
            isDisabled={!!relay && (locked || !record || refreshNeeded)}
            onPress={onSave}
          >
            {t('common.save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default EditInfoModal
