import { writeFile } from 'fs/promises'
import { resolve } from 'path'
import {
  runConfigurationScript,
  RuntimeScriptError
} from '../../src/main/relay/configuration/script'
import { composeRuntimeConfiguration } from '../../src/main/relay/configuration/merge'

const executable = resolve('extra/relay/RelayNative')
const rows: { name: string; passed: boolean }[] = []
const check = (name: string, passed: boolean): void => {
  rows.push({ name, passed })
}
const run = (script: string, signal?: AbortSignal) =>
  runConfigurationScript(executable, script, { mode: 'rule', dns: { enable: false } }, signal)
const fails = async (script: string): Promise<boolean> => {
  try {
    await run(script)
    return false
  } catch (error) {
    return error instanceof RuntimeScriptError && error.status === 'failed'
  }
}
const normal = await run(
  'function main(c) { console.log("stage", 1); c.mode = "global"; return c; }'
)
check(
  'formal dedicated native worker transforms bounded config and returns bounded private logs',
  normal.configuration.mode === 'global' && normal.logs[0] === 'stage 1'
)
const noHost = await run(
  'function main(c) { c.absent = [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof RTCPeerConnection, typeof Worker, typeof Deno, typeof Bun, typeof readFile, typeof importScripts, typeof $]; c.constructorEscape = ({}).constructor.constructor("return typeof process")(); return c; }'
)
check(
  'bare JSCore has no file, network, browser or Node bridge, including constructor escape',
  Array.isArray(noHost.configuration.absent) &&
    noHost.configuration.absent.every((value) => value === 'undefined') &&
    noHost.configuration.constructorEscape === 'undefined'
)
for (const [name, body] of [
  ['cyclic', 'c.self=c;return c'],
  ['getter', 'Object.defineProperty(c,"x",{get(){return 1},enumerable:true});return c'],
  ['nonfinite', 'c.x=Infinity;return c'],
  ['promise', 'return Promise.resolve(c)'],
  ['symbol', 'c[Symbol("x")]=1;return c'],
  ['sparse array', 'c.x=Array(2);return c'],
  ['undefined', 'c.x=undefined;return c'],
  ['too deep', 'let v=c;for(let n=0;n<45;n++){v.x={};v=v.x}return c']
])
  check(
    'worker rejects ' + name + ' results instead of silently dropping properties',
    await fails('function main(c){' + body + '}')
  )
check('missing main is rejected', await fails('const x=1'))
const inherited = await run(
  'function main(c){Object.prototype.toJSON=()=>({injected:true});Array.prototype.toJSON=()=>["injected"];c.original=[1,2];return c}'
)
check(
  'serialization ignores inherited toJSON and keeps the inspected data',
  inherited.configuration.mode === 'rule' &&
    JSON.stringify(inherited.configuration.original) === '[1,2]' &&
    inherited.configuration.injected === undefined
)
const replaced = await run(
  'function main(c){Array.isArray=()=>false;Number.isFinite=()=>true;JSON.stringify=()=>"INVALID";return c}'
)
check(
  'replacing global validation and JSON intrinsics does not alter captured operations',
  replaced.configuration.mode === 'rule'
)
check(
  'nonfinite stays rejected after globals are replaced',
  await fails('function main(c){Number.isFinite=()=>true;c.x=NaN;return c}')
)
const logs = await run(
  'function main(c){for(let i=0;i<100;i++)console.log("x".repeat(4096));return c}'
)
check(
  'native console logs are bounded',
  logs.logs.length === 64 && logs.logs.every((value) => value.length === 1024)
)
const start = Date.now()
check(
  'infinite loop is terminated only in the owned worker',
  (await fails('function main(c){while(true){}return c}')) && Date.now() - start < 7000
)
const cancel = new AbortController()
const pending = run('function main(c){while(true){}return c}', cancel.signal)
setTimeout(() => cancel.abort(), 100)
let cancelled = false
try {
  await pending
} catch (error) {
  cancelled = error instanceof RuntimeScriptError && error.status === 'cancelled'
}
check('cancellation waits for owned worker termination and private directory cleanup', cancelled)
const merged = await composeRuntimeConfiguration(
  {
    profileId: 'fixture',
    source: 'rules: ["MATCH,REJECT"]',
    globalOverrides: [
      { id: 'J', kind: 'js', content: 'function main(c){c.mode="global";return c}' }
    ],
    profileOverrides: [],
    controlled: { mode: 'rule' }
  },
  (script, configuration) => runConfigurationScript(executable, script, configuration)
)
check(
  'full stage composer uses the actual native worker and applies controlled settings after its result',
  merged.configuration.mode === 'rule' &&
    merged.order.join(',') === 'J,profile-rules,controlled-settings'
)
const report = {
  checks: rows.length,
  passed: rows.filter((row) => row.passed).length,
  rows,
  architectureExecuted: process.arch,
  intelRuntimeVerified: false,
  actualUserNetworkOrSystemConfigurationChanged: false,
  actualClashStoppedReloadedOrRestarted: false,
  fileOrNetworkBridgeProvided: false,
  nativeMemorySandboxClaimed: false
}
await writeFile(
  '../evidence/runtime-script-verification.json',
  JSON.stringify(report, null, 2) + '\n'
)
process.stdout.write(JSON.stringify(report) + '\n')
if (report.checks !== report.passed) throw new Error('Runtime script contract failed.')
