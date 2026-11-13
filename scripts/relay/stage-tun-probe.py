#!/usr/bin/env python3
"""Stage only fixed probe/core resources as the ordinary user; never execute them."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import uuid

uid = os.getuid()
assert uid > 0 and os.geteuid() == uid
app = Path(__file__).resolve().parents[2]
roles = {
    'descriptor-client': (app / '.relay-build/tun-descriptor-probe/RelayTunDescriptorProbeClient', 'TunDescriptorProbe'),
    'descriptor-probe': (app / '.relay-build/tun-descriptor-probe/RelayTunDescriptorProbe', 'TunDescriptorProbe'),
    'core-client': (app / '.relay-build/tun-core-probe/RelayTunCoreProbeClient', 'TunCoreProbe'),
    'core-probe': (app / '.relay-build/tun-core-probe/RelayTunCoreProbe', 'TunCoreProbe'),
    'core-arm64': (app / 'extra/relay/core/darwin-arm64/mihomo', 'TunCoreProbe'),
    'core-x64': (app / 'extra/relay/core/darwin-x64/mihomo', 'TunCoreProbe'),
}
assert len(sys.argv) == 2 and sys.argv[1] in roles
role = sys.argv[1]
source, namespace = roles[role]
assert source.is_absolute() and Path(os.path.realpath(source)) == source
policy_spec = importlib.util.spec_from_file_location('relay_probe_copy_policy', app / 'scripts/relay/build-tun-candidate.py')
policy = importlib.util.module_from_spec(policy_spec)
policy_spec.loader.exec_module(policy)
source_before = policy.source_chain(source)
policy.source_info(source)

def identity(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))

def read_checked(path):
    first = path.lstat()
    policy.attributes(path)
    assert stat.S_ISREG(first.st_mode) and first.st_uid == uid and first.st_nlink == 1
    assert stat.S_IMODE(first.st_mode) == 0o755 and 0 < first.st_size <= 64 * 1024 * 1024
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        assert identity(os.fstat(fd)) == identity(first)
        chunks = []
        total = 0
        while total < first.st_size:
            chunk = os.read(fd, min(1024 * 1024, first.st_size - total))
            assert chunk
            chunks.append(chunk)
            total += len(chunk)
        assert identity(os.fstat(fd)) == identity(first) == identity(path.lstat())
        return b''.join(chunks)
    finally:
        os.close(fd)

contents = read_checked(source)
digest = hashlib.sha256(contents).hexdigest()
if role.startswith('core-') and role not in ('core-client', 'core-probe'):
    arch = role.removeprefix('core-')
    manifest = json.loads((app / 'src/main/relay/core/manifest.json').read_text())
    frozen = {'arm64': ('f3e8ae41397c08cbf900ce1f7c8a168285d29954e9bca5d84d69a2b2561adfe9', 56810034),
              'x64': ('291f5923c3dd3b8df36eaeccdd59eaf873ee021693cde65eb696f8b86ac99652', 60945968)}
    assert manifest['version'] == 'v1.19.33'
    assert (digest, len(contents)) == frozen[arch]
    assert (manifest['assets'][arch]['sha256'], manifest['assets'][arch]['size']) == frozen[arch]
home = Path(pwd.getpwuid(uid).pw_dir)
assert home.is_absolute() and Path(os.path.realpath(home)) == home
ancestors = []
def cache_attributes(path):
    # FinderInfo on the existing Library anchor is known Finder metadata, not
    # execution permission. Preserve its exact digest; never strip attributes.
    if path != home / 'Library':
        return policy.attributes(path)
    names = set(policy.run(['/usr/bin/xattr', str(path)]).stdout.splitlines())
    assert names.issubset({'com.apple.provenance', 'com.apple.FinderInfo'})
    return {name: hashlib.sha256(bytes.fromhex(policy.run(['/usr/bin/xattr', '-px', name, str(path)]).stdout)).hexdigest() for name in sorted(names)}

for directory in (home, home / 'Library', home / 'Library/Caches'):
    info = directory.lstat()
    assert stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == uid
    assert stat.S_IMODE(info.st_mode) & 0o7022 == 0 and Path(os.path.realpath(directory)) == directory
    ancestors.append((directory, info, cache_attributes(directory)))
cache = home / 'Library/Caches/local.relay.network' / namespace
for directory in (cache.parent, cache, cache / digest):
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = directory.lstat()
    assert stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == uid
    assert stat.S_IMODE(info.st_mode) == 0o700 and Path(os.path.realpath(directory)) == directory
    ancestors.append((directory, info, cache_attributes(directory)))

def check_directories():
    for directory, first, attributes in ancestors:
        current = directory.lstat()
        assert (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid) == (first.st_dev, first.st_ino, first.st_mode, first.st_uid, first.st_gid)
        assert Path(os.path.realpath(directory)) == directory
        assert cache_attributes(directory) == attributes

target = cache / digest / source.name
try:
    target.lstat()
except FileNotFoundError:
    temporary = target.parent / ('.' + source.name + '-' + str(uuid.uuid4()) + '.pending')
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o755)
    owned = os.fstat(fd)
    try:
        os.fchmod(fd, 0o755)
        offset = 0
        while offset < len(contents):
            count = os.write(fd, contents[offset:])
            assert count > 0
            offset += count
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        assert hashlib.sha256(read_checked(temporary)).hexdigest() == digest
        check_directories()
        try:
            os.link(temporary, target, follow_symlinks=False)
        except FileExistsError:
            pass
    finally:
        current = temporary.lstat()
        assert (current.st_dev, current.st_ino, current.st_uid) == (owned.st_dev, owned.st_ino, owned.st_uid)
        temporary.unlink()
        directory_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
check_directories()
assert hashlib.sha256(read_checked(target)).hexdigest() == digest
assert hashlib.sha256(read_checked(source)).hexdigest() == digest
assert source_before == policy.source_chain(source)
print(json.dumps({'sourcePath': str(source), 'path': str(target), 'sha256': digest, 'clientUID': uid, 'clientGID': os.getgid(),
    'sourceAndAncestorAttributesUnchanged': True,
    'sourceAttributeSnapshotSHA256': hashlib.sha256(json.dumps(source_before, sort_keys=True).encode()).hexdigest(),
    'cacheAncestorAttributesUnchanged': True}, sort_keys=True))
