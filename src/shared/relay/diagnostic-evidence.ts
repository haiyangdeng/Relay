export interface DiagnosticBinding {
  architecture: 'x64' | 'arm64'
  appVersion: string
  appBuild: string
  coreSHA256: string
  configurationRevision: string
}
export interface DiagnosticBrowser {
  bundleId: 'com.microsoft.edgemac' | 'com.google.Chrome'
  version: string
  profile: 'edge-default' | 'relay-private'
}
export interface ExternalDiagnosticTest {
  id: 'egress' | 'dns-exit' | 'webrtc' | 'dedicated-failure'
  testedAt: string
  result: 'observed' | 'noLeakObserved' | 'isolatedPassed' | 'failed' | 'inconclusive'
  browser: DiagnosticBrowser | null
  method: string
  scope: string[]
  limitations: string[]
  evidenceSHA256: string
}
export interface ExternalDiagnosticRecord {
  schemaVersion: 1
  recordedAt: string
  binding: DiagnosticBinding
  tests: ExternalDiagnosticTest[]
}
export interface OwnedDiagnosticPorts {
  systemHTTPPort: number | null
  systemSOCKSPort: number | null
  codeHTTPPort: number | null
  dedicatedSOCKSPort: number | null
}
export interface OwnedNativeDiagnostic {
  appVersion: string
  appBuild: string
  browsers: DiagnosticBrowser[]
}
export interface OwnedDiagnosticObservation {
  ports: OwnedDiagnosticPorts
  running: boolean
  route?: string
  binding?: DiagnosticBinding
  external: {
    status: 'missing' | 'invalid' | 'available'
    record?: ExternalDiagnosticRecord
    bindingMatches: boolean
    browserMatches: boolean[]
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('实测记录格式无效。')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: string): void {
  if (Object.keys(value).sort().join(',') !== keys) throw new Error('实测记录字段无效。')
}
function clean(value: unknown, max = 2048): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('实测记录文本无效。')
  return value
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error('实测记录摘要无效。')
  return value
}
function time(value: unknown): string {
  const text = clean(value, 32)
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(text) ||
    !Number.isFinite(Date.parse(text))
  )
    throw new Error('实测记录时间无效。')
  return text
}
function texts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16)
    throw new Error('实测记录范围无效。')
  return value.map((item) => clean(item))
}
export function diagnosticBrowser(raw: unknown): DiagnosticBrowser {
  const value = object(raw)
  exact(value, 'bundleId,profile,version')
  if (!(
    (value.bundleId === 'com.microsoft.edgemac' && value.profile === 'edge-default') ||
    (value.bundleId === 'com.google.Chrome' && value.profile === 'relay-private')
  ))
    throw new Error('实测浏览器身份无效。')
  return {
    bundleId: value.bundleId,
    version: clean(value.version, 128),
    profile: value.profile
  } as DiagnosticBrowser
}
export function diagnosticBinding(raw: unknown): DiagnosticBinding {
  const value = object(raw)
  exact(value, 'appBuild,appVersion,architecture,configurationRevision,coreSHA256')
  if (value.architecture !== 'x64' && value.architecture !== 'arm64')
    throw new Error('实测架构无效。')
  return {
    architecture: value.architecture,
    appVersion: clean(value.appVersion, 128),
    appBuild: clean(value.appBuild, 128),
    coreSHA256: sha(value.coreSHA256),
    configurationRevision: sha(value.configurationRevision)
  }
}
export function ownedNativeDiagnostic(raw: unknown): OwnedNativeDiagnostic {
  const value = object(raw)
  exact(value, 'appBuild,appVersion,browsers')
  if (!Array.isArray(value.browsers) || value.browsers.length > 2)
    throw new Error('浏览器身份观察无效。')
  const browsers = value.browsers.map(diagnosticBrowser)
  if (new Set(browsers.map((browser) => browser.bundleId)).size !== browsers.length)
    throw new Error('浏览器身份观察重复。')
  return {
    appVersion: clean(value.appVersion, 128),
    appBuild: clean(value.appBuild, 128),
    browsers
  }
}
export function externalDiagnosticRecord(raw: unknown): ExternalDiagnosticRecord {
  const value = object(raw)
  exact(value, 'binding,recordedAt,schemaVersion,tests')
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.tests) ||
    !value.tests.length ||
    value.tests.length > 16
  )
    throw new Error('实测记录版本或项目无效。')
  const recordedAt = time(value.recordedAt)
  const tests = value.tests.map((raw): ExternalDiagnosticTest => {
    const item = object(raw)
    exact(item, 'browser,evidenceSHA256,id,limitations,method,result,scope,testedAt')
    if (
      !['egress', 'dns-exit', 'webrtc', 'dedicated-failure'].includes(String(item.id)) ||
      !['observed', 'noLeakObserved', 'isolatedPassed', 'failed', 'inconclusive'].includes(
        String(item.result)
      ) ||
      (item.result === 'observed' && item.id !== 'egress') ||
      (item.result === 'isolatedPassed' && item.id !== 'dedicated-failure') ||
      (item.result === 'noLeakObserved' && !['dns-exit', 'webrtc'].includes(String(item.id)))
    )
      throw new Error('实测项目与结论不符。')
    const testedAt = time(item.testedAt)
    if (Date.parse(testedAt) > Date.parse(recordedAt)) throw new Error('实测记录早于测试时间。')
    const browser = item.browser === null ? null : diagnosticBrowser(item.browser)
    if (item.id !== 'dedicated-failure' && !browser) throw new Error('浏览器实测缺少身份。')
    if (item.id === 'dedicated-failure' && browser)
      throw new Error('隔离核心测试不能冒充浏览器测试。')
    return {
      id: item.id as ExternalDiagnosticTest['id'],
      testedAt,
      result: item.result as ExternalDiagnosticTest['result'],
      browser,
      method: clean(item.method),
      scope: texts(item.scope),
      limitations: texts(item.limitations),
      evidenceSHA256: sha(item.evidenceSHA256)
    }
  })
  return { schemaVersion: 1, recordedAt, binding: diagnosticBinding(value.binding), tests }
}
