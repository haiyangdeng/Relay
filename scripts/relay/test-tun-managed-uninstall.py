#!/usr/bin/python3
"""Exercise generated uninstall code on temporary files under the system Python.

Only root identities/ancestor permissions and pkgutil are simulated. File
contents, modes, links, inode checks, lock contention and removals are real.
No installed component, receipt or network setting is modified.
"""
import ast
import contextlib
import fcntl
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

BUILDER = Path(__file__).with_name("build-tun-managed-candidate.py")
TREE = ast.parse(BUILDER.read_text())
SOURCE = next(ast.literal_eval(n.value) for n in TREE.body
              if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "UNINSTALL" for t in n.targets))
OLD = "    for parent in [path.parent, *path.parents[1:]]:\n"
NEW = "    for parent in path.parents:\n"
sha = lambda b: hashlib.sha256(b).hexdigest()


class UninstallRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-uninstall-runtime-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / "TunManaged"
        self.root.mkdir(mode=0o755)
        self.source = SOURCE
        self.prepare_files()

    def prepare_files(self):
        contents = {
            "RelayTunClient": (b"fixed client fixture", 0o755),
            "busy.lock": (b"Relay core-managed TUN v1\n", 0o644),
            "uninstall.py": (self.source.encode(), 0o755),
            "Core/darwin-arm64/mihomo": (b"fixed arm fixture", 0o4755),
            "Core/darwin-x64/mihomo": (b"fixed x64 fixture", 0o4755),
        }
        for name, (data, mode) in contents.items():
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            p.chmod(mode)
        manifest = {"version": 1, "role": "core-managed-v1",
                    "client": {"sha256": sha(contents["RelayTunClient"][0])},
                    "cores": {"arm64": {"sha256": sha(contents["Core/darwin-arm64/mihomo"][0])},
                              "x86_64": {"sha256": sha(contents["Core/darwin-x64/mihomo"][0])}},
                    "uninstallerSHA256": sha(contents["uninstall.py"][0])}
        data = json.dumps(manifest).encode()
        (self.root / "installation.json").write_bytes(data)
        (self.root / "installation.json").chmod(0o644)
        self.manifest_sha = sha(data)

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes()
                for p in self.root.rglob("*") if p.is_file()}

    def execute(self, manifest_sha=None):
        namespace = {"__name__": "uninstall_runtime_fixture"}
        exec(compile(self.source, str(self.root / "uninstall.py"), "exec"), namespace)
        namespace["ROOT"] = self.root
        real_lstat, real_fstat = Path.lstat, os.fstat

        def metadata(info, outside=False):
            value = {name: getattr(info, name) for name in dir(info) if name.startswith("st_")}
            value.update(st_uid=0, st_gid=0)
            if outside:
                value["st_mode"] &= ~0o6022
            return SimpleNamespace(**value)

        def lstat(path):
            return metadata(real_lstat(path), path != self.root and self.root not in path.parents)

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(Path, "lstat", lstat))
            stack.enter_context(patch.object(os, "fstat", lambda fd: metadata(real_fstat(fd))))
            stack.enter_context(patch.object(os, "getuid", return_value=0))
            stack.enter_context(patch.object(os, "geteuid", return_value=0))
            stack.enter_context(patch.object(sys, "argv", [str(self.root / "uninstall.py"), "--remove", manifest_sha or self.manifest_sha]))
            forget = stack.enter_context(patch.object(namespace["subprocess"], "run"))
            output = io.StringIO()
            stack.enter_context(contextlib.redirect_stdout(output))
            try:
                namespace["main"]()
            except Exception:
                forget.assert_not_called()
                raise
            forget.assert_called_once_with(["/usr/sbin/pkgutil", "--forget", namespace['RECEIPT']], check=True, timeout=30)
            return json.loads(output.getvalue())

    def refusal(self, exception=RuntimeError, manifest_sha=None, reason=None):
        before = self.snapshot()
        assertion = self.assertRaisesRegex(exception, reason) if reason else self.assertRaises(exception)
        with assertion:
            self.execute(manifest_sha)
        self.assertEqual(self.snapshot(), before)

    @unittest.skipUnless(sys.version_info < (3, 10), "Legacy slicing fails on Python before 3.10")
    def test_original_python39_failure_before_any_removal(self):
        self.assertEqual(self.source.count(NEW), 1)
        self.source = self.source.replace(NEW, OLD, 1)
        self.prepare_files()
        self.refusal(TypeError)

    def test_complete_uninstall_removes_only_owned_fixture(self):
        outside = self.root.parent / "archive-retained.json"
        outside.write_text("original record")
        self.assertEqual(self.execute(), {"removed": True, "networkModified": False, "processesStopped": False})
        self.assertFalse(self.root.exists())
        self.assertEqual(outside.read_text(), "original record")

    def test_manifest_mismatch_preserves_every_file(self):
        self.refusal(manifest_sha="0" * 64, reason="Manifest identity mismatch")

    def test_changed_core_preserves_every_file(self):
        (self.root / "Core/darwin-arm64/mihomo").write_bytes(b"changed")
        (self.root / "Core/darwin-arm64/mihomo").chmod(0o4755)
        self.refusal(reason="Changed installed resource")

    def test_unknown_file_preserves_every_file(self):
        (self.root / "unexpected").write_text("preserve")
        self.refusal(reason="Unknown installation content")

    def test_busy_lifetime_lock_preserves_every_file(self):
        with (self.root / "busy.lock").open("rb") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            self.refusal(BlockingIOError)

    def test_wrong_core_mode_preserves_every_file(self):
        (self.root / "Core/darwin-arm64/mihomo").chmod(0o755)
        self.refusal(reason="Unsafe installation file")

    def test_writable_installation_directory_preserves_every_file(self):
        self.root.chmod(0o777)
        self.refusal(reason="Unsafe installation ancestor")

    def test_hardlinked_client_preserves_every_file(self):
        os.link(self.root / "RelayTunClient", self.root.parent / "external-client-link")
        self.refusal(reason="Unsafe installation file")


class ExecutionUninstallRuntimeTests(UninstallRuntimeTests):
    def prepare_files(self):
        if self.source == SOURCE:
            spec = importlib.util.spec_from_file_location('relay_managed_package_fixture', BUILDER)
            builder = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(builder)
            self.source = builder.uninstaller_for_profile('smart')
        ast.parse(self.source, feature_version=(3, 9))
        super().prepare_files()
        path = self.root / 'installation.json'
        manifest = json.loads(path.read_text())
        manifest.update(version=2, role='core-managed-v2', coreProfile='smart')
        data = json.dumps(manifest).encode()
        path.write_bytes(data)
        self.manifest_sha = sha(data)

    def test_legacy_role_cannot_be_removed_by_v2_uninstaller(self):
        path = self.root / 'installation.json'
        manifest = json.loads(path.read_text())
        manifest.update(version=1, role='core-managed-v1')
        data = json.dumps(manifest).encode()
        path.write_bytes(data)
        self.manifest_sha = sha(data)
        self.refusal(reason='Wrong role')


if __name__ == "__main__":
    unittest.main(verbosity=2)
