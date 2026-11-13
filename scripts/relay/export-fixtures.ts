import { writeFileSync } from 'fs'
import { createPreviewBackend, previewReadChannels } from '../../src/main/relay/preview'
const backend = createPreviewBackend()
writeFileSync(
  '../evidence/preview-fixtures.json',
  JSON.stringify(
    Object.fromEntries(previewReadChannels.map((channel) => [channel, backend(channel)]))
  )
)
