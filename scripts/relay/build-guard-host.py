#!/usr/bin/env python3
"""Guard main-process Swift/Node-API source check and explicit build.

Default --check only typechecks/syntax-checks. Never loads an addon, launches an
App/Provider/Core, signs/installs, calls a system manager or changes networking.
The explicit --build action creates raw development resources only. Production
release pairing/signing/admission is separate and defaults unavailable.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
from guard_source_plan import (lineage_audit_header, lineage_shared_sources, provider_sources,
                               resolve, reused_observers, terminal_sources)

APP = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-headers', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--source-root', type=Path, default=APP)
    parser.add_argument('--app-root', type=Path, default=APP)
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args()
    source = args.source_root.resolve()
    app = args.app_root.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sdk = Path(subprocess.check_output(['xcrun', '--show-sdk-path'], text=True).strip())
    headers = args.node_headers.resolve()
    required = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']
    assert all((headers / name).is_file() for name in required)
    reuse = reused_observers(app, output)
    # Existing General declarations are type dependencies, not a new copy of
    # their executable entry. Swift primary-file checks only the Guard bodies.
    general = sorted((app / 'native').glob('*.swift')) + sorted((app / 'native/legacy').glob('*.swift'))
    general = [resolve(app, source, str(p.relative_to(app))) for p in general if p.name != 'RelayNative.swift']
    general += [source / 'native' / name for name in ['RelayGuardRelease.swift', 'RelayGuardHostIntegrity.swift'] if not any(p.name == name for p in general)]
    guard = sorted((source / 'native/maintenance').glob('*.swift'))
    guard += sorted((source / 'native/guard/management').glob('*.swift'))
    guard += sorted((source / 'native/guard/communication').glob('*.swift'))
    guard += sorted((source / 'native/guard/bridge').glob('*.swift'))
    guard += terminal_sources(app, source, host=True)
    guard += lineage_shared_sources(app, source)
    guard += [resolve(app, source, "native/guard/RelayGuardPolicy.swift"), resolve(app, source, "native/guard/RelayGuardIdentity.swift")]
    assert guard
    all_swift = general + guard + [reuse]
    audit_header = lineage_audit_header(app, source)
    import re
    core_manifest = json.loads((app / 'src/main/relay/core/manifest.json').read_text())
    pins_text = (source / 'native/guard/communication/RelayGuardCorePins.swift').read_text()
    # No runtime download/update may widen the native proof allowlist.
    for pinned_hash in re.findall(r'"([a-f0-9]{64})"', pins_text):
        assert pinned_hash in json.dumps(core_manifest), 'Guard Core pins are stale'
    release = (source / 'native/RelayGuardRelease.swift').read_text()
    assert 'terminalCLILaunchSupported = false' in release, 'Terminal CLI publication authority must stay disabled'
    package_manifest = json.loads((source / 'native/guard/package/manifest.json').read_text())
    assert 'static let buildVersion = ' + json.dumps(package_manifest['buildVersion']) in release, 'Compiled Guard build/version pairing is stale'
    assert 'sessionContractRevision = \"relay-guard-session-v2\"' in release, 'Guard runtime protocol revision is stale'
    assert package_manifest['publisherTeamID'] is None and package_manifest['runtimeProtectionReady'] is False and package_manifest['systemInstallationSupported'] is False
    assert 'publisherTeamID: String? = nil' in release and 'runtimeProtectionReady = false' in release and 'systemInstallationSupported = false' in release and 'completeClientScopeReady = false' in release
    assert 'policyRevision = \"relay-guard-policy-20261109-v3\"' in release, 'Guard runtime policy revision is stale'
    records = []
    for arch in ['arm64', 'x86_64']:
        cache = output / ('ModuleCache-' + arch)
        flags = ['-parse-as-library', '-swift-version', '5', '-strict-concurrency=complete',
                 '-target', arch + '-apple-macosx13.0', '-sdk', str(sdk), '-module-cache-path', str(cache),
                 '-import-objc-header', str(audit_header)]
        command = ['xcrun', 'swiftc', '-frontend', '-typecheck'] + flags
        for path in all_swift:
            if path in guard or path == reuse or path.name in ['RelayGuardHostIntegrity.swift', 'RelayGuardRelease.swift']: command.append('-primary-file')
            command.append(str(path))
        check = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (output / ('swift-' + arch + '.log')).write_bytes(check.stdout)
        records.append({'kind': 'swift-typecheck', 'architecture': arch, 'exitCode': check.returncode})
        if check.returncode: break
        cpp = ['xcrun', 'clang++', '-fsyntax-only', '-std=c++17', '-fobjc-arc', '-DNAPI_VERSION=4',
               '-DNODE_GYP_MODULE_NAME=relay_guard', '-target', arch + '-apple-macos13.0', '-isysroot', str(sdk),
               '-I' + str(headers), '-I' + str(source / 'native/guard/bridge'),
               str(source / 'native/guard/bridge/RelayGuardAddon.mm')]
        check = subprocess.run(cpp, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (output / ('addon-' + arch + '.log')).write_bytes(check.stdout)
        records.append({'kind': 'addon-syntax', 'architecture': arch, 'exitCode': check.returncode})
        if check.returncode: break
        extension = provider_sources(app, source, output, reuse)
        command = ['xcrun', 'swiftc', '-frontend', '-typecheck'] + flags + [str(p) for p in extension]
        check = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (output / ('provider-' + arch + '.log')).write_bytes(check.stdout)
        records.append({'kind': 'provider-typecheck', 'architecture': arch, 'exitCode': check.returncode})
        if check.returncode: break
        if args.build:
            # Explicit raw artifact production; never used by a source check.
            binary = output / arch
            binary.mkdir()
            library = binary / 'libRelayGuardHost.dylib'
            command = ['xcrun', 'swiftc', '-emit-library', '-module-name', 'RelayGuardHost'] + flags
            command += [str(p) for p in all_swift] + ['-o', str(library), '-Xlinker', '-install_name',
                '-Xlinker', '@rpath/libRelayGuardHost.dylib', '-lbsm']
            subprocess.run(command, check=True)
            link = [x for x in cpp if x != '-fsyntax-only']
            link += ['-bundle', '-undefined', 'dynamic_lookup', '-L' + str(binary), '-lRelayGuardHost',
                     '-Wl,-rpath,@loader_path', '-framework', 'Foundation', '-o', str(binary / 'RelayGuard.node')]
            subprocess.run(link, check=True)
            package = json.loads((app / 'package.json').read_text())
            # Raw unsigned/ad-hoc output is not loadable by the publisher gate.
            # Publication signs the two fixed identities, refreshes these hashes
            # after signing, then seals this manifest in the signed App envelope.
            (binary / 'manifest.json').write_text(json.dumps({
                'version': 1, 'architecture': arch,
                'buildVersion': json.loads((source / 'native/guard/package/manifest.json').read_text())['buildVersion'],
                'files': {name: digest(binary / name) for name in ['RelayGuard.node', 'libRelayGuardHost.dylib']}
            }, indent=2) + '\n')
    report = {'sourceOnly': not args.build, 'sources': {str(p): digest(p) for p in all_swift},
              'auditHeader': {str(audit_header): digest(audit_header)},
              'nodeHeaders': {n: digest(headers / n) for n in required},
              'reuse': {'decoderSource': digest(app / 'native/tun/RelayTunHelperTrust.swift'),
                       'listenerSource': digest(app / 'native/tun/RelayTunOwnedChild.swift')},
              'checks': records, 'appOrCoreLaunched': False, 'systemManagerCalled': False,
              'testsRun': False, 'installed': False, 'signed': False}
    (output / 'static-result.json').write_text(json.dumps(report, indent=2) + '\n')
    raise SystemExit(0 if len(records) == 6 and all(r['exitCode'] == 0 for r in records) else 1)


if __name__ == '__main__':
    main()
