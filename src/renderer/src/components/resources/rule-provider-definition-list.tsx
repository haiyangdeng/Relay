import { Button, Input } from '@heroui/react'
import { includesIgnoreCase } from '../../utils/includes'
import DeleteResourceButton from '../simple/delete-resource-button'

// Passive saved-definition view: no SWR, runtime updater or file-path viewer.
export function RuleProviderDefinitionList({
  definitions,
  filter,
  onFilter,
  onEdit,
  onRemove,
  locked
}: {
  definitions: Record<string, Record<string, unknown>>
  filter: string
  onFilter(value: string): void
  onEdit(name: string): void
  onRemove(name: string): Promise<void>
  locked: boolean
}): React.JSX.Element {
  const rows = Object.entries(definitions).filter(([name]) => includesIgnoreCase(name, filter))
  return (
    <div aria-label="已读规则提供者定义列表">
      <Input
        aria-label="筛选规则提供者定义"
        value={filter}
        onValueChange={onFilter}
        isDisabled={locked}
      />
      {rows.map(([name, value]) => (
        <div key={name} className="flex min-w-0 items-center gap-2 border-b border-divider py-3">
          <div className="min-w-0 flex-1">
            <div className="break-words">{name}</div>
            <div className="text-xs text-foreground-500">
              {typeof value.type === 'string' ? value.type : '未确认类型'} ·{' '}
              {typeof value.behavior === 'string' ? value.behavior : '未确认行为'} ·{' '}
              {typeof value.format === 'string'
                ? value.format
                : value.type === 'inline'
                  ? 'inline'
                  : '未定义格式'}
              ；保存定义，不是活动数量／更新时间
            </div>
          </div>
          <Button
            aria-label={`编辑规则集 ${name}`}
            isDisabled={locked}
            onPress={() => onEdit(name)}
          >
            编辑
          </Button>
          <DeleteResourceButton
            label={`规则集 ${name}`}
            disabled={locked}
            confirmContent="仅从本地草稿移除；不会自动清理RULE-SET或其他引用。准备副本时由后端检查引用，原配置和活动实例不变。"
            onDelete={() => onRemove(name)}
          />
        </div>
      ))}
      {!rows.length && <p>没有匹配的保存定义；筛选不会删除其他条目。</p>}
    </div>
  )
}
