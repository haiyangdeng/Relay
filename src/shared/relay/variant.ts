// Core variant and Smart resource management protocol.
//
// The owned runtime pins mihomo v1.19.33 (batch 12). Batch 34 adds the
// acquire / verify / switch / settings / restore cycle for additional core
// variants and Smart model resources, all in Relay's own private directory
// and never touching the current Clash binary or its controller.
export type VariantKind = 'core' | 'smart'
export type VariantArchitecture = 'arm64' | 'x64'

export interface VariantRecord {
  id: string
  kind: VariantKind
  version: string
  sha256: string
  size: number
  architecture?: VariantArchitecture
  acquiredAt: number
}

export interface VariantAcquireRequest {
  kind: VariantKind
  // Absolute source path the main process already controls (a downloaded
  // archive or binary). The store copies + verifies it into a private slot;
  // the renderer never supplies an arbitrary destination.
  sourcePath: string
  version: string
  sha256: string
  size: number
  architecture?: VariantArchitecture
}

export type VariantImportRequest = Omit<VariantAcquireRequest, 'sourcePath'>
export interface VariantPreparation extends VariantImportRequest {
  expiresAt: number
}

export interface VariantInventory {
  records: VariantRecord[]
  activeCoreId: string | undefined
  activeSmartId: string | undefined
  pinnedDefault: true
}

export interface VariantState extends VariantInventory {
  pending: boolean
  trustedCoreVersion: string
  smartRuntimeSupported: true
  networkDownloadSupported: false
  hostArchitecture: VariantArchitecture | null
  trustedCoreImports: VariantImportRequest[]
  trustedSmartImports: VariantImportRequest[]
}

const KINDS = new Set<VariantKind>(['core', 'smart'])
const ARCHS = new Set<VariantArchitecture>(['arm64', 'x64'])

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
    throw new Error('变体标识必须是UUID。')
  return value
}
function version(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    throw new Error('变体版本无效。')
  if (/[^\x20-\x7e]/u.test(value)) throw new Error('变体版本含非法字符。')
  return value
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error('变体摘要必须是64位十六进制。')
  return value
}
function size(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 134_217_728)
    throw new Error('变体大小无效。')
  return value
}
function sourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0'))
    throw new Error('变体来源路径无效。')
  if (value.length > 4096) throw new Error('变体来源路径过长。')
  return value
}

export function variantAcquireRequest(value: unknown): VariantAcquireRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('变体获取请求格式无效。')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  const expectedNoArch = 'kind,sha256,size,sourcePath,version'
  const expectedArch = 'architecture,kind,sha256,size,sourcePath,version'
  if (keys !== expectedNoArch && keys !== expectedArch) throw new Error('变体获取请求字段无效。')
  if (!KINDS.has(record.kind as VariantKind)) throw new Error('变体类型无效。')
  const result: VariantAcquireRequest = {
    kind: record.kind as VariantKind,
    sourcePath: sourcePath(record.sourcePath),
    version: version(record.version),
    sha256: sha(record.sha256),
    size: size(record.size)
  }
  if (record.architecture !== undefined) {
    if (!ARCHS.has(record.architecture as VariantArchitecture)) throw new Error('变体架构无效。')
    result.architecture = record.architecture as VariantArchitecture
  }
  return result
}

export function variantSelection(value: unknown): { id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('变体选择参数无效。')
  const record = value as Record<string, unknown>
  if (Object.keys(record).join(',') !== 'id') throw new Error('变体选择只接受标识。')
  return { id: id(record.id) }
}

// Renderer requests contain metadata only. The main process supplies the path
// returned by its file picker after validating this request.
export function variantImportRequest(value: unknown): VariantImportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('变体导入参数无效。')
  const input = value as Record<string, unknown>
  if (Object.hasOwn(input, 'sourcePath')) throw new Error('请使用文件选择窗口指定来源。')
  const { sourcePath: _sourcePath, ...request } = variantAcquireRequest({
    ...input,
    sourcePath: '/main-process-file-picker'
  })
  return request
}

export function variantRecord(value: unknown): VariantRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('变体记录无效。')
  const input = value as Record<string, unknown>
  const { id: recordId, acquiredAt, ...fields } = input
  const selection = variantSelection({ id: recordId })
  if (typeof acquiredAt !== 'number' || !Number.isSafeInteger(acquiredAt) || acquiredAt < 1)
    throw new Error('变体获取时间无效。')
  const request = variantImportRequest(fields)
  if (request.kind === 'core' && !request.architecture) throw new Error('核心变体缺少架构。')
  if (request.kind === 'smart' && request.architecture) throw new Error('Smart模型不接受核心架构。')
  return { ...request, id: selection.id, acquiredAt }
}
