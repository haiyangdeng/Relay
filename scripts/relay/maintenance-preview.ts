import { readFile, realpath, writeFile } from 'fs/promises'
import { dirname, extname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { readOnlyFixture } from '../../src/main/relay/__fixtures__/read-only'
import { edgeFixture } from '../../src/main/relay/__fixtures__/edge'
import { guardReadinessFixture } from '../../src/main/relay/__fixtures__/guard'
import { codeFixture } from '../../src/main/relay/__fixtures__/code'
import { RelayDiagnosticsPanel } from '../../src/renderer/src/components/relay/diagnostics-panel'
import { RelayCodePanel } from '../../src/renderer/src/components/relay/code-panel'
import { RelayEdgePanel } from '../../src/renderer/src/components/relay/edge-panel'
import { RelayGuardReadinessPanel } from '../../src/renderer/src/components/relay/guard-readiness-panel'
import { RelayDesktopSessionPanel } from '../../src/renderer/src/components/relay/desktop-session-panel'
import { RelayCorePanel } from '../../src/renderer/src/components/relay/core-panel'
import { RelayProfilesPanel } from '../../src/renderer/src/components/relay/profiles-panel'
import { RelaySubscriptionPanel } from '../../src/renderer/src/components/relay/subscription-panel'
import { RelaySubscriptionSourcesPanel } from '../../src/renderer/src/components/relay/subscription-sources-panel'
import { RelayResourcesPanel } from '../../src/renderer/src/components/relay/resources-panel'
import { RelayProvidersPanel } from '../../src/renderer/src/components/relay/providers-panel'
import { RelayRuntimePanel } from '../../src/renderer/src/components/relay/runtime-panel'
import { RelayLocalProxyPanel } from '../../src/renderer/src/components/relay/local-proxy-panel'

// Static development artifact using the real panel components and test-only
// data. No Electron entry, native bridge, browser or client files are imported.
export async function renderMaintenancePreview(): Promise<string> {
  const noop = (): void => {}
  const shared = {
    busy: true,
    ready: false,
    notice: '演示数据，不是本机检测结果；所有操作不可用。'
  }
  const report = readOnlyFixture()
  report.snapshot.summary = '演示数据：六项真实网络检测均待验证'
  const markup = renderToStaticMarkup(
    createElement(
      'main',
      { className: 'relay-workspace', 'data-sample': 'true' },
      createElement('h1', null, 'Relay — Static development sample'),
      createElement(
        'p',
        { role: 'status' },
        '仅用于开发核对内容与配色。演示数据，不代表本机状态；不会安装、登录或操作网络。'
      ),
      createElement(RelayProfilesPanel, {
        ...shared,
        onPrepare: noop,
        onSave: noop,
        onList: noop
      }),
      createElement(RelaySubscriptionPanel, {
        ...shared,
        name: 'Fixture',
        url: '',
        proxyPort: 18191,
        onName: noop,
        onURL: noop,
        onPort: noop,
        onPrepare: noop,
        onDownload: noop,
        onSave: noop,
        onCancel: noop
      }),
      createElement(RelaySubscriptionSourcesPanel, {
        busy: true,
        onBusy: noop,
        onSaved: async () => {}
      }),
      createElement(RelayResourcesPanel, { busy: true, onBusy: noop }),
      createElement(RelayProvidersPanel, {
        profiles: [],
        busy: true,
        onBusy: noop,
        onSaved: async () => {}
      }),
      createElement(RelayCorePanel, {
        ...shared,
        mode: 'rule',
        onMode: noop,
        onPrepare: noop,
        onStart: noop,
        onStop: noop
      }),
      createElement(RelayRuntimePanel, {
        ...shared,
        onCheck: noop
      }),
      createElement(RelayLocalProxyPanel, {
        ...shared,
        profiles: [],
        httpPort: 18191,
        resolverMode: 'off',
        onResolverMode: noop,
        onPort: noop,
        onPrepare: noop,
        onStart: noop,
        onStop: noop,
        onRefresh: noop,
        onSelect: noop
      }),
      createElement(RelayGuardReadinessPanel, {
        ...shared,
        report: guardReadinessFixture(),
        onRead: noop
      }),
      createElement(RelayCodePanel, {
        ...shared,
        preparation: {
          ...codeFixture(),
          evidenceId: 'sample',
          parameters: { httpPort: 7890, node: 'fixture-node', internalExceptions: '' }
        },
        onPrepare: noop,
        onApply: noop,
        onOpen: noop
      }),
      createElement(RelayEdgePanel, {
        ...shared,
        report: { ...edgeFixture(), evidenceId: 'sample' },
        onInspect: noop,
        onOpen: noop,
        onEntry: noop
      }),
      createElement(RelayDesktopSessionPanel, {
        ...shared,
        state: { host: 'absent', pending: false, uncertain: false },
        onAction: noop
      }),
      createElement(RelayDiagnosticsPanel, {
        observation: {
          source: 'legacy-readonly',
          evidenceId: 'sample',
          parameters: { httpPort: 7890, node: 'fixture-node', internalExceptions: '' },
          report
        },
        busy: true,
        onGuardPlan: noop
      })
    )
  )
  const css = await readFile(
    fileURLToPath(new URL('../../src/renderer/src/pages/relay-workspace.css', import.meta.url)),
    'utf8'
  )
  // No scripts, external fonts, images, connections, forms or frame embedding.
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay static sample — not a live report</title><style>body{margin:0;background:#f7f8fa;font-family:system-ui,sans-serif}button:disabled{opacity:.65;cursor:default}' +
    css +
    '</style></head><body>' +
    markup +
    '</body></html>\n'
  )
}

export async function writeMaintenancePreview(path: string): Promise<void> {
  if (!path || path.includes('\0') || extname(path).toLowerCase() !== '.html')
    throw new Error('请指定新的 .html 输出文件。')
  const target = resolve(path)
  if ((await realpath(dirname(target))) !== dirname(target))
    throw new Error('输出目录不能包含符号链接。')
  // Never overwrite an existing file, follow a destination symlink or create
  // directories. This is a developer-only file export, not renderer IPC.
  await writeFile(target, await renderMaintenancePreview(), { flag: 'wx', mode: 0o600 })
}
