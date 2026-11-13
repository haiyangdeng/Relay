// Real Monaco + installed YAML worker; no App, user data or external network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, stop } from 'esbuild'

if (!process.env.RELAY_PLAYWRIGHT_MODULE || !process.env.RELAY_CHROME)
  throw new Error('Use bundled Playwright and an isolated Chrome executable.')
const require = createRequire(import.meta.url),
  app = process.cwd(),
  sourcePath = resolve('src/renderer/src/components/base/base-editor.tsx'),
  source = await readFile(sourcePath, 'utf8'),
  monacoYaml = require.resolve('monaco-yaml'),
  yamlWorker = require.resolve('monaco-yaml/yaml.worker'),
  editorWorker = require.resolve('monaco-editor/esm/vs/editor/editor.worker'),
  metaSchema = require.resolve('meta-json-schema/schemas/meta-json-schema.json'),
  probe = process.env.RELAY_MONACO_PROBE === '1',
  root = await realpath(await mkdtemp('/private/tmp/relay-real-monaco-schema-')),
  identity = await lstat(root),
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  { chromium } = await import(pathToFileURL(resolve(process.env.RELAY_PLAYWRIGHT_MODULE)).href),
  attacks = {
    modeline: 'https://modeline-schema-fixture.invalid/schema.json',
    ref: 'https://external-ref-fixture.invalid/schema.json'
  },
  checks = [],
  cleanup = {
    contextClosed: false,
    browserClosed: false,
    assetServerClosed: false,
    temporaryBundleRemoved: false
  }
assert.equal(
  (source.match(/enableSchemaRequest: false/gu) ?? []).length,
  1,
  'Expected actual fixed BaseEditor source'
)
for (const uri of Object.values(attacks)) assert(new URL(uri).hostname.endsWith('.invalid'))
let server, browser, activeContext, origin, failure
const mime = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.ttf': 'font/ttf'
}
try {
  await build({
    entryPoints: { 'yaml-worker': yamlWorker, 'editor-worker': editorWorker },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outdir: root,
    logLevel: 'silent'
  })
  for (const before of probe ? [false] : [true, false]) {
    const variant = before ? 'before-enabled' : 'after-disabled'
    await build({
      stdin: {
        contents: `import React from 'react';import{createRoot}from'react-dom/client';import * as monaco from 'monaco-editor';import{BaseEditor}from${JSON.stringify(sourcePath)};
window.__spawnLabels=[];window.MonacoEnvironment={getWorker(_id,label){window.__spawnLabels.push(label);if(label!=='yaml'&&label!=='editorWorkerService')throw Error('Unexpected real worker '+label);return new Worker('/'+(label==='yaml'?'yaml-worker':'editor-worker')+'.js',{type:'module'})}};
const root=createRoot(document.getElementById('root'));root.render(React.createElement(BaseEditor,{language:'yaml',value:'port: 70000\\n'}));
const model=()=>monaco.editor.getModels().find(m=>m.uri.path.endsWith('.clash.yaml'));
window.__fixture={ready:()=>!!model()&&!!window.__yamlApi,info:()=>({language:model()?.getLanguageId(),uri:model()?.uri.toString(),options:window.__yamlApi?.getOptions(),workerLabels:window.__spawnLabels}),markers:()=>monaco.editor.getModelMarkers({resource:model().uri}).map(m=>({message:m.message,severity:m.severity,line:m.startLineNumber})),set:async text=>{model().setValue(text);await window.__yamlApi.update({})},revalidate:()=>window.__yamlApi.update({}),externalRef:async uri=>{model().setValue('value: 1\\n');await window.__yamlApi.update({schemas:[...window.__initialYamlOptions.schemas,{uri:'inmemory://fixture/inlined-ref',fileMatch:['**/*.clash.yaml'],schema:{$ref:uri}}]})},dispose:()=>{root.unmount();window.__yamlApi?.dispose()}};`,
        resolveDir: app,
        loader: 'tsx'
      },
      bundle: true,
      format: 'esm',
      jsx: 'automatic',
      platform: 'browser',
      outfile: join(root, variant + '.js'),
      loader: { '.ttf': 'file' },
      logLevel: 'silent',
      plugins: [
        {
          name: 'real-editor-fixture-instrumentation',
          setup(builder) {
            builder.onResolve({ filter: /^monaco-yaml$/ }, () => ({
              path: 'actual-config-observer',
              namespace: 'observer'
            }))
            builder.onLoad({ filter: /.*/, namespace: 'observer' }, () => ({
              loader: 'js',
              resolveDir: app,
              contents: `import{configureMonacoYaml as actual}from${JSON.stringify(monacoYaml)};export function configureMonacoYaml(monaco,options){window.__initialYamlOptions=options;const api=actual(monaco,options);window.__yamlApi=api;return api}`
            }))
            builder.onResolve({ filter: /\?raw$/ }, (args) => ({
              path: require.resolve(args.path.slice(0, -4)),
              namespace: 'raw-file'
            }))
            builder.onLoad({ filter: /.*/, namespace: 'raw-file' }, async (args) => ({
              contents: 'export default ' + JSON.stringify(await readFile(args.path, 'utf8')),
              loader: 'js'
            }))
            if (before)
              builder.onLoad({ filter: /base-editor\.tsx$/ }, (args) =>
                args.path === sourcePath
                  ? {
                      contents: source.replace(
                        'enableSchemaRequest: false',
                        'enableSchemaRequest: true'
                      ),
                      loader: 'tsx',
                      resolveDir: dirname(sourcePath)
                    }
                  : undefined
              )
          }
        }
      ]
    })
    await writeFile(
      join(root, variant + '.html'),
      `<!doctype html><html><head><link rel="stylesheet" href="/${variant}.css"></head><body style="margin:0"><div id="root" style="height:650px;width:1100px"></div><script type="module" src="/${variant}.js"></script></body></html>`
    )
  }
  server = createServer(async (request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname),
        path = resolve(root, '.' + name)
      if (!path.startsWith(root + '/') || !(await lstat(path)).isFile())
        throw Error('Invalid fixture asset')
      response.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      })
      response.end(await readFile(path))
    } catch {
      response.writeHead(404)
      response.end('fixture asset not found')
    }
  })
  await new Promise((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  origin = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch({
    executablePath: process.env.RELAY_CHROME,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run']
  })
  for (const before of probe ? [false] : [true, false]) {
    const variant = before ? 'before-enabled' : 'after-disabled',
      blocked = [],
      workers = [],
      pageErrors = []
    activeContext = await browser.newContext({
      viewport: { width: 1200, height: 800 },
      serviceWorkers: 'block'
    })
    await activeContext.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      blocked.push({ url: route.request().url(), method: route.request().method() })
      return route.abort('blockedbyclient')
    })
    const page = await activeContext.newPage()
    page.on('worker', (worker) => workers.push(worker.url()))
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(origin + '/' + variant + '.html')
    await page.waitForFunction(() => window.__fixture?.ready(), { timeout: 20000 })
    assert.equal(await page.locator('.monaco-editor').count(), 1, 'Actual Monaco DOM must mount')
    await page.evaluate(() => window.__fixture.revalidate())
    const info = await page.evaluate(() => window.__fixture.info()),
      invalid = await page.evaluate(() => window.__fixture.markers())
    assert.equal(info.language, 'yaml')
    assert.equal(info.options.enableSchemaRequest, before)
    assert(
      info.options.schemas.some(
        (schema) => schema.uri === 'http://example.com/meta-json-schema.json'
      )
    )
    assert(
      workers.some((url) => url === origin + '/yaml-worker.js'),
      'Real installed YAML worker must run'
    )
    assert(
      invalid.some((marker) => marker.line === 1 && marker.severity >= 4),
      'Inlined schema must reject port70000'
    )
    await page.evaluate(() => window.__fixture.set('port: 7890\n'))
    const valid = await page.evaluate(() => window.__fixture.markers())
    assert.equal(valid.length, 0, 'Valid port must clear real worker diagnostics')
    const result = {
      variant,
      actualSchemaRequestOption: info.options.enableSchemaRequest,
      actualMonacoDOM: true,
      realYamlWorkerURLs: workers,
      baselineInvalidMarkers: invalid,
      baselineValidMarkers: valid
    }
    if (!probe) {
      await page.evaluate(
        (uri) => window.__fixture.set('# yaml-language-server: $schema=' + uri + '\nport: 7890\n'),
        attacks.modeline
      )
      result.modelineMarkers = await page.evaluate(() => window.__fixture.markers())
      await page.evaluate(() => window.__fixture.set('port: 7890\n'))
      await page.evaluate((uri) => window.__fixture.externalRef(uri), attacks.ref)
      result.externalRefMarkers = await page.evaluate(() => window.__fixture.markers())
      if (before) {
        assert(
          blocked.some((request) => request.url === attacks.modeline),
          'Enabled private before variant must attempt blocked modeline request'
        )
        assert(
          blocked.some((request) => request.url === attacks.ref),
          'Enabled private before variant must attempt blocked externalref request'
        )
      } else
        assert.equal(blocked.length, 0, 'Disabled real worker must make zero external requests')
      assert(
        blocked.every((request) => Object.values(attacks).includes(request.url)),
        'Only synthetic invalid-schema requests expected'
      )
    }
    assert.deepEqual(pageErrors, [])
    result.blockedExternalRequests = blocked
    result.pageErrors = pageErrors
    checks.push(result)
    await page.evaluate(() => window.__fixture.dispose())
    await activeContext.close()
    activeContext = undefined
  }
} catch (error) {
  failure = error
} finally {
  if (activeContext) await activeContext.close()
  cleanup.contextClosed = true
  if (browser) await browser.close()
  cleanup.browserClosed = true
  if (server)
    await new Promise((closed, reject) =>
      server.close((error) => (error ? reject(error) : closed()))
    )
  cleanup.assetServerClosed = true
  stop()
  const after = await lstat(root)
  assert.equal(after.dev, identity.dev)
  assert.equal(after.ino, identity.ino)
  assert.equal(await realpath(root), root)
  await rm(root, { recursive: true, force: true })
  cleanup.temporaryBundleRemoved = true
}
assert.equal(
  await readFile(sourcePath, 'utf8'),
  source,
  'Author source must remain unchanged during real fixture'
)
const output = resolve(
  process.env.RELAY_UI_VERIFICATION_OUTPUT ??
    (probe
      ? '../evidence/base-editor-real-yaml-worker-probe-20261101.json'
      : '../evidence/base-editor-real-yaml-worker-verification-20261101.json')
)
const proof = {
  verifiedAt: new Date().toISOString(),
  scope:
    'private real Monaco BaseEditor and installed YAML worker, synthetic schema requests all intercepted',
  probe,
  sourceSHA256: sha(Buffer.from(source)),
  scriptSHA256: sha(await readFile(new URL(import.meta.url))),
  installed: {
    monacoYaml: require('monaco-yaml/package.json').version,
    monacoEditor: require('monaco-editor/package.json').version,
    metaSchema: require('meta-json-schema/package.json').version,
    yamlIndexSHA256: sha(await readFile(monacoYaml)),
    yamlWorkerSHA256: sha(await readFile(yamlWorker)),
    inlineMetaSchemaSHA256: sha(await readFile(metaSchema))
  },
  privateBeforeAdaptation: probe
    ? undefined
    : 'Only actual BaseEditor enableSchemaRequest false changed to true in the private esbuild onLoad, without changing production source. Real configureMonacoYaml wrapper only observes options and returns the actual provider.',
  checks,
  cleanup,
  success: !failure,
  failure: failure ? String(failure.stack ?? failure) : undefined,
  actualExternalConnections: false,
  userBrowserSessionUsed: false,
  appOrCoreStarted: false,
  productAcceptance: 'pending'
}
await writeFile(output, JSON.stringify(proof, null, 2) + '\n')
console.log(
  JSON.stringify({
    output,
    success: proof.success,
    sourceSHA256: proof.sourceSHA256,
    variants: checks.length,
    cleanup
  })
)
if (failure) throw failure
