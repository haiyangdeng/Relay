import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  RelaySimpleConfigurationMetadata,
  RelaySimpleConfigurationSave
} from '../../../shared/relay/simple-configuration'
import type { RelayStateContext } from '../context'
import { configurationEditDocument } from '../../../shared/relay/configuration-edit'
import { SIMPLE_SHARED_CONFIG_KEYS } from '../../../shared/simple-config'
import type { SimpleSharedConfig } from '../../simple/compiler'
import { profileHash, readProfileFile } from '../profiles/source'
import { SubscriptionFiles } from '../subscriptions/private-files'
import {
  boundedJSON,
  clone,
  keys,
  object,
  publicView,
  revision,
  SIMPLE_DOCUMENT_BYTES,
  SimpleFailure,
  type SimpleRecord
} from './model'

const invalid = (): never => {
  throw new SimpleFailure('invalid')
}
export function configurationBindingMetadata(
  record: SimpleRecord
): RelaySimpleConfigurationMetadata {
  const { sources: _sources, ...metadata } = publicView(record)
  const pin = record.document.configurationRevision.draft
  return { ...metadata, sharedConfigurationPinned: pin !== '', configurationRevision: pin }
}
export function configurationBindingSave(raw: unknown): RelaySimpleConfigurationSave {
  try {
    boundedJSON(raw)
    keys(raw, ['expectedRevision', 'configurationRevision'])
    revision(raw.expectedRevision)
    revision(raw.configurationRevision)
    return {
      expectedRevision: raw.expectedRevision,
      configurationRevision: raw.configurationRevision
    }
  } catch {
    return invalid()
  }
}

// Main-only fixed private file. No ConfigStore.read, renderer path or latest fallback.
export function createPinnedSimpleConfigurationReader(context: RelayStateContext) {
  const location = Object.freeze({ home: context.home, stateRoot: context.stateRoot }),
    files = new SubscriptionFiles(location),
    directory = join(location.stateRoot, 'Configuration'),
    path = join(directory, 'configuration-edit.json')
  type Facts = { revision: string; shared: SimpleSharedConfig }
  const inspect = async (
    signal: AbortSignal,
    assertCurrent?: () => void,
    expected?: string
  ): Promise<Facts | undefined> => {
    const live = (): void => {
      if (signal.aborted) throw new SimpleFailure('cancelled')
      assertCurrent?.()
    }
    const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
      live()
      try {
        return await operation()
      } finally {
        live()
      }
    }
    try {
      live()
      if (!(await wait(() => files.directory(directory)))) return undefined
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await wait(() => lstat(path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size < 1 ||
        info.size > SIMPLE_DOCUMENT_BYTES
      )
        return invalid()
      const text = await wait(() => readProfileFile(path, true))
      if (Buffer.byteLength(text) > SIMPLE_DOCUMENT_BYTES) return invalid()
      if (!(await wait(() => files.directory(directory)))) throw new SimpleFailure('stale')
      const digest = profileHash(text)
      if (expected !== undefined && digest !== expected) throw new SimpleFailure('stale')
      const parsed: unknown = JSON.parse(text)
      boundedJSON(parsed, SIMPLE_DOCUMENT_BYTES, SIMPLE_DOCUMENT_BYTES)
      const controlled = configurationEditDocument(parsed).controlled,
        shared: SimpleSharedConfig = {}
      for (const key of SIMPLE_SHARED_CONFIG_KEYS) {
        if (!Object.hasOwn(controlled, key)) continue
        const value = controlled[key]
        if (key === 'dns' || key === 'sniffer') {
          if (!object(value)) return invalid()
          shared[key] = clone(value)
        } else if (key === 'hosts') {
          if (!object(value)) return invalid()
          const hosts: Record<string, string | string[]> = {}
          for (const [host, entry] of Object.entries(value)) {
            if (typeof entry === 'string') hosts[host] = entry
            else if (
              Array.isArray(entry) &&
              entry.every((item): item is string => typeof item === 'string')
            )
              hosts[host] = [...entry]
            else return invalid()
          }
          shared.hosts = hosts
        } else if (key === 'geodata-mode') {
          if (typeof value !== 'boolean') return invalid()
          shared[key] = value
        } else return invalid()
      }
      live()
      return { revision: digest, shared }
    } catch (error) {
      live()
      throw error instanceof SimpleFailure ? error : new SimpleFailure('stale')
    }
  }
  return {
    async readPinned(pin: string, signal: AbortSignal, assertCurrent?: () => void): Promise<Facts> {
      revision(pin)
      if (signal.aborted) throw new SimpleFailure('cancelled')
      assertCurrent?.()
      if (!pin) return { revision: '', shared: {} }
      const current = await inspect(signal, assertCurrent, pin)
      if (signal.aborted) throw new SimpleFailure('cancelled')
      assertCurrent?.()
      if (!current) throw new SimpleFailure('stale')
      return current
    },
    inspectCurrent: (signal: AbortSignal, assertCurrent?: () => void): Promise<Facts | undefined> =>
      inspect(signal, assertCurrent)
  }
}
