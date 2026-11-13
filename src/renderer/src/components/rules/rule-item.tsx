import { Button, Card, CardBody, Chip, Switch } from '@heroui/react'
import { MdEdit } from 'react-icons/md'
import React, { useState, useEffect } from 'react'
import { mihomoRulesDisable } from '@renderer/utils/ipc'
import { useTranslation } from 'react-i18next'
import DeleteResourceButton from '../simple/delete-resource-button'
import type { LocalProxyRule } from '../../../../shared/relay/local-proxy'

interface RuleItemProps extends IMihomoRulesDetail {
  index: number
  onEdit?: () => void
  onDelete?: () => Promise<void>
  deleteDescription?: string
  runtimeStatistics?: LocalProxyRule['statistics']
  runtimeToggle?: {
    disabled: boolean
    locked: boolean
    onChange(disabled: boolean): Promise<void>
  }
}

const RuleItem: React.FC<RuleItemProps> = (props) => {
  const { t } = useTranslation()
  const { type, payload, proxy, index: listIndex, extra, onEdit, onDelete, runtimeToggle } = props
  const ruleIndex = props.index ?? listIndex

  const [isEnabled, setIsEnabled] = useState(!extra?.disabled)

  useEffect(() => {
    setIsEnabled(!extra?.disabled)
  }, [extra?.disabled])

  const handleToggle = async (v: boolean): Promise<void> => {
    if (runtimeToggle) {
      if (!runtimeToggle.locked) await runtimeToggle.onChange(!v)
      return
    }
    setIsEnabled(v)
    try {
      await mihomoRulesDisable({ [ruleIndex]: !v })
    } catch (error) {
      console.error('Failed to toggle rule:', error)
      setIsEnabled(!v)
    }
  }

  const formatRelativeTime = (timestamp: string): string => {
    const time = new Date(timestamp).getTime()
    if (time === 0) return t('rules.hitAt.never')
    const now = Date.now()
    const diff = Math.floor((now - time) / 1000)
    if (diff < 60) return t('rules.hitAt.seconds')
    if (diff < 3600) return t('rules.hitAt.minutes', { count: Math.floor(diff / 60) })
    if (diff < 86400) return t('rules.hitAt.hours', { count: Math.floor(diff / 3600) })
    return t('rules.hitAt.days', { count: Math.floor(diff / 86400) })
  }

  return (
    <div className={`w-full px-2 pb-2 ${listIndex === 0 ? 'pt-2' : ''}`}>
      <Card
        as="div"
        fullWidth
        isPressable={!!onEdit}
        onPress={onEdit}
        className={
          !onEdit && (runtimeToggle ? runtimeToggle.disabled : !isEnabled) ? 'opacity-50' : ''
        }
      >
        <CardBody className="py-3 px-4">
          <div className="flex justify-between items-center gap-4">
            {/* 左侧：规则信息 */}
            <div className="flex-1 min-w-0 flex items-center gap-3">
              {/* 规则内容 */}
              <div className="flex-1 min-w-0">
                <div title={payload} className="text-sm font-medium truncate mb-1.5">
                  {payload}
                </div>
                <div className="flex items-center gap-2">
                  <Chip size="sm" radius="sm" variant="bordered" className="text-xs">
                    {type}
                  </Chip>
                  <Chip size="sm" radius="sm" variant="bordered" className="text-xs">
                    {proxy}
                  </Chip>
                </div>
              </div>
            </div>

            {onEdit && (
              <div
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <Button
                  size="sm"
                  isIconOnly
                  variant="light"
                  title="编辑规则"
                  aria-label={`编辑规则 ${listIndex + 1}`}
                  onPress={onEdit}
                >
                  <MdEdit className="text-lg text-foreground-500" />
                </Button>
              </div>
            )}
            {onDelete && (
              <DeleteResourceButton
                label={`规则 ${listIndex + 1}`}
                onDelete={onDelete}
                confirmContent={props.deleteDescription}
              />
            )}
            {props.runtimeStatistics && (
              <div
                className="flex flex-wrap justify-end items-center gap-2 text-xs"
                data-rule-statistics
              >
                {props.runtimeStatistics.hitAt && (
                  <span className="text-foreground-500 whitespace-nowrap">
                    {formatRelativeTime(props.runtimeStatistics.hitAt)}
                  </span>
                )}
                <span className="whitespace-nowrap">
                  {props.runtimeStatistics.hitCount}/
                  {props.runtimeStatistics.hitCount + props.runtimeStatistics.missCount}
                </span>
                <Chip size="sm" variant="flat" color="primary" className="text-xs">
                  {(props.runtimeStatistics.hitCount + props.runtimeStatistics.missCount > 0
                    ? (100 * props.runtimeStatistics.hitCount) /
                      (props.runtimeStatistics.hitCount + props.runtimeStatistics.missCount)
                    : 0
                  ).toFixed(1)}
                  %
                </Chip>
              </div>
            )}
            {runtimeToggle && (
              <Switch
                size="sm"
                isSelected={!runtimeToggle.disabled}
                isDisabled={runtimeToggle.locked}
                onValueChange={handleToggle}
                aria-label={`临时启用规则 ${listIndex + 1}`}
              />
            )}
            {!onEdit &&
              !runtimeToggle &&
              extra &&
              (() => {
                const total = extra.hitCount + extra.missCount
                const rate = total > 0 ? (extra.hitCount / total) * 100 : 0
                return (
                  <>
                    <div className="flex items-center gap-3 text-xs shrink-0">
                      <span className="text-foreground-500 whitespace-nowrap">
                        {formatRelativeTime(extra.hitAt || extra.missAt)}
                      </span>
                      <span className="text-foreground-600 font-medium whitespace-nowrap">
                        {extra.hitCount}/{total}
                      </span>
                      <Chip size="sm" variant="flat" color="primary" className="text-xs">
                        {rate.toFixed(1)}%
                      </Chip>
                    </div>
                    <Switch
                      size="sm"
                      isSelected={isEnabled}
                      onValueChange={handleToggle}
                      aria-label="Toggle rule"
                    />
                  </>
                )
              })()}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

export default RuleItem
