#!/usr/bin/env python3
"""Typecheck the bounded ordinary-Core owner; only --build emits raw resources.
No helper/Core launch, signature, installation, networking or system operation.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--source-root', type=Path)
    parser.add_argument('--release-manifest', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args()
    app = args.app_root.resolve()
    source = (args.source_root or app).resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    manifest_path = args.release_manifest or source / 'src/main/relay/core-owner/release-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    assert manifest == {
        'schemaVersion': 1, 'contract': 'relay-ordinary-core-owner-v1', 'enabled': False,
        'publisherTeamID': None, 'applicationID': 'local.relay.network.preview',
        'helperID': 'local.relay.network.preview.core-owner', 'helperName': 'RelayCoreOwner',
        'assets': {'arm64': None, 'x64': None}
    }, 'Source proposal must retain the disabled, unpinned release authority'
    guard_source = app / 'native/RelayGuardReadiness.swift'
    guard = guard_source.read_text()
    start = guard.index('enum RelayGuardContract {')
    end = guard.index('\n}', start) + 2
    app_contract = guard[start:end]
    assert 'applicationID = "' + manifest['applicationID'] + '"' in app_contract
    builder = (app / 'electron-builder.relay.yml').read_text()
    assert re.search(r'^appId:\s*' + re.escape(manifest['applicationID']) + r'\s*$', builder, re.M)
    contract_path = out / 'RelayCoreOwnerAppContract.swift'
    contract_path.write_text('import Foundation\n' + app_contract + '\n')
    # Reuse exactly the fixed production strict decoder and Darwin24 listener
    # observer, as the existing Guard source plan already does. No new parser.
    trust = app / 'native/tun/RelayTunHelperTrust.swift'
    child = app / 'native/tun/RelayTunOwnedChild.swift'
    trust_text, child_text = trust.read_text(), child.read_text()
    decoder = trust_text[trust_text.index('enum RelayTunHelperFailure:'):trust_text.index('enum RelayTunInstallationPaths {')]
    listener = child_text[child_text.index('enum RelayTunTCPListener {'):]
    reuse = out / 'RelayCoreOwnerReusedObservers.swift'
    reuse.write_text('import Foundation\nimport CoreFoundation\nimport Darwin\n' + decoder + listener)
    swift = sorted((source / 'native/core-owner').glob('*.swift'))
    assert len(swift) == 9, 'Incomplete owner source closure'
    authority = (source / 'native/core-owner/RelayCoreOwnerContract.swift').read_text()
    assert 'static let enabled = false' in authority and 'publisherTeamID: String? = nil' in authority
    assert 'applicationID = RelayGuardContract.applicationID' in authority
    assert 'helperID = RelayGuardContract.applicationID + ".core-owner"' in authority
    pins = json.loads((app / 'src/main/relay/core/manifest.json').read_text())
    for arch in ['arm64', 'x64']:
        assert pins['assets'][arch]['sha256'] in authority
        assert str(pins['assets'][arch]['size']) in authority
    sources = swift + [contract_path, reuse]
    sdk = subprocess.check_output(['xcrun', '--show-sdk-path'], text=True).strip()
    results = []
    for arch in ['arm64', 'x86_64']:
        command = ['xcrun', 'swiftc', '-frontend', '-typecheck', '-parse-as-library', '-swift-version', '5',
                   '-strict-concurrency=complete', '-sdk', sdk, '-target', arch + '-apple-macosx13.0',
                   '-module-cache-path', str(out / ('ModuleCache-' + arch))]
        command += [str(p) for p in sources]
        check = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (out / (arch + '-typecheck.log')).write_bytes(check.stdout)
        results.append({'kind': 'swift-typecheck', 'architecture': arch, 'exitCode': check.returncode})
        if check.returncode:
            break
        if args.build:
            # Only raw per-arch resources. Packaging/signing/pins require their
            # separate release admission; this command never changes the App.
            command = ['xcrun', 'swiftc', '-parse-as-library', '-swift-version', '5', '-O',
                       '-sdk', sdk, '-target', arch + '-apple-macosx13.0', '-module-cache-path', str(out / ('ModuleCache-' + arch))]
            command += [str(p) for p in sources]
            command += ['-framework', 'Foundation', '-framework', 'Security', '-framework', 'CryptoKit',
                        '-o', str(out / ('RelayCoreOwner-' + arch))]
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            (out / (arch + '-build.log')).write_bytes(result.stdout)
            results.append({'kind': 'explicit-raw-build', 'architecture': arch, 'exitCode': result.returncode})
            if result.returncode:
                break
    artifacts = []
    if args.build and len(results) == 4 and all(r['exitCode'] == 0 for r in results):
        target = out / 'RelayCoreOwner'
        command = ['lipo', '-create', str(out / 'RelayCoreOwner-arm64'), str(out / 'RelayCoreOwner-x86_64'), '-output', str(target)]
        merged = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (out / 'universal-build.log').write_bytes(merged.stdout)
        results.append({'kind': 'explicit-raw-universal', 'exitCode': merged.returncode})
        if merged.returncode == 0:
            artifacts.append({'path': str(target), 'sha256': sha(target), 'size': target.stat().st_size,
                              'requiredCodeIdentifier': manifest['helperID'], 'signed': False,
                              'installed': False, 'admittedResourcePin': False})
    evidence = {'version': 1, 'contract': manifest['contract'], 'enabled': False, 'publisherTeamID': None,
                'resourcePinsGenerated': False, 'productsExecuted': False, 'networkExecuted': False, 'artifacts': artifacts,
                'upstreamReuse': [{'path': str(p), 'sha256': sha(p)} for p in [guard_source, trust, child]],
                'sources': [{'path': str(p), 'sha256': sha(p)} for p in sources],
                'releaseManifest': {'path': str(manifest_path), 'sha256': sha(manifest_path)}, 'checks': results}
    (out / 'source-checks.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    raise SystemExit(0 if results and all(r['exitCode'] == 0 for r in results) else 1)


if __name__ == '__main__':
    main()
