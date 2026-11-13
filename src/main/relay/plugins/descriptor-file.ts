import { isAbsolute, extname } from 'path'
import { readBinaryResource } from '../resources/source'

// Main-process path only: callers obtain it from a native picker or open-file.
function descriptorFilePath(sourcePath: unknown): string {
  if (
    typeof sourcePath !== 'string' ||
    !isAbsolute(sourcePath) ||
    sourcePath.length > 4096 ||
    extname(sourcePath).toLowerCase() !== '.cpx' ||
    [...sourcePath].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error('请选择本地CPX描述文件。')
  return sourcePath
}
export function createDescriptorInbox() {
  let pending: string | undefined
  return {
    offer(path: unknown): boolean {
      try {
        pending = descriptorFilePath(path)
        return true
      } catch {
        return false
      }
    },
    hasPending: (): boolean => pending !== undefined,
    take(): string | undefined {
      const path = pending
      pending = undefined
      return path
    },
    clear(): void {
      pending = undefined
    }
  }
}
export async function readDescriptorFile(sourcePath: string): Promise<string> {
  const bytes = await readBinaryResource(descriptorFilePath(sourcePath), false, 1024 * 1024)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
