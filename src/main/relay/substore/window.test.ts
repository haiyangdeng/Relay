import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {} }))
import { subStoreWindowRequest } from './window'

describe('Sub-Store isolated window request boundary', () => {
  it('only permits the exact origins of the currently owned runtime', () => {
    const origins = ['http://127.0.0.1:18190', 'http://127.0.0.1:18191']
    expect(subStoreWindowRequest(origins[0] + '/assets/app.js', origins)).toBe(true)
    expect(subStoreWindowRequest(origins[1] + '/private/api/subs', origins)).toBe(true)
    for (const url of [
      'http://127.0.0.1:18192/',
      'http://localhost:18190/',
      'https://127.0.0.1:18190/',
      'file:///private/data',
      'https://example.com',
      'http://user:pass@127.0.0.1:18190/'
    ])
      expect(subStoreWindowRequest(url, origins)).toBe(false)
    expect(subStoreWindowRequest(origins[0], [])).toBe(false)
  })
})
