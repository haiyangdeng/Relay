import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Radio,
  RadioGroup,
  Textarea,
  Input
} from '@heroui/react'
import React, { useEffect, useRef, useState } from 'react'
import { saveSimpleRules } from '@renderer/utils/ipc'
import { parseSimpleRule, SIMPLE_RULE_TYPES } from '../../../../shared/simple-rules'
import type { SimpleRuleEditor } from '../../../../shared/simple-config'

interface Props {
  index: number | null
  insertAt?: number
  initialValue?: string
  data: Pick<SimpleRuleEditor, 'rules' | 'outbounds' | 'subRules'> & {
    ruleProviders: SimpleRuleEditor['ruleProviders'] | readonly string[]
  }
  onClose: () => void
  onSaved?: () => void
  onCommit?(value: string): Promise<void>
  locked?: boolean
  position?: { value: string; onChange(value: string): void }
}

const RuleEditorModal: React.FC<Props> = (props) => {
  const { index, data, onClose, onSaved, onCommit, locked = false } = props
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const original = index === null ? (onCommit ? props.initialValue : undefined) : data.rules[index]
  const initialValue = original ?? props.initialValue
  const initial = initialValue
    ? parseSimpleRule(initialValue)
    : {
        type: 'DOMAIN-SUFFIX',
        payload: '',
        target: data.outbounds.includes('PROXY') ? 'PROXY' : 'DIRECT',
        options: []
      }
  const [form, setForm] = useState(initial)
  const insertAt = props.insertAt ?? data.rules.length
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const types = [...new Set([...SIMPLE_RULE_TYPES, form.type])]
  const targets = form.type === 'SUB-RULE' ? data.subRules : data.outbounds
  const supportsResolve = [
    'GEOIP',
    'IP-ASN',
    'IP-CIDR',
    'IP-CIDR6',
    'IP-SUFFIX',
    'RULE-SET'
  ].includes(form.type)
  const supportsSource = ['GEOIP', 'IP-ASN', 'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX'].includes(form.type)
  const save = async (): Promise<void> => {
    if (saving || locked) return
    setSaving(true)
    setError('')
    try {
      const unchanged = original !== undefined && JSON.stringify(form) === JSON.stringify(initial)
      if (!unchanged || !onCommit) {
        if (!form.target || !targets.includes(form.target)) throw new Error('请选择有效的目标')
        if (form.type !== 'MATCH' && !form.payload.trim()) throw new Error('规则内容不能为空')
        if (onCommit && form.options.length > 1)
          throw new Error('请明确选择一个匹配方式后保存修改。')
      }
      const value = unchanged
        ? original
        : [
            form.type,
            ...(form.type === 'MATCH' ? [] : [form.payload.trim()]),
            form.target,
            ...form.options.slice(0, 1)
          ].join(',')
      if (
        index === null &&
        (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > data.rules.length)
      )
        throw new Error('插入位置无效')
      if (onCommit) await onCommit(value)
      else
        await saveSimpleRules(
          { action: index === null ? 'add' : 'edit', index: index ?? insertAt, value },
          data.rules
        )
      if (!mounted.current) return
      onSaved?.()
      onClose()
    } catch (error) {
      if (mounted.current)
        setError(onCommit ? '规则草稿未确认，请核对目标、选项与内容；输入保留。' : String(error))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }
  return (
    <Modal
      isOpen
      hideCloseButton
      size="2xl"
      backdrop="blur"
      scrollBehavior="inside"
      isDismissable={!saving && !locked}
      isKeyboardDismissDisabled={saving || locked}
      onClose={onClose}
      classNames={{ backdrop: 'top-[48px]', base: 'max-h-[calc(100dvh-80px)]' }}
    >
      <ModalContent>
        <ModalHeader className="app-drag">{index === null ? '添加规则' : '编辑规则'}</ModalHeader>
        <ModalBody>
          {props.position && (
            <Input
              label="规则插入位置（可选整数）"
              description="留空使用普通前置／后置；已有位置前缀未修改时原样保留。"
              value={props.position.value}
              isDisabled={saving || locked}
              onValueChange={props.position.onChange}
            />
          )}
          <fieldset
            disabled={saving || locked}
            className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <Select
              size="sm"
              label="类型"
              disallowEmptySelection
              selectedKeys={[form.type]}
              onSelectionChange={(keys) => {
                const type = String(Array.from(keys)[0] || form.type)
                if (type === form.type) return
                setForm((current) => ({
                  ...current,
                  type,
                  options: [],
                  payload: '',
                  target:
                    type === 'SUB-RULE'
                      ? ''
                      : data.outbounds.includes(current.target)
                        ? current.target
                        : 'DIRECT'
                }))
              }}
            >
              {types.map((type) => (
                <SelectItem key={type}>{type}</SelectItem>
              ))}
            </Select>
            <Select
              size="sm"
              label={form.type === 'SUB-RULE' ? '子规则' : '目标代理'}
              selectedKeys={form.target ? [form.target] : []}
              onSelectionChange={(keys) =>
                setForm({ ...form, target: String(Array.from(keys)[0] || '') })
              }
            >
              {[...new Set([...targets, ...(form.target ? [form.target] : [])])].map((name) => (
                <SelectItem key={name}>{name}</SelectItem>
              ))}
            </Select>
            {form.type === 'RULE-SET' ? (
              <Select
                size="sm"
                className="sm:col-span-2"
                label="规则集"
                selectedKeys={form.payload ? [form.payload] : []}
                onSelectionChange={(keys) =>
                  setForm({ ...form, payload: String(Array.from(keys)[0] || '') })
                }
              >
                {[
                  ...new Set([
                    ...(Array.isArray(data.ruleProviders)
                      ? data.ruleProviders
                      : Object.keys(data.ruleProviders)),
                    ...(form.payload ? [form.payload] : [])
                  ])
                ].map((name) => (
                  <SelectItem key={name}>{name}</SelectItem>
                ))}
              </Select>
            ) : (
              form.type !== 'MATCH' && (
                <Textarea
                  size="sm"
                  className="sm:col-span-2 font-mono"
                  label={
                    ['AND', 'OR', 'NOT', 'SUB-RULE'].includes(form.type) ? '匹配表达式' : '规则内容'
                  }
                  minRows={2}
                  value={form.payload}
                  onValueChange={(payload) => setForm({ ...form, payload })}
                />
              )
            )}
            {(supportsResolve || supportsSource) && (
              <RadioGroup
                className="sm:col-span-2"
                label="匹配方式"
                size="sm"
                orientation="horizontal"
                classNames={{ wrapper: 'gap-x-6 gap-y-3' }}
                value={form.options[0] || 'default'}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    options: value === 'default' ? [] : [value]
                  }))
                }
              >
                <Radio value="default">默认</Radio>
                {supportsResolve && <Radio value="no-resolve">不解析</Radio>}
                {supportsSource && <Radio value="src">匹配来源</Radio>}
              </RadioGroup>
            )}
          </fieldset>
          {onCommit && initial.options.length > 1 && (
            <p>原规则包含多个选项；未修改保存会保留原串，修改后请明确选择单一匹配方式。</p>
          )}
          {error && (
            <div role="alert" className="text-sm text-danger break-words">
              {error}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="light" isDisabled={saving || locked} onPress={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            color="primary"
            isLoading={saving}
            isDisabled={saving || locked}
            onPress={() => save()}
          >
            {onCommit ? '保存到规则草稿' : '保存'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
export default RuleEditorModal
