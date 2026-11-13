import { describe, expect, it } from 'vitest'
import { allowedPreviewRequest } from './navigation'

describe('Primary-window request boundary remains in force for custom CSS', () => {
  const root = '/Applications/Relay.app/Contents/Resources/app/out/renderer'
  it('permits bundled style assets but refuses external, loopback and escaped file targets', () => {
    expect(allowedPreviewRequest('file://' + root + '/assets/theme.css', root)).toBe(true)
    for (const url of [
      'https://theme.example/style.css',
      'https://theme.example/collect?value=secret',
      'http://127.0.0.1:8888/',
      'http://[::1]:8888/',
      'file:///Users/user/private.css',
      'file://other-host/' + root + '/assets/a.css',
      'file://' + root + '/../private.css',
      'file://' + root + '/%2e%2e/private.css'
    ])
      expect(allowedPreviewRequest(url, root)).toBe(false)
  })
  it('allows in-memory style resources without granting their subsequent remote requests', () => {
    expect(allowedPreviewRequest('data:text/css,body%7Bcolor:red%7D', root)).toBe(true)
    expect(allowedPreviewRequest('https://theme.example/font.woff', root)).toBe(false)
  })
})
