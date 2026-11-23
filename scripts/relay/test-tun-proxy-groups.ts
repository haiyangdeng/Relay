import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createProxyGroupChannel } from '../../src/main/relay/tun/proxy-groups'
import { projectProxyGroups } from '../../src/main/relay/clash-backend'

const binding = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  evidenceSHA256: 'e'.repeat(64),
  runtimeConfigurationSHA256: 'a'.repeat(64)
}
const hash = 'c'.repeat(64),
  revision = 'b'.repeat(64)
const input = new PassThrough(),
  output = new PassThrough()
const lane = createProxyGroupChannel(input, output, binding, hash, revision)
const hello = {
  ...binding,
  version: 4,
  kind: 'hello',
  capability: 'proxy-groups-v1',
  launchClientSHA256: hash,
  installationRevision: revision
}
output.write(JSON.stringify(hello) + '\n')
let pick = 'NodeA'
const names = ['组 / %2F', 'GLOBAL']
const table = () => ({
  [names[0]]: { name: names[0], type: 'Selector', now: pick, all: ['NodeA', 'NodeB'] },
  GLOBAL: { name: 'GLOBAL', type: 'Selector', now: names[0], all: [names[0]] },
  NodeA: { name: 'NodeA', type: 'Http' },
  NodeB: { name: 'NodeB', type: 'Http', 'provider-name': 'Fixture' }
})
const requests: string[] = []
input.on('data', (chunk) => {
  const req = JSON.parse(chunk.toString())
  assert.equal(req.id, requests.length + 1)
  assert.equal(req.sessionId, binding.sessionId)
  requests.push(req.action)
  if (req.action === 'select') {
    assert.equal(req.group, names[0])
    pick = req.member
  }
  const reply = Buffer.from(
    JSON.stringify({
      ...binding,
      version: 4,
      id: req.id,
      action: req.action,
      status: 'groups',
      groupsBase64: Buffer.from(JSON.stringify(req.action === 'groups' ? table() : {})).toString(
        'base64'
      )
    }) + '\n'
  )
  output.write(reply.subarray(0, 17))
  output.write(reply.subarray(17))
})
const [before, , after] = await Promise.all([
  lane({ action: 'groups' }),
  lane({ action: 'select', group: names[0], member: 'NodeB' }),
  lane({ action: 'groups' })
])
assert.deepEqual(requests, ['groups', 'select', 'groups'])
assert.equal(before[names[0]].now, 'NodeA')
assert.equal(after[names[0]].now, 'NodeB')
const projected = projectProxyGroups(
  new Map(Object.entries(after)),
  { 'proxy-groups': [{ name: names[0] }] },
  'global',
  false
)
assert.deepEqual(
  projected.map((g) => g.name),
  ['GLOBAL', names[0]]
)
assert.deepEqual(projected[1].all, [after.NodeA, after.NodeB])
assert.deepEqual(projectProxyGroups(new Map(), {}, 'direct', false), [])
const staleOutput = new PassThrough()
const stale = createProxyGroupChannel(new PassThrough(), staleOutput, binding, hash, revision)
staleOutput.write(JSON.stringify({ ...hello, sessionId: 'other' }) + '\n')
await assert.rejects(stale({ action: 'groups' }))
process.stdout.write(
  'TUN group channel verified session binding, split frames, serialized reads/select, live provider members and mode ordering.\n'
)
