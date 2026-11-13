import { downloadSubscription } from '../../src/main/relay/subscriptions/transfer'

// This child alone trusts the fixture certificate via NODE_EXTRA_CA_CERTS.
// Product transport has no verification-disable or arbitrary CA option.
const port = Number(process.argv[2]),
  url = process.argv[3]
if (
  !url ||
  new URL(url).hostname !== 'localhost' ||
  process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '1'
)
  throw new Error('invalid TLS fixture context')
try {
  const source = await downloadSubscription(url, port, new AbortController().signal)
  process.stdout.write(
    JSON.stringify({ accepted: source.startsWith('\ufeff# PRIVATE fixture\n') }) + '\n'
  )
} catch {
  throw new Error('isolated TLS fixture request failed')
}
