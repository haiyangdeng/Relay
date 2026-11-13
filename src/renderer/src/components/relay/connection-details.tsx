import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react'
import { useState } from 'react'
import type { ObservedConnection } from './runtime-info'
import { formatTraffic } from './runtime-info'

// The upstream detail modal includes rule-editing actions for its own profile
// store. Keep the same read/copy workflow here, scoped to this observed snapshot.
export function RelayConnectionDetails({
  entry,
  onClose
}: {
  entry: ObservedConnection
  onClose(): void
}): React.JSX.Element {
  const [notice, setNotice] = useState('')
  const rows = [
    ['来源', entry.source || '未提供'],
    ['目标', entry.target],
    ['协议', entry.protocol || '未提供'],
    ['进程', entry.process],
    ['代理链', entry.route || '未提供'],
    ['命中规则', entry.rule || '未提供'],
    [
      '连接时间',
      entry.startedAt === undefined ? '未提供' : new Date(entry.startedAt).toLocaleString()
    ],
    ['上传', formatTraffic(entry.upload)],
    ['下载', formatTraffic(entry.download)],
    ['连接 ID', entry.id || '未提供']
  ]
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(
        rows.map(([label, value]) => `${label}: ${value}`).join('\n')
      )
      setNotice('已复制连接详情。')
    } catch {
      setNotice('复制失败，可直接选择文字复制。')
    }
  }
  return (
    <Modal isOpen onClose={onClose} scrollBehavior="inside" size="xl">
      <ModalContent>
        <ModalHeader>连接详情</ModalHeader>
        <ModalBody>
          <p className="text-xs text-default-500">打开时的连接快照</p>
          <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-3 text-sm select-text">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-default-500">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
          {notice && (
            <p role="status" className="text-xs">
              {notice}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="flat" onPress={() => void copy()}>
            复制详情
          </Button>
          <Button size="sm" color="primary" onPress={onClose}>
            完成
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
