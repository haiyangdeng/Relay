const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require('electron')
const { appendFileSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const { eventPath } = require('./runtime.json')

const stateRoot = mkdtempSync(join(tmpdir(), 'relay-ui-only-'))
app.setPath('userData', stateRoot)
app.setPath('sessionData', join(stateRoot, 'Chromium'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
const record = (event, details = {}) =>
  appendFileSync(eventPath, JSON.stringify({ at: Date.now(), event, ...details }) + '\n', {
    mode: 0o600
  })
const idle = {
  phase: 'idle',
  pending: false,
  owned: false,
  traffic: 'inactive',
  restorationVerified: false,
  protectionVerified: false,
  warnings: ['隔离界面模拟状态，不是实际网络状态。']
}
let window,
  state = { ...idle },
  candidate,
  prepared,
  preparedFor,
  checked = false,
  pending = false
const profiles = ['route.json', 'dns.json'].map((name, index) => ({
  id: `fixture-${index}`,
  name,
  sha256: String(index + 1).repeat(64)
}))
const requireCandidate = (id) => {
  if (!candidate || candidate.evidenceId !== id || Date.now() > candidate.expiresAt)
    throw new Error('Fixture candidate expired or mismatched')
}
const dispatch = async (channel, input) => {
  if (pending) throw new Error('Fixture confirmation pending')
  switch (channel) {
    case 'relayProfileList':
      return { profiles }
    case 'relayProviderResourceList':
      return { profiles: [] }
    case 'relayResourceList':
      return { resources: [] }
    case 'relayCompleteConfigurationCancel':
      candidate = undefined
      checked = false
      prepared = undefined
      preparedFor = undefined
      return undefined
    case 'relayCompleteConfigurationPrepare': {
      const profile = profiles.find(
        (item) => item.id === input?.profile?.id && item.sha256 === input?.profile?.sha256
      )
      if (!profile || state.owned) throw new Error('Fixture selection refused')
      checked = false
      prepared = undefined
      preparedFor = undefined
      candidate = {
        evidenceId: randomUUID(),
        profileId: profile.id,
        expiresAt: Date.now() + 60000,
        configurationSHA256: profile.sha256,
        bundleSHA256: 'b'.repeat(64),
        readyForParserCheck: true,
        stageOrder: ['fixture'],
        scriptLogLines: 0,
        dns: { requested: false, effective: false, autoDisabled: false },
        dependencies: [],
        resources: 0,
        active: false,
        warnings: ['隔离模拟解析，未运行Mihomo。']
      }
      record('candidate', { source: profile.name, expiresAt: candidate.expiresAt })
      return candidate
    }
    case 'relayCompleteConfigurationCheck':
      requireCandidate(input?.evidenceId)
      if (!candidate.readyForParserCheck) throw new Error('Fixture check already consumed')
      candidate.readyForParserCheck = false
      checked = true
      return {
        status: 'passed',
        scope: 'complete-parser',
        configurationSHA256: candidate.configurationSHA256,
        active: false,
        runtimeAccepted: false,
        warnings: ['隔离模拟解析，未运行Mihomo。']
      }
    case 'relayTunStatus':
      return { helper: 'ready', session: state, warnings: idle.warnings }
    case 'relayTunInspect':
      return state
    case 'relayTunPrepare':
      requireCandidate(input?.evidenceId)
      if (!checked || state.owned) throw new Error('Fixture preparation refused')
      checked = false
      preparedFor = candidate.evidenceId
      prepared = {
        version: 1,
        evidenceId: randomUUID(),
        configurationSHA256: candidate.configurationSHA256,
        bundleSHA256: candidate.bundleSHA256,
        tunSHA256: 'c'.repeat(64),
        assetsSHA256: 'd'.repeat(64),
        helperRevision: 'e'.repeat(64),
        networkRevision: 'f'.repeat(64),
        evidenceSHA256: '1'.repeat(64),
        createdAt: Date.now(),
        expiresAt: candidate.expiresAt,
        readyForConfirmation: true,
        canApply: false,
        active: false,
        runtimeVerified: false,
        protectionVerified: false,
        effects: { device: 'fixture-only', autoRoute: false, dnsHijack: false },
        issues: []
      }
      return prepared
    case 'relayTunCancel':
      if (input?.evidenceId === prepared?.evidenceId) {
        prepared = undefined
        preparedFor = undefined
      }
      return undefined
    case 'relayTunStart': {
      if (!prepared || input?.evidenceId !== prepared.evidenceId || state.owned)
        throw new Error('Fixture start refused')
      requireCandidate(preparedFor)
      const expiresAt = prepared.expiresAt
      prepared = undefined
      preparedFor = undefined
      if (Date.now() > expiresAt) return { status: 'failed', state }
      pending = true
      try {
        const answer = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '模拟启用确认 · 无网络操作',
          message: '验证启用确认框；不会启动核心或修改网络。',
          detail: '仅将隔离页面切换为模拟会话状态。生产App未接入此入口。',
          buttons: ['取消', '启用本次TUN'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        record('start-confirmation', { response: answer.response })
        if (answer.response !== 1) return { status: 'cancelled', state }
        if (Date.now() > expiresAt) return { status: 'failed', state }
        state = {
          ...idle,
          phase: 'active',
          owned: true,
          traffic: 'forwarding',
          sessionId: randomUUID()
        }
        record('simulated-active', { sessionId: state.sessionId })
        return { status: 'started', state }
      } finally {
        pending = false
      }
    }
    case 'relayTunStop': {
      if (!state.owned || input?.sessionId !== state.sessionId)
        throw new Error('Fixture ownership mismatch')
      pending = true
      try {
        const answer = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '模拟停用确认 · 无网络操作',
          message: '验证停用确认框；没有实际核心或网络需要恢复。',
          detail: '取消必须保留模拟会话；确认后只清除内存中的模拟所有权。',
          buttons: ['取消', '停用并恢复'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        record('stop-confirmation', { response: answer.response, sessionId: state.sessionId })
        if (answer.response !== 1) return { status: 'cancelled', state }
        state = { ...idle, phase: 'restored', restorationVerified: true }
        record('simulated-restored')
        return { status: 'restored', state }
      } finally {
        pending = false
      }
    }
    default:
      throw new Error('Unexpected fixture IPC')
  }
}

app.whenReady().then(async () => {
  const page = join(__dirname, 'renderer/index.html')
  const allowed = pathToFileURL(join(__dirname, 'renderer')).href + '/'
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const blocked = !details.url.startsWith(allowed)
    if (blocked) record('blocked-request')
    callback({ cancel: blocked })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  window = new BrowserWindow({
    title: 'Relay UI Check · 隔离模拟',
    width: 1050,
    height: 900,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  ipcMain.handle('fixture', async (event, channel, input) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Unexpected fixture caller')
    record('ipc', { channel })
    return dispatch(channel, input)
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ label: 'Relay UI Check', submenu: [{ role: 'quit' }] }])
  )
  record('opened', { stateRoot, pid: process.pid, electron: process.versions.electron })
  await window.loadFile(page)
})
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => record('closed', { simulatedOwned: state.owned }))
