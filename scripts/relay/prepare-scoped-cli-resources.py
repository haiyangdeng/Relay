#!/usr/bin/env python3
"""Prepare an explicit offline pinned Node/CLI resource pair; never execute it.

No download/install/update or node --version invocation. A publication owner
must supply approved distributable resources and update the reviewed definition;
current runtimeReady=false/null assets deliberately refuse preparation.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import struct


def read_plain(path, limit):
    path = path.absolute()
    for cursor in [path, *path.parents]:
        if cursor.is_symlink():
            raise ValueError('Symlink resources are refused')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size < 1 or info.st_size > limit or info.st_mode & 0o022:
        raise ValueError('Resource type/permissions/size are not approved')
    data = path.read_bytes()
    after = path.stat()
    if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('Resource changed while reading')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--definition', required=True, type=Path)
    parser.add_argument('--inputs', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    definition_bytes = read_plain(args.definition, 8192)
    definition = json.loads(definition_bytes)
    if set(definition) != {'schemaVersion', 'runtimeReady', 'assets'} or type(definition['schemaVersion']) is not int or definition['schemaVersion'] != 1 or definition['runtimeReady'] is not True or set(definition['assets']) != {'arm64', 'x64'}:
        raise ValueError('No reviewed runtime CLI resources are approved')
    checked = {}
    for arch, cpu in [('arm64', 0x100000c), ('x64', 0x1000007)]:
        pin = definition['assets'][arch]
        if not isinstance(pin, dict) or set(pin) != {'nodeVersion', 'nodeSHA256', 'cliSHA256'} or not re.fullmatch(r'24\.(?:[5-9]|[1-9][0-9]+)\.[0-9]+', pin['nodeVersion']) or any(not isinstance(pin[k], str) or not re.fullmatch(r'[a-f0-9]{64}', pin[k]) for k in ['nodeSHA256', 'cliSHA256']):
            raise ValueError('Pinned Node>=24.5/CLI definition is invalid')
        node = read_plain(args.inputs / arch / 'node', 128 * 1024 * 1024)
        cli = read_plain(args.inputs / arch / 'cli.js', 128 * 1024 * 1024)
        if len(node) < 32 or (struct.unpack('<II', node[:8]) != (0xfeedfacf, cpu) or struct.unpack('<I', node[12:16])[0] != 2):
            raise ValueError('Node thin Mach-O architecture does not match')
        if hashlib.sha256(node).hexdigest() != pin['nodeSHA256'] or hashlib.sha256(cli).hexdigest() != pin['cliSHA256']:
            raise ValueError('Pinned resources differ; no implicit resign/upgrade')
        # Distribution rights and source origin are explicit release inputs.
        origin = json.loads(read_plain(args.inputs / arch / 'ORIGIN.json', 8192))
        if set(origin) != {'nodeURL', 'cliURL', 'cliVersion', 'distributionApproved'} or origin['distributionApproved'] is not True or any(not isinstance(origin[k], str) or not origin[k].startswith('https://') or '\x00' in origin[k] for k in ['nodeURL', 'cliURL']) or not isinstance(origin['cliVersion'], str) or not origin['cliVersion']:
            raise ValueError('Release source/distribution provenance is absent')
        checked[arch] = {'node': node, 'cli.js': cli,
                         'NODE-LICENSE.txt': read_plain(args.inputs / arch / 'NODE-LICENSE.txt', 1024 * 1024),
                         'CLI-LICENSE.txt': read_plain(args.inputs / arch / 'CLI-LICENSE.txt', 1024 * 1024),
                         'ORIGIN.json': json.dumps(origin, indent=2).encode() + b'\n'}
    # All inputs pass before creating the new private candidate; never overwrite
    # an installed App or user's CLI/configuration. Publication seals the result.
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    for arch, assets in checked.items():
        target = args.output / arch
        target.mkdir(mode=0o755)
        for name, data in assets.items():
            path = target / name
            path.write_bytes(data)
            path.chmod(0o755 if name == 'node' else 0o644)
    (args.output / 'manifest.json').write_bytes(definition_bytes)
    report = {'definitionSHA256': hashlib.sha256(definition_bytes).hexdigest(),
              'files': {str(path.relative_to(args.output)): hashlib.sha256(path.read_bytes()).hexdigest() for path in args.output.rglob('*') if path.is_file()},
              'executableInvoked': False, 'signed': False, 'installed': False,
              'networkOrSystemConfigurationChanged': False,
              'publicationNote': 'Keep Node pinned bytes/signatures; App seal and native publication gate must pass before any launch.'}
    (args.output / 'resource-report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
