import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { RelayFloatingView } from './floating-app'
const ordinarySample = {
  up: 1024,
  down: 2048,
  upTotal: 1000000000,
  downTotal: 2000000000,
  instanceId: '11111111-1111-4111-8111-111111111111',
  configurationRevision: 'a'.repeat(64),
  receivedAt: 10000
}
it('keeps opaque compatibility by default and only uses alpha for the transparent view', () => {
  const snapshot = { version: 1, status: 'loading' } as const
  expect(renderToStaticMarkup(createElement(RelayFloatingView, { snapshot }))).toContain(
    'background:#edf4f2'
  )
  expect(
    renderToStaticMarkup(createElement(RelayFloatingView, { snapshot, transparent: true }))
  ).toContain('background:rgba(237, 244, 242, 0.88)')
})
it('renders the reused rate format from actual up/down, not totals', () => {
  const html = renderToStaticMarkup(
    createElement(RelayFloatingView, {
      snapshot: {
        version: 1,
        status: 'ready',
        sample: ordinarySample
      }
    })
  )
  expect(html).toContain('1.00 KB/s')
  expect(html).toContain('2.00 KB/s')
  expect(html).not.toContain('GB/s')
  expect(html).toContain('普通实例')
  expect(html).toContain('本次核心汇总')
  expect(html).not.toContain('relay-floating-spin')
  expect(html).not.toContain('onclick')
})
it.each([
  [true, 1, '3s'],
  [true, 1024, '2s'],
  [true, 1048576, '1.5s'],
  [true, 1073741824, '1.2s'],
  [true, 0, undefined],
  [false, 1024, undefined]
] as const)(
  'renders the pinned rotation band for preference %s and %s B/s',
  (spinFloatingIcon, up, duration) => {
    const html = renderToStaticMarkup(
      createElement(RelayFloatingView, {
        snapshot: {
          version: 1,
          status: 'ready',
          spinFloatingIcon,
          sample: { ...ordinarySample, up, down: 0 }
        }
      })
    )
    if (duration) expect(html).toContain(`animation-duration:${duration}`)
    else expect(html).not.toContain('relay-floating-spin')
  }
)
it.each(['loading', 'hidden', 'unavailable'] as const)(
  'does not invent zero traffic for %s',
  (status) => {
    const html = renderToStaticMarkup(
      createElement(RelayFloatingView, { snapshot: { version: 1, status, spinFloatingIcon: true } })
    )
    expect(html).not.toContain('0.00 B/s')
    expect(html).not.toContain('aria-label="上传速率"')
    expect(html).not.toContain('relay-floating-spin')
    expect(html).toContain(
      status === 'loading' ? '正在读取' : status === 'hidden' ? '已暂停' : '未确认'
    )
  }
)

it('labels an admitted TUN sample as this owned Core aggregate with no ordinary instance selector', () => {
  const html = renderToStaticMarkup(
    createElement(RelayFloatingView, {
      snapshot: {
        version: 1,
        status: 'ready',
        sample: {
          kind: 'tun-managed',
          sessionId: '11111111-1111-4111-8111-111111111111',
          evidenceSHA256: 'b'.repeat(64),
          runtimeConfigurationSHA256: 'a'.repeat(64),
          receivedAt: 10000,
          up: 1024,
          down: 2048,
          upTotal: 1000000000,
          downTotal: 2000000000
        }
      }
    })
  )
  expect(html).toContain('TUN核心')
  expect(html).toContain('本次核心汇总')
  expect(html).toContain('1.00 KB/s')
  expect(html).not.toContain('普通实例')
  expect(html).not.toContain('GB/s')
  expect(html).not.toContain('onclick')
})
