#!/usr/bin/env python3
"""Prepare a private Relay ES/NE App copy for the publisher's outer signature."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile


SPEC = importlib.util.spec_from_file_location(
    'relay_guard_release_pair', Path(__file__).with_name('verify-guard-extension-package.py'))
pair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pair)
PURPOSE = 'Relay requires system approval to install its network filtering and process lineage components.'


def copy_signed(source, destination):
    subprocess.run(['/usr/bin/ditto', str(source), str(destination)], check=True, timeout=180,
                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})


def stage(base, source, signed_components, architecture, output_parent, *, copy=copy_signed,
          inspect=pair.verify_signatures, inspect_entitlements=pair.signed_entitlements):
    inputs = pair.Files()
    team, build, short_version, _ = pair.definitions(inputs, source)
    release = pair.authority(inputs, source / 'native/RelayGuardRelease.swift', 'RelayGuardManagementRelease')
    # This lane has no Terminal launcher verification. That lane has its own
    # authority and package gate and must be published separately.
    for field in ('scopedCLILaunchSupported', 'terminalCLILaunchSupported'):
        pair.compiled_value(release, field, 'false')
    original = pair.app_target(base, architecture, inputs, build, short_version)
    base_resources = base / pair.RELAY_RESOURCES
    pair.require(not os.path.lexists(base / pair.EXTENSION_DIR) and
                 not os.path.lexists(base_resources / 'guard-host'),
                 'the publisher base App already contains Guard components')
    pair.require(stat.S_ISDIR(inputs.track(base_resources).st_mode), 'invalid base App resources')
    inputs.read(base_resources / 'RelayNative', pair.MAX_CODE_BYTES)
    inspect({'team': team, 'targets': [original]})
    entitlements = inspect_entitlements(base, architecture)
    additions = pair.expected_entitlements(team, 'app')
    pair.require(isinstance(entitlements, dict) and
                 all(key not in entitlements or
                     (type(entitlements[key]) is type(value) and entitlements[key] == value)
                     for key, value in additions.items()),
                 'the base App already has conflicting Guard entitlements')
    host_entitlements = {**entitlements, **additions}
    pair.check_entitlements(host_entitlements, team, 'app')

    names = [identifier + '.systemextension' for identifier in (pair.NE_ID, pair.ES_ID)]
    inputs.directory(signed_components, names)
    for name in names:
        inputs.tree(signed_components / name)
    signed_resources = source / 'extra/relay'
    inputs.tree(signed_resources / 'guard-host')
    inputs.read(signed_resources / 'RelayNative', pair.MAX_CODE_BYTES)

    parent = pair.Files().track(output_parent)
    pair.require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid() and
                 base not in (output_parent, *output_parent.parents) and
                 signed_components not in (output_parent, *output_parent.parents),
                 'the output parent must be owned by the publisher and outside the input bundles')
    output = Path(tempfile.mkdtemp(prefix='relay-guard-release-', dir=output_parent))
    try:
        app = output / 'Relay.app'
        copy(base, app)
        copied_base = pair.app_target(app, architecture, pair.Files(), build, short_version)
        inspect({'team': team, 'targets': [copied_base]})
        contents = app / 'Contents'
        resources = app / pair.RELAY_RESOURCES
        library = contents / 'Library'
        library.mkdir(exist_ok=True)
        staged = pair.Files()
        for path in (contents, resources, library):
            pair.require(stat.S_ISDIR(staged.track(path).st_mode), 'unsafe staged App directory')
        (app / pair.EXTENSION_DIR).mkdir()
        for name in names:
            copy(signed_components / name, app / pair.EXTENSION_DIR / name)
        copy(signed_resources / 'guard-host', resources / 'guard-host')
        native = output / 'RelayNative'
        copy(signed_resources / 'RelayNative', native)
        native.replace(resources / 'RelayNative')
        info_path = contents / 'Info.plist'
        info = plistlib.loads(staged.read(info_path, 65536))
        if 'NSSystemExtensionUsageDescription' not in info:
            info['NSSystemExtensionUsageDescription'] = PURPOSE
            info_path.write_bytes(plistlib.dumps(info))

        checked, _, _, targets, components, hosts = pair.bundle_inputs(app, source, signed_components, architecture)
        # The outer seal is pending because the private App copy changed. Every
        # signed nested Guard role must already meet the release requirements.
        inspect({'team': team, 'targets': targets[1:]})
        for name, role in zip(names, ('filter', 'lineage')):
            pair.verify_entitlements(app / pair.EXTENSION_DIR / name, architecture, team, role, inspect_entitlements)
        checked.verify()
        inputs.verify()
        entitlement_file = output / 'Host.entitlements.plist'
        entitlement_file.write_bytes(plistlib.dumps(host_entitlements))
        return {'app': str(app), 'hostEntitlements': str(entitlement_file),
                'architecture': architecture, 'team': team, 'buildVersion': build,
                'extensionSHA256': components, 'guardHostSHA256': hosts,
                'outerAppSigningPending': True, 'installationAttempted': False}
    except Exception:
        shutil.rmtree(output)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-app', required=True, type=Path)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--signed-components', required=True, type=Path)
    parser.add_argument('--architecture', required=True, choices=pair.CPU)
    parser.add_argument('--output-parent', required=True, type=Path)
    args = parser.parse_args()
    try:
        pair.require(sys.platform == 'darwin', 'macOS Security.framework is required')
        result = stage(args.base_app, args.source_root, args.signed_components,
                       args.architecture, args.output_parent)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f'{error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
