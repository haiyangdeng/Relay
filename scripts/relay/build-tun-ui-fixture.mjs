import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'vite'

// Build only. Launch/control must use the authorized computer-use tool.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(root, '.relay-build/tun-ui-control-20261030')
const source = resolve(root, 'scripts/relay/tun-ui-fixture')
await mkdir(output, { recursive: false })
const fixture = resolve(output, 'fixture')
await mkdir(fixture)
await writeFile(
  resolve(output, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Relay UI Check</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'">
<style>body{font:15px system-ui;margin:24px;color:#17352c;background:#f4f7f5}section{border:1px solid #b8c8c0;padding:18px;margin:20px 0}button,select{font:inherit;padding:8px;margin:6px}label{display:block;margin:10px 0}textarea{display:block}h2{font-size:20px}[role=alert]{background:#fff2bb;padding:12px}button:disabled{opacity:.5}</style>
</head><body><div id="root"></div><script type="module" src="${resolve(source, 'renderer.tsx')}"></script></body></html>`
)
await build({
  configFile: false,
  root: output,
  base: './',
  esbuild: { jsx: 'automatic' },
  build: { outDir: resolve(fixture, 'renderer'), emptyOutDir: false, minify: false }
})
for (const file of ['main.cjs', 'preload.cjs'])
  await copyFile(resolve(source, file), resolve(fixture, file))
await writeFile(
  resolve(fixture, 'package.json'),
  JSON.stringify({ name: 'relay-ui-check', version: '1.0.0', main: 'main.cjs', private: true })
)
await writeFile(
  resolve(fixture, 'runtime.json'),
  JSON.stringify({ eventPath: resolve(output, 'events.jsonl') })
)
// This is never used as a production delivery or installation candidate.
// Event evidence is written outside the signed application bundle.
await writeFile(
  resolve(output, 'builder.json'),
  JSON.stringify(
    {
      appId: 'local.relay.ui-check',
      productName: 'Relay UI Check',
      directories: { app: fixture, output: resolve(output, 'bundle') },
      electronDist: resolve(root, 'node_modules/electron/dist'),
      electronVersion: JSON.parse(
        await readFile(resolve(root, 'node_modules/electron/package.json'))
      ).version,
      asar: true,
      files: [
        'main.cjs',
        'preload.cjs',
        'runtime.json',
        'renderer/**',
        'package.json',
        '!node_modules/**'
      ],
      npmRebuild: false,
      mac: { target: 'dir', identity: '-', hardenedRuntime: false },
      publish: []
    },
    null,
    2
  )
)
const files = [
  'scripts/relay/tun-ui-fixture/renderer.tsx',
  'scripts/relay/tun-ui-fixture/main.cjs',
  'scripts/relay/tun-ui-fixture/preload.cjs',
  'src/renderer/src/components/relay/complete-configuration-panel.tsx',
  'src/renderer/src/components/relay/tun-panel.tsx',
  'src/renderer/src/components/relay/tun-controller.ts',
  'src/renderer/src/components/relay/tun-api.ts',
  'src/shared/relay/tun.ts'
]
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(resolve(root, file)))
        .digest('hex')
    ])
  )
)
await writeFile(
  resolve(output, 'sources.json'),
  JSON.stringify(
    {
      scope:
        'Actual React panels and IPC validators with an isolated simulated host and native Electron dialogs. No production main, native binaries, system installation or network acceptance.',
      sources: hashes,
      upstream: 'Existing Electron 43.8.0 / React packages; no dependency changes'
    },
    null,
    2
  )
)
console.log(resolve(output, 'builder.json'))
