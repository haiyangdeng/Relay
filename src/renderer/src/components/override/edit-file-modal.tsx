import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from '@heroui/react'
import { toast } from '@renderer/components/base/toast'
import React, { useEffect, useRef, useState } from 'react'
import { getOverride, mihomoHotReloadConfig, setOverride } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import { BaseEditor } from '../base/base-editor'
import type { OverrideLibraryRecord } from '../../../../shared/relay/override-library'

interface Props {
  id: string
  language: 'javascript' | 'yaml'
  onClose: () => void
  relay?: {
    locked: boolean
    read(): Promise<OverrideLibraryRecord>
    save(record: OverrideLibraryRecord, content: string): Promise<void>
  }
}
const EditFileModal: React.FC<Props> = (props) => {
  const { id, language, onClose, relay } = props
  const [currData, setCurrData] = useState('')
  const { t } = useTranslation()
  const [record, setRecord] = useState<OverrideLibraryRecord>(),
    [loading, setLoading] = useState(!!relay),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [refreshNeeded, setRefreshNeeded] = useState(false)
  const adapter = useRef(relay),
    alive = useRef(true)
  adapter.current = relay
  const relayMode = !!relay,
    locked = loading || saving || !!relay?.locked

  useEffect(() => {
    let current = true
    alive.current = true
    const loadContent = async (): Promise<void> => {
      try {
        if (relayMode) {
          setLoading(true)
          setRecord(undefined)
        }
        const result = relayMode ? await adapter.current?.read() : undefined
        const content = relayMode
          ? (result?.item.content ?? '')
          : await getOverride(id, language === 'javascript' ? 'js' : 'yaml')
        if (!current) return
        setRecord(result)
        setCurrData(content)
      } catch {
        if (current) setError('正文读取未确认，请关闭后重新读取；未保存或执行。')
      } finally {
        if (current) setLoading(false)
      }
    }
    void loadContent()
    return () => {
      current = false
      alive.current = false
    }
  }, [id, language, relayMode])

  return (
    <Modal
      backdrop="blur"
      classNames={{ backdrop: 'top-[48px]' }}
      size="5xl"
      hideCloseButton
      isOpen={true}
      onOpenChange={() => {
        if (!relay || !locked) onClose()
      }}
      isDismissable={!relay || !locked}
      isKeyboardDismissDisabled={!!relay && locked}
      scrollBehavior="inside"
    >
      <ModalContent className="h-full w-[calc(100%-100px)]">
        <ModalHeader className="flex pb-0 app-drag">
          {t('override.editFile.title', {
            type:
              language === 'javascript'
                ? t('override.editFile.script')
                : t('override.editFile.config')
          })}
        </ModalHeader>
        <ModalBody className="h-full">
          {relay && (
            <p>惰性正文保存，不执行脚本、不更新已存引用、不热载核心；版本冲突时保留草稿。</p>
          )}
          {loading && <p role="status">正在读取所选覆写正文…</p>}
          {error && <p role="alert">{error}</p>}
          <BaseEditor
            readOnly={!!relay && (locked || !record || refreshNeeded)}
            language={language}
            value={currData}
            onChange={(value) => setCurrData(value)}
          />
        </ModalBody>
        <ModalFooter className="pt-0">
          <Button size="sm" variant="light" isDisabled={!!relay && locked} onPress={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            color="primary"
            isDisabled={!!relay && (locked || !record || refreshNeeded)}
            onPress={async () => {
              if (relay) {
                if (!record || locked) return
                setSaving(true)
                setError('')
                try {
                  await relay.save(record, currData)
                  if (alive.current) onClose()
                } catch (error) {
                  if (alive.current) {
                    const saved =
                      error instanceof Error && error.name === 'OverrideLibraryRefreshError'
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
              try {
                await setOverride(id, language === 'javascript' ? 'js' : 'yaml', currData)
                await mihomoHotReloadConfig()
                onClose()
              } catch (e) {
                toast.error(String(e))
              }
            }}
          >
            {t('common.confirm')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default EditFileModal
