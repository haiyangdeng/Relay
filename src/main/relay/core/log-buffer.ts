import { StringDecoder } from 'string_decoder'
import type { RuntimeLogLine, RuntimeLogSnapshot } from '../../../shared/relay/observability'

const maximumLines = 512,
  maximumBytes = 65536
const sourceNames = ['stdout', 'stderr'] as const
type Source = (typeof sourceNames)[number]

function boundedLine(line: string, limit = maximumBytes): string {
  const bytes = Buffer.from(line)
  if (bytes.length <= limit) return line
  const suffix = '…[日志行已截断]'
  return bytes.subarray(0, limit - Buffer.byteLength(suffix) - 3).toString('utf8') + suffix
}

export function createCoreLogBuffer() {
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
    pending: Partial<Record<Source, RuntimeLogLine>> = {}
  let lines: RuntimeLogLine[] = []
  let sequence = 0
  const fit = (values: RuntimeLogLine[]): RuntimeLogLine[] => {
    let size = values.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0)
    if (values.length <= maximumLines && size <= maximumBytes) return values
    // A long pending line started earlier must not crowd out newer output.
    const ordered = [...values].sort((a, b) => a.sequence - b.sequence)
    let oldest = 0
    while (ordered.length - oldest > maximumLines || size > maximumBytes) {
      size -= Buffer.byteLength(ordered[oldest++].text)
    }
    const retained = new Set(ordered.slice(oldest))
    return values.filter((line) => retained.has(line))
  }
  const snapshot = (): RuntimeLogLine[] => {
    const partials = sourceNames.flatMap((source) => pending[source] ?? [])
    return fit([...lines, ...partials])
  }
  return {
    append(chunk: Buffer, source: Source = 'stdout'): void {
      const previous = pending[source]
      const parts = ((previous?.text ?? '') + decoders[source].write(chunk)).split('\n')
      const tail = boundedLine(parts.pop() ?? '', maximumBytes / 2)
      for (const [index, part] of parts.entries()) {
        const text = boundedLine(part.replace(/\r$/u, ''))
        const continued = index === 0 ? previous?.sequence : undefined
        if (text) lines.push({ sequence: continued ?? ++sequence, text })
      }
      // A line keeps its sequence when its partial text is completed later.
      const continued = parts.length === 0 ? previous?.sequence : undefined
      pending[source] = tail ? { sequence: continued ?? ++sequence, text: tail } : undefined
      lines = fit(lines)
    },
    snapshot(): readonly string[] {
      return snapshot().map((line) => line.text)
    },
    sequencedSnapshot(): RuntimeLogSnapshot {
      return { sequence, lines: snapshot().map((line) => ({ ...line })) }
    }
  }
}
