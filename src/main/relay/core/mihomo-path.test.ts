import { expect, it } from 'vitest'
import { mihomoPathSegment } from './mihomo-path'

it('forces a raw path for literal escape sequences in Mihomo group names', () => {
  expect(mihomoPathSegment('Fixture%2F')).toBe('%46%69%78%74%75%72%65%25%32%46')
  for (const name of ['Fixture%2F', '选择 / Fixture%2F', 'A/B', '全球', 'one#two']) {
    const encoded = mihomoPathSegment(name)
    expect(encoded).not.toContain('/')
    expect(decodeURIComponent(encoded)).toBe(name)
  }
  expect(mihomoPathSegment('Selector')).toBe('Selector')
})
