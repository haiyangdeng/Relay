import { useMemo, useState } from 'react'
import { Button, Input } from '@heroui/react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import SortableGroup from '@renderer/components/proxies/sortable-group'
import { parseSimpleRule, SIMPLE_RULE_TYPES } from '../../../../shared/simple-rules'
import type { RelayProfileRules } from '../../../../shared/relay/profiles'
import {
  patchRule,
  positionedRule,
  ruleRows,
  type RelayRuleRow
} from '../../utils/relay-rule-editor'
import RuleItem from './rule-item'
import RuleEditorModal from './rule-editor-modal'

export function RelayRuleListEditor({
  label,
  rows,
  onChange,
  context,
  locked = false,
  patchKind
}: {
  label: string
  rows: RelayRuleRow[]
  onChange(rows: RelayRuleRow[]): boolean
  context?: RelayProfileRules
  locked?: boolean
  patchKind?: 'prepend' | 'append' | 'delete'
}): React.JSX.Element {
  const [filter, setFilter] = useState(''),
    [editor, setEditor] = useState<{ key?: string; insertAt: number; position: string }>(),
    [dragging, setDragging] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const visible = useMemo(
    () => rows.filter((row) => row.value.toLowerCase().includes(filter.toLowerCase())),
    [rows, filter]
  )
  const positionMode = patchKind === 'prepend' || patchKind === 'append'
  const open = (key?: string, insertAt = rows.length): void => {
    if (locked || dragging || !context) return
    const row = rows.find((item) => item.key === key)
    setEditor({ key, insertAt, position: positionMode && row ? patchRule(row.value).position : '' })
  }
  const reorder = ({ active, over }: DragEndEvent): void => {
    setDragging(false)
    if (locked || filter.trim() || editor || !over || active.id === over.id) return
    const from = rows.findIndex((row) => row.key === active.id),
      to = rows.findIndex((row) => row.key === over.id)
    if (from >= 0 && to >= 0) onChange(arrayMove(rows, from, to))
  }
  const current = editor?.key ? rows.find((row) => row.key === editor.key) : undefined
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      <Input
        size="sm"
        aria-label={`${label}筛选`}
        placeholder="筛选只影响显示，不会保存筛选子集"
        value={filter}
        isDisabled={locked}
        onValueChange={setFilter}
      />
      <Button
        size="sm"
        isDisabled={locked || !context || !!editor || dragging}
        onPress={() => open()}
      >
        添加{label}
      </Button>
      {filter.trim() && <p>筛选中禁止拖动排序；删除或编辑仍按原行身份操作，全表保留。</p>}
      {!context && <p>先显式读取来源规则上下文，才能使用类型／目标编辑器；已有原串仍保留。</p>}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => setDragging(true)}
        onDragEnd={reorder}
        onDragCancel={() => setDragging(false)}
      >
        <SortableContext
          items={visible.map((row) => row.key)}
          strategy={verticalListSortingStrategy}
        >
          {visible.map((row) => {
            const index = rows.findIndex((item) => item.key === row.key),
              entry = positionMode ? patchRule(row.value) : { rule: row.value, position: '' },
              parsed = parseSimpleRule(entry.rule)
            const content = (
              <>
                {entry.position && <p>原位置前缀：{entry.position}</p>}
                {!SIMPLE_RULE_TYPES.includes(parsed.type) && (
                  <p>
                    此规则暂不能由当前结构化类型解释，原串保留：<code>{row.value}</code>
                    。修改后仍须独立检查。
                  </p>
                )}
                <RuleItem
                  index={index}
                  type={parsed.type}
                  payload={parsed.payload || parsed.type}
                  proxy={parsed.target}
                  size={-1}
                  deleteDescription={
                    patchKind
                      ? '仅从当前补丁草稿移除此项；不会切换运行规则的禁用位，保存补丁仍需独立操作。'
                      : '仅从完整规则草稿移除此行；原配置与运行规则不变，另存新副本仍需独立确认。'
                  }
                  onEdit={!locked && context ? () => open(row.key) : undefined}
                  onDelete={
                    !locked
                      ? async () => {
                          if (!onChange(rows.filter((item) => item.key !== row.key)))
                            throw new Error('规则上下文已失效。')
                        }
                      : undefined
                  }
                />
              </>
            )
            return (
              <div key={row.key} data-rule-row={row.key}>
                {filter.trim() ? (
                  <div>{content}</div>
                ) : (
                  <SortableGroup name={row.key} disabled={locked || !!editor}>
                    {content}
                  </SortableGroup>
                )}
                <Button
                  size="sm"
                  isDisabled={locked || !context || !!editor || dragging}
                  onPress={() => open(undefined, index + 1)}
                >
                  在第{index + 1}行后插入
                </Button>
              </div>
            )
          })}
        </SortableContext>
      </DndContext>
      {editor && context && (
        <RuleEditorModal
          key={editor.key ?? 'new'}
          index={current ? rows.findIndex((row) => row.key === current.key) : null}
          initialValue={
            current ? (positionMode ? patchRule(current.value).rule : current.value) : undefined
          }
          data={{
            rules: rows.map((row) => (positionMode ? patchRule(row.value).rule : row.value)),
            outbounds: context.targets,
            subRules: context.subRules,
            ruleProviders: context.providers
          }}
          locked={locked}
          onClose={() => setEditor(undefined)}
          position={
            positionMode
              ? {
                  value: editor.position,
                  onChange: (value) => setEditor({ ...editor, position: value })
                }
              : undefined
          }
          onCommit={async (value) => {
            if (locked) throw new Error('当前操作尚未结束。')
            const nextValue = positionMode
              ? positionedRule(value, editor.position, current?.value)
              : value
            if (current) {
              if (
                !onChange(
                  rows.map((row) => (row.key === current.key ? { ...row, value: nextValue } : row))
                )
              )
                throw new Error('规则上下文已失效。')
            } else {
              const next = [...rows]
              next.splice(editor.insertAt, 0, ...ruleRows([nextValue]))
              if (!onChange(next)) throw new Error('规则上下文已失效。')
            }
          }}
        />
      )}
    </section>
  )
}
