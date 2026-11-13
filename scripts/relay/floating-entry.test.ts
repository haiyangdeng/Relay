import { readFile } from 'fs/promises'
import { createElement, StrictMode } from 'react'
import { transform } from 'esbuild'
import { expect, it, vi } from 'vitest'
import {
  relayFloatingReadonlyHash,
  relayFloatingTransparentHash
} from '../../src/shared/relay/floating-traffic'
const source = new URL('../../src/renderer/src/floating.tsx', import.meta.url)
it.each([
  { present: true, generic: false, hash: '' },
  { present: false, generic: false, hash: '' },
  { present: false, generic: true, hash: `#${relayFloatingReadonlyHash}` }
])(
  'uses only the readonly component for %j without loading a legacy provider',
  async ({ present, generic, hash }) => {
    const compiled = await transform(await readFile(source, 'utf8'), {
      loader: 'tsx',
      format: 'cjs',
      jsx: 'transform'
    })
    const render = vi.fn(),
      Readonly = () => null,
      requireMock = vi.fn((name: string) => {
        if (name === 'react')
          return { default: { createElement, StrictMode }, createElement, StrictMode }
        if (name === 'react-dom/client')
          return { default: { createRoot: () => ({ render }) }, createRoot: () => ({ render }) }
        if (name === '@renderer/assets/floating.css') return {}
        if (name === '../../shared/relay/floating-traffic')
          return { relayFloatingReadonlyHash, relayFloatingTransparentHash }
        if (name === './components/relay/floating-app') return { RelayFloatingApp: Readonly }
        throw Error('unexpected eager import ' + name)
      })
    // Dynamic legacy import() expressions remain unexecuted in this branch.
    new Function('require', 'window', 'document', compiled.code)(
      requireMock,
      {
        ...(present ? { relayFloatingTraffic: { onSnapshot: () => () => {} } } : {}),
        ...(generic ? { electron: { ipcRenderer: {} } } : {}),
        location: { hash }
      },
      { getElementById: () => ({}) }
    )
    expect(render).toHaveBeenCalledOnce()
    expect(render.mock.calls[0][0].props.children.type).toBe(Readonly)
    expect(requireMock.mock.calls.map(([name]) => name)).not.toContain('./FloatingApp')
  }
)
