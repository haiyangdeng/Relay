import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RelayDraftArtifacts } from './draft-artifacts'

describe('Draft display boundary', () => {
  it('shows documents as escaped text and disables copy/export while an operation is pending', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayDraftArtifacts, {
        result: {
          artifacts: [
            {
              id: 'fixture',
              title: 'fixture',
              filename: 'fixture.md',
              content: '<script>run()</script>'
            }
          ],
          warnings: ['This is text only']
        },
        busy: true,
        onAction: () => {
          throw new Error('render must not invoke actions')
        }
      })
    )
    expect(markup).toContain('&lt;script&gt;run()&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('不会应用配置，也不会执行文档中的代码。')
    const buttons = markup.match(/<button\b[^>]*>/g) ?? []
    expect(buttons).toHaveLength(2)
    expect(buttons.every((button) => /\bdisabled=""/.test(button))).toBe(true)
  })
})
