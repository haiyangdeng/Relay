'use strict'
process.umask(0o077)
const http = require('node:http')
const readline = require('node:readline')
const servers = new Set()
let nonce
let stopping = false
function close() {
  if (stopping) return
  stopping = true
  const [server] = servers
  if (!server) process.exit(0)
  server.close(() => process.exit(0))
  server.closeAllConnections?.()
}
process.on('SIGTERM', close)
process.on('disconnect', close)
process.on('message', (message) => {
  if (message?.type === 'stop' && (nonce === undefined || message.nonce === nonce)) close()
})
const reader = readline.createInterface({ input: process.stdin })
reader.once('line', (line) => {
  reader.close()
  const configuration = JSON.parse(line)
  nonce = configuration.nonce
  const bindHost = configuration.bindHost ?? '127.0.0.1'
  if (!['127.0.0.1', '0.0.0.0'].includes(bindHost))
    throw new Error('Unexpected Sub-Store binding request')
  const original = http.Server.prototype.listen
  http.Server.prototype.listen = function (...args) {
    if (servers.size) throw new Error('Only one Sub-Store server is admitted')
    servers.add(this)
    this.once('listening', () => {
      const address = this.address()
      if (!address || typeof address !== 'object' || address.address !== bindHost)
        throw new Error('Unexpected Sub-Store binding')
      process.send?.({ type: 'ready', nonce, port: address.port })
    })
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined
    return callback ? original.call(this, 0, bindHost, callback) : original.call(this, 0, bindHost)
  }
  require(configuration.backendPath)
})
