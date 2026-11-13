#!/usr/bin/env python3
"""Inert package-policy tests; never build/install/run a package or privileged code."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("relay_tun_candidate", Path(__file__).with_name("build-tun-candidate.py"))
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class MetadataOutputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-inert-metadata-", dir="/private/tmp")
        self.root = Path(self.temporary.name).resolve()
        self.previous_app = BUILD.APP
        BUILD.APP = self.root / "app"
        (self.root / "evidence").mkdir(mode=0o700)

    def tearDown(self):
        BUILD.APP = self.previous_app
        self.temporary.cleanup()

    def test_default_metadata_path_remains_compatible(self):
        self.assertEqual(BUILD.metadata_output([]), (self.root / "evidence/tun-helper-transport-candidate.json", False))

    def test_new_explicit_metadata_preserves_default_evidence(self):
        original = self.root / "evidence/tun-helper-transport-candidate.json"
        original.write_text("approved original evidence")
        selected = self.root / "evidence/tun-helper-cache-candidate.json"
        self.assertEqual(BUILD.metadata_output(["--metadata-output", str(selected)]), (selected, True))
        self.assertEqual(original.read_text(), "approved original evidence")
        self.assertFalse(selected.exists())

    def test_existing_explicit_metadata_is_never_overwritten(self):
        selected = self.root / "evidence/existing.json"
        selected.write_text("keep")
        with self.assertRaises(RuntimeError):
            BUILD.metadata_output(["--metadata-output", str(selected)])
        self.assertEqual(selected.read_text(), "keep")

    def test_relative_outside_and_non_json_outputs_are_refused(self):
        for selected in ["relative.json", str(self.root / "outside.json"), str(self.root / "evidence/output.txt")]:
            with self.subTest(selected=selected), self.assertRaises(RuntimeError):
                BUILD.metadata_output(["--metadata-output", selected])

    def test_symlink_output_is_refused(self):
        selected = self.root / "evidence/link.json"
        selected.symlink_to(self.root / "missing")
        with self.assertRaises(RuntimeError):
            BUILD.metadata_output(["--metadata-output", str(selected)])


class CopyPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-inert-package-policy-", dir="/private/tmp")
        self.root = Path(self.temporary.name).resolve()
        self.previous_app = BUILD.APP
        BUILD.APP = self.root
        BUILD.SOURCE_COPY_EVIDENCE.clear()
        self.source = self.root / "source" / "inert-bytes"
        self.source.parent.mkdir(mode=0o700)
        self.source.write_bytes(b"inert copy fixture; never executable code")
        self.source.chmod(0o755)
        self.destination = self.root / "staging" / "copy"

    def tearDown(self):
        BUILD.APP = self.previous_app
        self.temporary.cleanup()

    def attribute_tool(self, bad_path=None, bad_name=None):
        def run(args):
            if args[:2] == ["/usr/bin/xattr", "-px"]:
                return subprocess.CompletedProcess(args, 0, stdout="01 02\n", stderr="")
            name = bad_name if args[-1] == str(bad_path) else "com.apple.provenance"
            return subprocess.CompletedProcess(args, 0, stdout=name + "\n", stderr="")
        return run

    def test_ordinary_copy_preserves_source_bytes_and_ancestor_attributes(self):
        before = self.source.read_bytes()
        with patch.object(BUILD, "run", self.attribute_tool()):
            BUILD.copy_source(self.source, self.destination, 0o755)
        self.assertEqual(self.destination.read_bytes(), before)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertTrue(BUILD.SOURCE_COPY_EVIDENCE[0]["sourceAndAncestorAttributesUnchanged"])

    def test_source_quarantine_is_rejected_before_destination_creation(self):
        with patch.object(BUILD, "run", self.attribute_tool(self.source, "com.apple.quarantine")):
            with self.assertRaises(RuntimeError):
                BUILD.copy_source(self.source, self.destination, 0o755)
        self.assertFalse(self.destination.exists())

    def test_existing_source_ancestor_access_metadata_is_preserved_and_pinned(self):
        with patch.object(BUILD, "run", self.attribute_tool(self.root, "com.apple.macl")):
            BUILD.copy_source(self.source, self.destination, 0o755)
        proof = BUILD.SOURCE_COPY_EVIDENCE[0]
        self.assertEqual(proof["onlyAttributeNames"], ["com.apple.macl", "com.apple.provenance"])
        self.assertEqual(proof["binaryAttributeNames"], ["com.apple.provenance"])
        self.assertTrue(proof["sourceAttributesNeverModifiedOrCopied"])

    def test_access_metadata_on_binary_or_staging_is_still_refused(self):
        with patch.object(BUILD, "run", self.attribute_tool(self.source, "com.apple.macl")):
            with self.assertRaises(RuntimeError):
                BUILD.copy_source(self.source, self.destination, 0o755)
        self.assertFalse(self.destination.exists())
        with patch.object(BUILD, "run", self.attribute_tool(self.destination, "com.apple.macl")):
            with self.assertRaises(RuntimeError):
                BUILD.attributes(self.destination)

    def test_unknown_parent_attribute_is_rejected_without_sanitizing_the_source(self):
        before = self.source.read_bytes()
        with patch.object(BUILD, "run", self.attribute_tool(self.source.parent, "unknown.attribute")):
            with self.assertRaises(RuntimeError):
                BUILD.copy_source(self.source, self.destination, 0o755)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertFalse(self.destination.exists())

    def test_changed_ancestor_attributes_invalidate_the_completed_copy(self):
        with patch.object(BUILD, "source_chain", side_effect=[{"trusted": "before"}, {"trusted": "after"}]):
            with self.assertRaises(RuntimeError):
                BUILD.copy_source(self.source, self.destination, 0o755)
        self.assertEqual(BUILD.SOURCE_COPY_EVIDENCE, [])

    def test_existing_staging_content_is_never_overwritten(self):
        self.destination.parent.mkdir(mode=0o700)
        self.destination.write_text("keep unknown staging content")
        with patch.object(BUILD, "run", self.attribute_tool()):
            with self.assertRaises(RuntimeError):
                BUILD.copy_source(self.source, self.destination, 0o755)
        self.assertEqual(self.destination.read_text(), "keep unknown staging content")


class ReceiptGateTests(unittest.TestCase):
    def run_gate(self, inventory, status=0):
        source = (Path(__file__).resolve().parents[2] / "native/tun/package/preinstall").read_text()
        gate = source.split("# receipt-gate-begin:", 1)[1].split("\n", 1)[1].split("# receipt-gate-end", 1)[0]
        self.assertEqual(gate.count("/usr/sbin/pkgutil --pkgs"), 1)
        self.assertNotIn("--pkgs=", gate)
        # Execute only the extracted receipt branch with injected bytes/status.
        # No root gate, system query, package, filesystem mutation or Mach call.
        fixture = """set -eu
fail() { echo "$stage" >&2; exit 1; }
fixture_receipts() { printf '%s' "$RELAY_TEST_RECEIPTS"; return "$RELAY_TEST_STATUS"; }
"""
        return subprocess.run(
            ["/bin/sh", "-c", fixture + gate.replace("/usr/sbin/pkgutil --pkgs", "fixture_receipts")],
            capture_output=True, text=True, timeout=5,
            env={"PATH": "/usr/bin:/bin", "RELAY_TEST_RECEIPTS": inventory, "RELAY_TEST_STATUS": str(status)},
        )

    def test_successful_empty_inventory_allows_original_absence(self):
        self.assertEqual(self.run_gate("").returncode, 0)

    def test_successful_unrelated_inventory_allows_original_absence(self):
        self.assertEqual(self.run_gate("com.apple.fixture\nlocal.other.package\n").returncode, 0)

    def test_exact_existing_receipt_is_rejected_among_other_ids(self):
        result = self.run_gate("com.apple.fixture\nlocal.relay.network.tun.network-executor-v1\nlocal.other.package\n")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "receipt-absence")

    def test_old_authentication_receipt_requires_explicit_migration(self):
        self.assertEqual(self.run_gate("local.relay.network.tun.feasibility\n").returncode, 1)

    def test_similar_ids_are_not_the_fixed_receipt(self):
        self.assertEqual(self.run_gate("local.relay.network.tun.network-executor-v1.extra\nxlocal.relay.network.tun.network-executor-v1\nlocalXrelayXnetworkXtunXfeasibility\n").returncode, 0)

    def test_failed_inventory_is_not_mistaken_for_absence(self):
        result = self.run_gate("", status=1)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "receipt-query")

    def test_failed_inventory_remains_rejected_with_partial_output(self):
        result = self.run_gate("com.apple.fixture\n", status=2)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.strip(), "receipt-query")


if __name__ == "__main__":
    unittest.main()
