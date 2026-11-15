import {
  externalDiagnosticRecord,
  type ExternalDiagnosticRecord,
  type OwnedDiagnosticObservation
} from '../../shared/relay/diagnostic-evidence'
import { SimplePrivateDocumentFile } from './simple/store'
import type { RelayStateContext } from './context'

// A historical external record, never an authorization proof or an automatic test result.
// The path and private-file policy are selected by Main, never renderer input.
export function createDiagnosticEvidenceReader(context: RelayStateContext) {
  const file = new SimplePrivateDocumentFile<ExternalDiagnosticRecord | undefined>(
    context,
    'external-verification.json',
    externalDiagnosticRecord,
    () => undefined,
    'diagnostics'
  )
  return {
    path: file.path,
    async read(): Promise<Pick<OwnedDiagnosticObservation['external'], 'status' | 'record'>> {
      try {
        const result = await file.read()
        return result.exists ? { status: 'available', record: result.value } : { status: 'missing' }
      } catch {
        return { status: 'invalid' }
      }
    }
  }
}
