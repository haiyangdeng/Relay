import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { preferenceFixture } from '../../../../main/relay/__fixtures__/preferences'
import { mergeLoadedPreferences, RelayPreferencesPanel } from './preferences-panel'

describe('Preference form boundaries', () => {
  it('keeps a pasted JSON draft while loading parameters, and preserves edits made during initial async loading', () => {
    const current = {
      httpPort: 8888,
      node: 'edited',
      internalExceptions: 'git.corp',
      existingJSON: '{"env":{"secret":"keep only in draft"}}'
    }
    const loaded = preferenceFixture().preferences
    expect(mergeLoadedPreferences(current, loaded, true)).toBe(current)
    const merged = mergeLoadedPreferences(current, loaded, false)
    expect(merged.httpPort).toBe(7890)
    expect(merged.existingJSON).toBe(current.existingJSON)
  })
  it('cannot save before a revision is loaded and explains the limited scope', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayPreferencesPanel, {
        notice: '',
        busy: false,
        ready: true,
        onRead: () => {},
        onSave: () => {}
      })
    )
    expect(markup).toContain('不保存 settings.json 草稿')
    expect(markup).toContain('不修改客户端或旧助手')
    expect(markup).toMatch(/<button disabled="">记住当前参数<\/button>/)
  })
})
