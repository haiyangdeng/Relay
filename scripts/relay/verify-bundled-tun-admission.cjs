// Read sealed JavaScript as syntax/data only. Never require, evaluate or launch it.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, realpathSync } = require('node:fs')
const { isAbsolute, join, resolve } = require('node:path')
const asar = require('@electron/asar')
const ts = require('typescript')

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const fail = (message) => {
  throw new Error('Bundled TUN admission: ' + message)
}

function inspectAdmission(source, expected) {
  const tree = ts.createSourceFile(
    'sealed-main.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  if (tree.parseDiagnostics.length) fail('main JavaScript is not parseable')
  const constants = new Map(),
    functions = new Map()
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text
      if (functions.has(name)) fail('duplicate function ' + name)
      functions.set(name, statement)
    }
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const name = declaration.name.text
      if (constants.has(name)) fail('duplicate constant ' + name)
      constants.set(name, declaration.initializer)
    }
  }
  function literal(node, ancestors = new Set()) {
    if (!node) fail('missing constant initializer')
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node))
      return ts.isNumericLiteral(node) ? Number(node.text) : node.text
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (ts.isIdentifier(node)) {
      if (!constants.has(node.text) || ancestors.has(node.text))
        fail('unresolved constant ' + node.text)
      return literal(constants.get(node.text), new Set([...ancestors, node.text]))
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((item) => literal(item, ancestors))
    if (ts.isObjectLiteralExpression(node)) {
      const value = Object.create(null)
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
          fail('nonliteral object property')
        if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
          fail('computed object key')
        const key = property.name.text
        if (Object.hasOwn(value, key)) fail('duplicate object key')
        value[key] = literal(
          ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer,
          ancestors
        )
      }
      return value
    }
    fail('executable initializer is not an admission constant')
  }
  const fn = (name) => functions.get(name) ?? fail('missing admission function ' + name)
  const unwrap = (node) => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node)
  const compact = (node) => node?.getText(tree).replace(/\s/gu, '')
  const terms = (node, operator) => {
    node = unwrap(node)
    return ts.isBinaryExpression(node) && node.operatorToken.kind === operator
      ? [...terms(node.left, operator), ...terms(node.right, operator)]
      : [node]
  }
  const properties = (node, names) => {
    if (!node || !ts.isObjectLiteralExpression(node) || node.properties.length !== names.length)
      fail('admission result has unexpected properties')
    const values = new Map()
    for (const property of node.properties) {
      if (
        (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
        !ts.isIdentifier(property.name) ||
        values.has(property.name.text)
      )
        fail('admission result has spread, method or duplicate properties')
      values.set(
        property.name.text,
        ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer
      )
    }
    if (names.some((name) => !values.has(name))) fail('admission result properties differ')
    return values
  }
  const rejecting = (statement, expression) =>
    ts.isIfStatement(statement) &&
    ts.isThrowStatement(statement.thenStatement) &&
    terms(statement.expression, ts.SyntaxKind.BarBarToken).some(
      (term) => compact(term) === expression
    )
  const equal = (actual, wanted, name) => {
    // JSON objects deliberately carry no prototype in the static reader.
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), wanted)
    } catch {
      fail(name + ' differs from the current package pins')
    }
  }
  const decoder = fn('decodeExecutionInstallationV2')
  equal(literal(decoder.parameters[3]?.initializer), expected.execution, 'execution client')
  equal(
    literal(fn('matchesRuntimeWorkDirectoryClient').parameters[1]?.initializer),
    expected.workDirectory,
    'work-directory client'
  )
  const capability = decoder.parameters[3].name.getText(tree)
  const workCapability = decoder.parameters[4]?.name.getText(tree)
  const rawDeclaration = decoder.body.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          compact(declaration.initializer.expression) === 'parseTunHostFrame'
      )
  )?.declarationList.declarations[0]
  if (!rawDeclaration || !ts.isIdentifier(rawDeclaration.name) || !workCapability)
    fail('decoder manifest input is not explicit')
  const raw = rawDeclaration.name.text
  const clientGuard = `${raw}.client.sha256!==${capability}.clientSHA256&&!matchesRuntimeWorkDirectoryClient(${raw}.client.sha256,${workCapability})`
  if (!decoder.body.statements.some((statement) => rejecting(statement, clientGuard)))
    fail('decoder client hash is not a direct rejecting guard')
  const directory = fn('matchesRuntimeWorkDirectoryClient')
  const directoryReturn = directory.body.statements[0]
  if (
    directory.body.statements.length !== 1 ||
    !ts.isReturnStatement(directoryReturn) ||
    !directoryReturn.expression ||
    !terms(directoryReturn.expression, ts.SyntaxKind.AmpersandAmpersandToken).some(
      (term) =>
        compact(term) ===
        `${directory.parameters[1].name.getText(tree)}.clientSHA256===${directory.parameters[0].name.getText(tree)}`
    )
  )
    fail('work-directory client hash is not its returned predicate')

  const installation = fn('readTunInstallation')
  const v2 = installation.body.statements.filter(
    (statement) =>
      ts.isIfStatement(statement) && compact(statement.expression).includes('core-managed-v2')
  )
  if (v2.length !== 1 || !ts.isBlock(v2[0].thenStatement))
    fail('missing unique live v2 installation branch')
  const liveBranch = v2[0].thenStatement
  const admitted = liveBranch.statements[0]?.declarationList?.declarations[0]
  const call = admitted?.initializer
  if (
    !admitted ||
    !ts.isIdentifier(admitted.name) ||
    !call ||
    !ts.isCallExpression(call) ||
    compact(call.expression) !== 'decodeExecutionInstallationV2' ||
    call.arguments.length !== 3 ||
    compact(call.arguments[0]) !== 'bytes' ||
    compact(call.arguments[1]) !== 'process.arch' ||
    compact(call.arguments[2]) !== 'process.getuid?.()??0'
  )
    fail('live installation does not call the default pinned decoder')
  const admittedName = admitted.name.text
  if (
    !liveBranch.statements.some((statement) =>
      rejecting(statement, `resourceHash(clientBytes)!==${admittedName}.clientSHA256`)
    )
  )
    fail('live client bytes are not checked against admission')
  const liveReturn = liveBranch.statements.at(-1)
  if (!ts.isReturnStatement(liveReturn)) fail('live installation does not return admission')
  const liveFields = properties(liveReturn.expression, [
    'execution',
    'executionCore',
    'revision',
    'helperSHA256',
    'coreSHA256',
    'clientSHA256'
  ])
  for (const [name, expression] of [
    ['executionCore', `${admittedName}.core`],
    ['revision', `${admittedName}.revision`],
    ['helperSHA256', `${admittedName}.clientSHA256`],
    ['coreSHA256', `${admittedName}.core.sha256`],
    ['clientSHA256', `${admittedName}.clientSHA256`]
  ]) {
    if (compact(liveFields.get(name)) !== expression)
      fail('live installation return is detached from admission')
  }

  const compiled = fn('compiledExecutionCoreV2')
  const branches = compiled.body.statements.filter(
    (node) =>
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      ts.isIdentifier(node.expression.left) &&
      node.expression.left.text === compiled.parameters[0].name.getText(tree) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isStringLiteral(node.expression.right) &&
      node.expression.right.text === 'local-geodata-v1'
  )
  if (branches.length !== 1 || !ts.isBlock(branches[0].thenStatement))
    fail('missing unique geodata admission branch')
  const branch = branches[0].thenStatement
  const declaration = branch.statements[0]?.declarationList?.declarations[0]
  const access = declaration?.initializer
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !access ||
    !ts.isElementAccessExpression(access) ||
    !ts.isPropertyAccessExpression(access.expression) ||
    access.expression.name.text !== 'assets' ||
    !ts.isIdentifier(access.expression.expression) ||
    !ts.isIdentifier(access.argumentExpression) ||
    access.argumentExpression.text !== compiled.parameters[1]?.name.getText(tree)
  )
    fail('geodata assets are not the compiled admission input')
  const manifestName = access.expression.expression.text
  equal(literal(access.expression.expression), expected.geodata, 'geodata manifest')
  const returned = branch.statements[1]
  const result = returned && ts.isReturnStatement(returned) ? returned.expression : undefined
  if (
    branch.statements.length !== 2 ||
    !result ||
    !ts.isCallExpression(result) ||
    result.expression.getText(tree) !== 'Object.freeze' ||
    result.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(result.arguments[0])
  )
    fail('geodata admission result shape changed')
  const fields = properties(result.arguments[0], [
    'profile',
    'architecture',
    'version',
    'sha256',
    'size'
  ])
  for (const [field, expression] of [
    ['version', manifestName + '.version'],
    ['sha256', declaration.name.text + '.sha256'],
    ['size', declaration.name.text + '.size']
  ]) {
    if (compact(fields.get(field)) !== expression)
      fail('compiled geodata ' + field + ' is not tied to its manifest')
  }
  let coreCalls = 0
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'compiledExecutionCoreV2'
    )
      coreCalls++
    ts.forEachChild(node, visit)
  }
  visit(decoder)
  if (coreCalls !== 2) fail('decoder no longer uses both compiled core admission checks')
  return {
    executionClientSHA256: expected.execution.clientSHA256,
    workDirectoryClientSHA256: expected.workDirectory.clientSHA256
  }
}

function physicalFile(path, maximum) {
  const info = lstatSync(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== path ||
    info.size < 1 ||
    info.size > maximum
  )
    fail('invalid physical input ' + path)
  return readFileSync(path)
}

function verifyBundledTunAdmission(app, client, project = resolve(__dirname, '../..')) {
  if (
    ![app, client, project].every(isAbsolute) ||
    !app.endsWith('/Relay.app') ||
    realpathSync(app) !== app
  )
    fail('absolute physical Relay.app and client paths required')
  const archive = join(app, 'Contents/Resources/app.asar')
  const before = sha(physicalFile(archive, 1024 * 1024 * 1024))
  const readEntry = (name, limit) => {
    const info = asar.statFile(archive, name)
    if (
      info.unpacked ||
      info.link ||
      !Number.isSafeInteger(info.size) ||
      info.size < 1 ||
      info.size > limit
    )
      fail('entry must be sealed in asar: ' + name)
    return asar.extractFile(archive, name)
  }
  const metadata = JSON.parse(readEntry('package.json', 1024 * 1024).toString('utf8'))
  if (metadata.main !== './out/main/index.js') fail('unexpected main entry')
  const source = readEntry('out/main/index.js', 64 * 1024 * 1024)
  const expected = {
    execution: json(join(project, 'src/main/relay/tun/execution-client.json')),
    workDirectory: json(join(project, 'src/main/relay/tun/runtime-work-directory-client.json')),
    geodata: json(join(project, 'src/main/relay/core/geodata-manifest.json'))
  }
  const admission = inspectAdmission(source.toString('utf8'), expected)
  const clientSHA256 = sha(physicalFile(client, 128 * 1024 * 1024))
  if (
    clientSHA256 !== admission.executionClientSHA256 ||
    clientSHA256 !== admission.workDirectoryClientSHA256
  )
    fail('actual client is not admitted by the sealed App')
  const cores = {}
  for (const [arch, native] of [
    ['arm64', 'arm64'],
    ['x64', 'x86_64']
  ]) {
    const pin = expected.geodata.assets[arch]
    if (pin.path !== 'darwin-' + arch + '/mihomo') fail('unexpected core path')
    const bytes = physicalFile(
      join(app, 'Contents/Resources/relay/core-geodata-v1', pin.path),
      128 * 1024 * 1024
    )
    if (bytes.length !== pin.size || sha(bytes) !== pin.sha256)
      fail('bundled ' + arch + ' core is not admitted by sealed App')
    cores[native] = { sha256: pin.sha256, size: pin.size }
  }
  if (sha(physicalFile(archive, 1024 * 1024 * 1024)) !== before)
    fail('asar changed during verification')
  return {
    passed: true,
    appASARSHA256: before,
    mainSHA256: sha(source),
    clientSHA256,
    cores,
    applicationCodeExecuted: false
  }
}

module.exports = { inspectAdmission, verifyBundledTunAdmission }
if (require.main === module) {
  if (process.argv.length !== 4)
    fail(
      'usage: node verify-bundled-tun-admission.cjs /absolute/Relay.app /absolute/RelayTunClient'
    )
  process.stdout.write(
    JSON.stringify(verifyBundledTunAdmission(process.argv[2], process.argv[3])) + '\n'
  )
}
