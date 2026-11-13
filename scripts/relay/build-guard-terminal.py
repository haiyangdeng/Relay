#!/usr/bin/env python3
"""Check Terminal CLI source or explicitly emit an isolated development launcher.

The default reads release metadata. --check-source checks both Swift targets.
--build emits raw development binaries under .relay-build/private. No mode
runs a binary, signs, installs, stages release resources or edits Terminal.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess

from guard_source_plan import resolve, terminal_sources


APP = Path(__file__).resolve().parents[2]
PACKAGE = 'native/guard/terminal/package/manifest.json'
ARCHITECTURES = {'arm64': 0x0100000C, 'x86_64': 0x01000007}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def definition(app, source):
    manifest_path = resolve(app, source, PACKAGE)
    release_path = resolve(app, source, 'native/RelayGuardRelease.swift')
    readiness_path = resolve(app, source, 'native/RelayGuardReadiness.swift')
    builder_path = resolve(app, source, 'electron-builder.relay.yml')
    expected = {
        'schemaVersion': 1,
        'contractRevision': 'relay-guard-terminal-v1',
        'applicationID': 'local.relay.network.preview',
        'buildVersion': '3',
        'minimumMacOS': '13.0',
        'launcherName': 'RelayTerminalCLI',
        'launcherID': 'local.relay.network.preview.guard.terminal-cli',
        'publisherTeamID': None,
        'runtimeReady': False,
        'launcherPin': None,
    }
    if manifest_path.read_bytes() != (json.dumps(expected, indent=2) + '\n').encode('utf-8'):
        raise ValueError('Terminal CLI requires the exact disabled development definition.')
    release = release_path.read_text()
    for declaration in ['buildVersion = "3"', 'publisherTeamID: String? = nil',
                        'scopedCLILaunchSupported = false', 'terminalCLILaunchSupported = false']:
        if not re.search(r'^\s*static let ' + re.escape(declaration) + r'\s*$', release, re.M):
            raise ValueError('Compiled Terminal CLI release authority does not match: ' + declaration)
    if not re.search(r'^\s*static let applicationID = "' + re.escape(expected['applicationID']) + r'"\s*$',
                     readiness_path.read_text(), re.M):
        raise ValueError('Terminal CLI must use the actual Relay App identity.')
    builder = builder_path.read_text()
    if not re.search(r'^appId:\s*' + re.escape(expected['applicationID']) + r'\s*$', builder, re.M):
        raise ValueError('Terminal CLI and packaged App identifiers differ.')
    for key, value in [('buildVersion', expected['buildVersion']), ('minimumSystemVersion', expected['minimumMacOS'])]:
        if not re.search(r"^\s*" + key + r":\s*['\"]?" + re.escape(value) + r"['\"]?\s*$", builder, re.M):
            raise ValueError('Terminal CLI and packaged App version contract differ: ' + key)
    return expected, [manifest_path, release_path, readiness_path, builder_path]


def generated_dependencies(app, source, output):
    readiness = resolve(app, source, 'native/RelayGuardReadiness.swift')
    text = readiness.read_text()
    start = text.index('enum RelayGuardContract {')
    end = text.index('\n}', start) + 2
    contract = output / 'RelayTerminalAppContract.swift'
    contract.write_text('import Foundation\n' + text[start:end] + '\n')
    trust = resolve(app, source, 'native/tun/RelayTunHelperTrust.swift')
    text = trust.read_text()
    start = text.index('enum RelayTunHelperFailure:')
    end = text.index('enum RelayTunInstallationPaths {')
    decoder = output / 'RelayTerminalStrictJSON.swift'
    decoder.write_text('import Foundation\nimport Darwin\n' + text[start:end])
    return [contract, decoder], [readiness, trust]


def invoke(command, log):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    log.write_bytes(result.stdout)
    if result.returncode:
        raise RuntimeError('Terminal CLI compiler or artifact inspection failed. See ' + str(log))
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-root', type=Path, default=APP)
    parser.add_argument('--source-root', type=Path)
    parser.add_argument('--output', type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check-source', action='store_true')
    modes.add_argument('--build', action='store_true')
    args = parser.parse_args()
    app = args.app_root.resolve()
    source = (args.source_root or app).resolve()
    manifest, metadata = definition(app, source)
    if not args.check_source and not args.build:
        print('Terminal CLI disabled release definition matches the compiled App contract.')
        return
    if args.output is None:
        parser.error('--output is required for source checks and raw development builds')
    output = args.output.resolve()
    private = app / '.relay-build/private'
    if output == private or not output.is_relative_to(private):
        parser.error('--output must be a new directory under the App .relay-build/private tree')
    sources = terminal_sources(app, source, host=False)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    generated, upstream = generated_dependencies(app, source, output)
    sources += [resolve(app, source, 'native/RelayGuardRelease.swift'), *generated]
    tracked = {str(path): digest(path) for path in [*metadata, *upstream, *sources]}
    sdk = subprocess.check_output(['/usr/bin/xcrun', '--show-sdk-path'], text=True, timeout=10).strip()
    checks, thin = [], []
    for arch, cpu in ARCHITECTURES.items():
        flags = ['-parse-as-library', '-swift-version', '5', '-strict-concurrency=complete',
                 '-warnings-as-errors', '-sdk', sdk, '-target', arch + '-apple-macosx' + manifest['minimumMacOS'],
                 '-module-cache-path', str(output / ('ModuleCache-' + arch)),
                 '-module-name', manifest['launcherName']]
        inputs = [str(path) for path in sources]
        invoke(['/usr/bin/xcrun', 'swiftc', '-frontend', '-typecheck', *flags, *inputs], output / (arch + '-typecheck.log'))
        checks.append({'kind': 'swift-typecheck', 'architecture': arch, 'exitCode': 0})
        if args.build:
            target = output / (manifest['launcherName'] + '-' + arch)
            invoke(['/usr/bin/xcrun', 'swiftc', '-O', *flags, *inputs, '-framework', 'Foundation',
                    '-framework', 'Security', '-framework', 'CryptoKit', '-o', str(target)], output / (arch + '-build.log'))
            with target.open('rb') as binary:
                header = binary.read(32)
            if (len(header) != 32 or struct.unpack_from('<II', header) != (0xFEEDFACF, cpu)
                    or struct.unpack_from('<I', header, 12)[0] != 2):
                raise ValueError('Unexpected thin launcher architecture or Mach-O file type.')
            thin.append(target)
            checks.append({'kind': 'raw-development-build', 'architecture': arch, 'exitCode': 0})
    artifacts = []
    if args.build:
        universal = output / manifest['launcherName']
        invoke(['/usr/bin/lipo', '-create', *map(str, thin), '-output', str(universal)], output / 'universal-build.log')
        architectures = invoke(['/usr/bin/lipo', '-archs', str(universal)], output / 'universal-architectures.log').decode().split()
        if len(architectures) != 2 or set(architectures) != set(ARCHITECTURES):
            raise ValueError('Terminal CLI universal launcher must contain exactly ARM64 and Intel slices.')
        for path in [*thin, universal]:
            artifacts.append({'path': str(path), 'sha256': digest(path), 'size': path.stat().st_size,
                              'releaseAdmitted': False, 'requiredSigningIdentifier': manifest['launcherID']})
    if any(digest(Path(path)) != sha for path, sha in tracked.items()):
        raise RuntimeError('A source or definition changed during the Terminal CLI build.')
    (output / 'source-checks.json').write_text(json.dumps({
        'schemaVersion': 1, 'runtimeReady': False, 'publisherTeamID': None, 'launcherPin': None,
        'sources': tracked, 'checks': checks, 'developmentArtifacts': artifacts,
        'productionSigningPerformed': False, 'productsExecuted': False, 'resourcesStagedInApp': False,
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
