import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ResourceViewerView } from '../resources/viewer'
import { RelayResourcesPanel } from './resources-panel'

vi.mock('@renderer/utils/ipc', () => ({
  getFileStr: vi.fn(),
  setFileStr: vi.fn(),
  convertMrsRuleset: vi.fn(),
  getRuntimeConfig: vi.fn()
}))
vi.mock('../base/base-editor', () => ({
  BaseEditor: ({ value, readOnly }: { value: string; readOnly: boolean }) =>
    createElement('textarea', { value, readOnly })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@heroui/react', async (original) => {
  const actual = await original<typeof import('@heroui/react')>()
  const container = ({ children }: { children: React.ReactNode }) =>
    createElement('div', null, children)
  return {
    ...actual,
    Modal: container,
    ModalContent: container,
    ModalHeader: container,
    ModalBody: container,
    ModalFooter: container,
    Button: ({ children }: { children: React.ReactNode }) => createElement('button', null, children)
  }
})

describe('Resource metadata and core acceptance are separate', () => {
  it('does no acquisition on render and requires a prepared source or explicit selection', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(createElement(RelayResourcesPanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('不读取原path')
    expect(html).toContain('正文摘要匹配、核心格式接受分别显示')
    expect(html).toContain('获取并缓存资源')
    expect(html).not.toContain('确认获取并缓存资源')
    expect(html).toMatch(/<button disabled="">用固定核心检查所选资源/)
    expect(html).toMatch(/<button disabled="">只读预览所选规则缓存/)
    expect(html).toContain('地理数据库和通用文件不返回正文')
    expect(html).toContain('不代表数据库覆盖或真实出口已验证')
  })
  it('reuses the passive viewer without a writable editor or save action', () => {
    const save = vi.fn(),
      html = renderToStaticMarkup(
        createElement(ResourceViewerView, {
          title: 'Explicit selected cache',
          text: 'DOMAIN,synthetic.invalid',
          language: 'text',
          loading: false,
          readOnly: true,
          onClose: vi.fn(),
          onSave: save
        })
      )
    expect(html).toMatch(/readonly=""/iu)
    expect(html).toContain('DOMAIN,synthetic.invalid')
    expect(html).not.toContain('common.save')
    expect(save).not.toHaveBeenCalled()
  })
  it('keeps the legacy editable view save surface while errors do not show text', () => {
    const editable = renderToStaticMarkup(
        createElement(ResourceViewerView, {
          title: 'Legacy file',
          text: 'legacy text',
          language: 'yaml',
          loading: false,
          readOnly: false,
          onClose: vi.fn(),
          onChange: vi.fn(),
          onSave: vi.fn()
        })
      ),
      failed = renderToStaticMarkup(
        createElement(ResourceViewerView, {
          title: 'Failed preview',
          text: 'MUST_NOT_DISPLAY',
          language: 'text',
          loading: false,
          error: 'Safe read failure',
          readOnly: true,
          onClose: vi.fn()
        })
      )
    expect(editable).toContain('common.save')
    expect(editable).not.toMatch(/readonly=""/iu)
    expect(failed).toContain('Safe read failure')
    expect(failed).not.toContain('MUST_NOT_DISPLAY')
  })
})
