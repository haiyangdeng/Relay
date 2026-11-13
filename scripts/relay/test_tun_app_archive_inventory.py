"""Ordinary-UID private-file fixtures. Never invokes sudo or any live tool."""
import copy
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest

SOURCE = pathlib.Path(__file__).with_name("tun-app-archive-inventory.py")
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("inventory", SOURCE)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)
HASH = "a" * 64
ID = "11111111-1111-4111-8111-111111111111"


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-audit-inventory-")
        self.root = pathlib.Path(self.temporary.name).resolve() / "Recovery"
        self.root.mkdir(mode=0o700)
        self.plan = self.root / ID
        self.plan.mkdir(mode=0o700)
        self.binding = {"installationRevision": HASH, "clientUID": os.getuid(), "planID": ID,
                        "configurationSHA256": HASH, "runtimeConfigurationSHA256": HASH, "effectsSHA256": HASH,
                        "networkSHA256": HASH, "protectionSHA256": HASH, "createdAt": "1000", "expiresAt": "61000", "routeRemovalPolicy": "owned_device_retirement"}
        self.manifest = {"version": 1, "role": "terminal-tun-audit", "binding": self.binding, "sessionID": ID,
                         "evidenceSHA256": HASH, "acquisition": "none", "receipt": None, "networkTipSHA256": None,
                         "deviceTipSHA256": None, "terminalPhase": "unacquired"}
        self.write(self.plan / "retirement.json", self.manifest)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, path, value):
        path.write_bytes(inventory.canonical(value))
        path.chmod(0o600)

    def inspect(self):
        return inventory.inspect_archive(str(self.root), os.getuid())

    def aborted(self):
        self.manifest.update(acquisition="aborted", terminalPhase="acquisition_aborted")
        network = self.plan / "NetworkJournal"
        network.mkdir(mode=0o700)
        previous = None
        previous_snapshot = None
        for index, phase in enumerate(["create_intent", "acquisition_aborted"]):
            snapshot = {"version": 1, "role": "network-recovery-journal", "binding": self.binding, "sequence": index,
                        "phase": phase, "realizedEffects": None, "realizedEffectsSHA256": None, "pendingIDs": [],
                        "observation": None if index == 0 else {"networkSHA256": HASH, "protectionSHA256": HASH, "deviceAbsent": True}}
            value = {"version": 1, "role": "network-journal-record", "index": index,
                     "previousRecordSHA256": previous, "previousSnapshotSHA256": previous_snapshot, "snapshot": snapshot}
            self.write(network / ("%010d.record" % index), value)
            previous = inventory.digest(inventory.canonical(value))
            previous_snapshot = inventory.digest(inventory.canonical(snapshot))
        self.manifest["networkTipSHA256"] = previous
        self.write(self.plan / "retirement.json", self.manifest)

    def test_unacquired_inventory_is_complete_and_stable(self):
        result = self.inspect()
        self.assertTrue(result["exists"])
        self.assertEqual(result["plans"][0]["acquisition"], "none")
        self.assertEqual(result, self.inspect())

    def test_partial_acquire_positive_abort_without_device_is_allowed(self):
        self.aborted()
        self.assertEqual(self.inspect()["plans"][0]["phase"], "acquisition_aborted")

    def acquired(self):
        network = self.plan / "NetworkJournal"
        network.mkdir(mode=0o700)
        device = self.plan / "DeviceJournal"
        device.mkdir(mode=0o700)
        effects = {"device": {"id": ID}}
        previous, previous_snapshot = None, None
        for index, phase in enumerate(["create_intent", "acquired", "close_intent", "restored"]):
            snapshot = {"version": 1, "role": "network-recovery-journal", "binding": self.binding, "sequence": index,
                        "phase": phase, "realizedEffects": effects if index else None,
                        "realizedEffectsSHA256": inventory.digest(inventory.canonical(effects)) if index else None, "pendingIDs": [],
                        "observation": {"networkSHA256": HASH, "protectionSHA256": HASH, "deviceAbsent": True} if index == 3 else None}
            value = {"version": 1, "role": "network-journal-record", "index": index, "previousRecordSHA256": previous,
                     "previousSnapshotSHA256": previous_snapshot, "snapshot": snapshot}
            self.write(network / ("%010d.record" % index), value)
            previous, previous_snapshot = inventory.digest(inventory.canonical(value)), inventory.digest(inventory.canonical(snapshot))
        self.manifest.update(acquisition="acquired", terminalPhase="restored", networkTipSHA256=previous,
                             receipt={"version": 1, "planID": ID, "sessionID": ID, "deviceID": ID, "evidenceSHA256": HASH,
                                      "clientUID": os.getuid(), "installationRevision": HASH, "runtimeConfigurationSHA256": HASH,
                                      "interfaceName": "utun42", "interfaceIndex": 91, "controlID": 17, "controlUnit": 43,
                                      "socketDevice": "0", "socketInode": "18446744073709551615"})
        previous = None
        for index, (kind, phase, held) in enumerate([("create", "intent", False), ("create", "confirmed", True), ("close", "confirmed", False), ("verifyAbsent", "confirmed", False)]):
            record = {k: self.binding[k] for k in ["planID", "configurationSHA256", "runtimeConfigurationSHA256", "effectsSHA256", "createdAt", "expiresAt"]}
            record.update(version=1, role="tun-device-event", sequence=index,
                          event={"id": ID, "operation": {"kind": kind}, "phase": phase, "ownsHandle": held})
            value = {"version": 1, "role": "tun-device-journal-record", "previousRecordSHA256": previous, "record": record}
            previous = inventory.digest(inventory.canonical(value))
            self.write(device / ("%08d-%s.json" % (index, previous)), value)
        self.manifest["deviceTipSHA256"] = previous
        self.write(self.plan / "retirement.json", self.manifest)

    def test_acquired_terminal_requires_both_complete_chains_and_receipt(self):
        self.acquired()
        self.assertEqual(self.inspect()["plans"][0]["phase"], "restored")
        self.manifest["receipt"]["evidenceSHA256"] = "b" * 64
        self.write(self.plan / "retirement.json", self.manifest)
        with self.assertRaises(ValueError):
            self.inspect()

    def test_an_illegal_shortcut_to_terminal_is_rejected(self):
        self.acquired()
        self.assertFalse(inventory.follows({"phase": "create_intent", "pendingIDs": []}, {"phase": "restored", "pendingIDs": []}))
        last = self.plan / "DeviceJournal" / sorted(os.listdir(self.plan / "DeviceJournal"))[-1]
        last.unlink()
        with self.assertRaises(ValueError):
            self.inspect()

    def test_missing_chain_record_is_not_terminal(self):
        self.aborted()
        (self.plan / "NetworkJournal/0000000000.record").unlink()
        with self.assertRaises(ValueError):
            self.inspect()

    def test_hash_chain_and_false_absence_are_rejected(self):
        self.aborted()
        path = self.plan / "NetworkJournal/0000000001.record"
        record = json.loads(path.read_bytes())
        for field in ["previousRecordSHA256", "previousSnapshotSHA256"]:
            changed = copy.deepcopy(record)
            changed[field] = "b" * 64
            self.write(path, changed)
            with self.assertRaises(ValueError):
                self.inspect()
        changed = copy.deepcopy(record)
        changed["snapshot"]["observation"]["deviceAbsent"] = False
        self.write(path, changed)
        with self.assertRaises(ValueError):
            self.inspect()

    def test_duplicate_keys_unknown_content_and_permissions_preserved(self):
        path = self.plan / "retirement.json"
        path.write_bytes(b'{"version":1,"version":1}')
        with self.assertRaises(ValueError):
            self.inspect()
        self.write(path, self.manifest)
        unknown = self.plan / "unknown"
        self.write(unknown, {"keep": True})
        with self.assertRaises(ValueError):
            self.inspect()
        self.assertTrue(unknown.exists())
        unknown.unlink()
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.inspect()

    def test_symlink_and_incomplete_manifest_never_mean_empty(self):
        path = self.plan / "retirement.json"
        path.unlink()
        path.symlink_to(self.root / "missing")
        with self.assertRaises(OSError):
            self.inspect()
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.inspect()


if __name__ == "__main__":
    if os.getuid() == 0:
        raise SystemExit(77)
    unittest.main()
