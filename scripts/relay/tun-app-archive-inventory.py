"""Read-only terminal audit inventory. Production CLI has one fixed root path."""
import hashlib
import json
import os
import re
import stat
import sys

ROOT = "/Library/Application Support/RelayTunRecovery"
HEX = re.compile(r"[a-f0-9]{64}\Z")
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")


def require(value):
    if not value:
        raise ValueError("Retained archive is unknown, incomplete, changed or nonterminal")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def digest(value):
    return hashlib.sha256(value).hexdigest()


def identity(value):
    return (value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_mode,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def follows(previous, current):
    if previous is None:
        return current["phase"] == "create_intent" and current["sequence"] == 0
    p, c = previous["phase"], current["phase"]
    old, new = previous["pendingIDs"], current["pendingIDs"]
    if p == "create_intent":
        return c in ["acquired", "acquisition_aborted"] and new == []
    if previous["realizedEffects"] != current["realizedEffects"]:
        return False
    if c == "install_intent":
        return p in ["acquired", "installed"] and len(new) == len(old) + 1 and new[:-1] == old
    if c == "installed":
        return p == "install_intent" and new == old
    if c == "active":
        return p in ["acquired", "installed"] and new == old
    if c == "remove_intent":
        return p in ["install_intent", "installed", "active", "removed", "remove_intent"] and bool(new) and new == old
    if c == "removed":
        return (p == "removed" and new == old) or (p in ["install_intent", "installed", "active", "removed", "remove_intent", "retire_device_intent"] and bool(old) and new == old[:-1])
    if c == "close_intent":
        return p in ["acquired", "removed", "active", "close_intent"] and old == new == []
    if c in ["restored", "closed_external_change"]:
        return p == "close_intent" and new == []
    if c == "retire_device_intent":
        return p in ["install_intent", "installed", "active", "removed", "retire_device_intent"] and old == new
    return False


def inspect_archive(root, owner=0):
    """Only tests call this with an ordinary UID's newly created private root."""
    inventory = []
    total = 0

    def directory(path):
        before = os.lstat(path)
        require(stat.S_ISDIR(before.st_mode) and before.st_uid == owner
                and before.st_gid == (0 if owner == 0 else os.getgid())
                and stat.S_IMODE(before.st_mode) == 0o700)
        require(os.path.realpath(path) == path)
        return before

    def read(path, limit=270336):
        nonlocal total
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == owner
                    and before.st_gid == (0 if owner == 0 else os.getgid())
                    and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
                    and 0 < before.st_size <= limit)
            total += before.st_size
            require(total <= 256 * 1024 * 1024)
            data = b""
            while len(data) <= limit:
                part = os.read(fd, min(65536, limit + 1 - len(data)))
                if not part:
                    break
                data += part
            require(len(data) == before.st_size and identity(before) == identity(os.fstat(fd)) == identity(os.lstat(path)))
        finally:
            os.close(fd)
        value = json.loads(data.decode("utf-8"), object_pairs_hook=unique,
                           parse_constant=lambda _: require(False))
        require(canonical(value) == data)
        inventory.append({"path": os.path.relpath(path, root), "sha256": digest(data), "bytes": len(data)})
        return value, digest(data)

    try:
        initial = directory(root)
    except FileNotFoundError:
        return {"exists": False, "plans": [], "files": [], "revision": digest(canonical([]))}
    ids = sorted(os.listdir(root))
    require(len(ids) <= 4096)
    plans = []
    for plan_id in ids:
        require(UUID.fullmatch(plan_id))
        path = os.path.join(root, plan_id)
        directory(path)
        names = sorted(os.listdir(path))
        manifest, _ = read(path + "/retirement.json", 8192)
        require(set(manifest) == {"version", "role", "binding", "sessionID", "evidenceSHA256", "acquisition", "receipt", "networkTipSHA256", "deviceTipSHA256", "terminalPhase"})
        binding = manifest["binding"]
        require(manifest["version"] == 1 and manifest["role"] == "terminal-tun-audit"
                and isinstance(binding, dict) and binding.get("planID") == plan_id
                and UUID.fullmatch(manifest["sessionID"]) and HEX.fullmatch(manifest["evidenceSHA256"]))
        require(set(binding) == {"installationRevision", "clientUID", "planID", "configurationSHA256", "runtimeConfigurationSHA256", "effectsSHA256", "networkSHA256", "protectionSHA256", "createdAt", "expiresAt", "routeRemovalPolicy"})
        require(all(isinstance(binding[k], str) and HEX.fullmatch(binding[k]) for k in ["installationRevision", "configurationSHA256", "runtimeConfigurationSHA256", "effectsSHA256", "networkSHA256", "protectionSHA256"]))
        require(type(binding["clientUID"]) is int and 0 < binding["clientUID"] <= 0xffffffff
                and str(int(binding["createdAt"])) == binding["createdAt"]
                and str(int(binding["expiresAt"])) == binding["expiresAt"]
                and int(binding["expiresAt"]) == int(binding["createdAt"]) + 60000)
        phase, acquired = manifest["terminalPhase"], manifest["acquisition"]
        receipt = manifest["receipt"]
        if phase == "unacquired":
            require(names == ["retirement.json"] and acquired == "none" and receipt is None
                    and manifest["networkTipSHA256"] is None and manifest["deviceTipSHA256"] is None)
        else:
            require(phase in ["restored", "closed_external_change", "acquisition_aborted"])
            require((phase == "acquisition_aborted" and acquired == "aborted" and receipt is None)
                    or (phase != "acquisition_aborted" and acquired == "acquired" and isinstance(receipt, dict)))
            has_device = manifest["deviceTipSHA256"] is not None
            require(names == (["DeviceJournal", "NetworkJournal", "retirement.json"] if has_device else ["NetworkJournal", "retirement.json"]))
            require(has_device or phase == "acquisition_aborted")
            network_path = path + "/NetworkJournal"
            directory(network_path)
            records = sorted(os.listdir(network_path))
            require(0 < len(records) <= 800)
            previous, previous_snapshot, last = None, None, None
            for index, name in enumerate(records):
                require(name == "%010d.record" % index)
                record, record_hash = read(network_path + "/" + name)
                require(set(record) == {"version", "role", "index", "previousRecordSHA256", "previousSnapshotSHA256", "snapshot"}
                        and record["version"] == 1 and record["role"] == "network-journal-record"
                        and record["index"] == index and record["previousRecordSHA256"] == previous
                        and record["previousSnapshotSHA256"] == previous_snapshot)
                current = record["snapshot"]
                require(set(current) == {"version", "role", "binding", "sequence", "phase", "realizedEffects", "realizedEffectsSHA256", "pendingIDs", "observation"}
                        and current["version"] == 1 and current["role"] == "network-recovery-journal"
                        and current["binding"] == binding and current["sequence"] == index and follows(last, current))
                last = current
                require((last["realizedEffects"] is None and last["realizedEffectsSHA256"] is None)
                        or digest(canonical(last["realizedEffects"])) == last["realizedEffectsSHA256"])
                if index == 0:
                    require(last["phase"] == "create_intent" and last["realizedEffects"] is None and last["pendingIDs"] == [])
                previous, previous_snapshot = record_hash, digest(canonical(last))
            require(records == sorted(os.listdir(network_path)))
            require(previous == manifest["networkTipSHA256"] and last["phase"] == phase
                    and last["pendingIDs"] == [] and last["observation"]["deviceAbsent"] is True)
            if phase != "closed_external_change":
                require(last["observation"]["networkSHA256"] == binding["networkSHA256"]
                        and last["observation"]["protectionSHA256"] == binding["protectionSHA256"])
            if receipt is not None:
                require(set(receipt) == {"version", "installationRevision", "clientUID", "evidenceSHA256", "runtimeConfigurationSHA256", "planID", "sessionID", "deviceID", "interfaceName", "interfaceIndex", "controlID", "controlUnit", "socketDevice", "socketInode"}
                        and type(receipt["version"]) is int and receipt["version"] == 1 and receipt["planID"] == plan_id
                        and receipt["sessionID"] == manifest["sessionID"]
                        and receipt["evidenceSHA256"] == manifest["evidenceSHA256"]
                        and all(receipt[k] == binding[k] for k in ["clientUID", "installationRevision", "runtimeConfigurationSHA256"])
                        and last["realizedEffects"]["device"]["id"] == receipt["deviceID"])
                require(UUID.fullmatch(receipt["deviceID"]) and re.fullmatch(r"utun(?:0|[1-9][0-9]*)", receipt["interfaceName"])
                        and len(receipt["interfaceName"]) < 16 and int(receipt["interfaceName"][4:]) < 0xffffffff
                        and all(type(receipt[k]) is int and 0 < receipt[k] <= 0xffffffff for k in ["interfaceIndex", "controlID", "controlUnit"])
                        and receipt["controlUnit"] == int(receipt["interfaceName"][4:]) + 1
                        and all(isinstance(receipt[k], str) and str(int(receipt[k])) == receipt[k] and 0 <= int(receipt[k]) <= 0xffffffffffffffff for k in ["socketDevice", "socketInode"]))
            if has_device:
                device_path = path + "/DeviceJournal"
                directory(device_path)
                records = sorted(os.listdir(device_path))
                require(0 < len(records) <= 512)
                previous, device_id, event = None, receipt["deviceID"] if receipt else None, None
                for index, name in enumerate(records):
                    record, record_hash = read(device_path + "/" + name)
                    require(name == "%08d-%s.json" % (index, record_hash)
                            and set(record) == {"version", "role", "previousRecordSHA256", "record"}
                            and record["version"] == 1 and record["role"] == "tun-device-journal-record"
                            and record["previousRecordSHA256"] == previous)
                    value = record["record"]
                    require(value["version"] == 1 and value["role"] == "tun-device-event" and value["sequence"] == index
                            and all(value[k] == binding[k] for k in ["planID", "configurationSHA256", "runtimeConfigurationSHA256", "effectsSHA256", "createdAt", "expiresAt"]))
                    event = value["event"]
                    require(UUID.fullmatch(event["id"]) and (device_id is None or event["id"] == device_id))
                    if index == 0:
                        require(event["operation"]["kind"] == "create" and event["phase"] == "intent" and event["ownsHandle"] is False)
                    previous, device_id = record_hash, event["id"]
                require(records == sorted(os.listdir(device_path)))
                require(previous == manifest["deviceTipSHA256"] and event["operation"] == {"kind": "verifyAbsent"}
                        and event["phase"] == "confirmed" and event["ownsHandle"] is False)
        plans.append({"planID": plan_id, "sessionID": manifest["sessionID"], "clientUID": binding["clientUID"],
                      "installationRevision": binding["installationRevision"], "phase": phase, "acquisition": acquired})
        require(names == sorted(os.listdir(path)))
    require(ids == sorted(os.listdir(root)) and identity(initial) == identity(os.lstat(root)))
    inventory.sort(key=lambda value: value["path"])
    return {"exists": True, "plans": plans, "files": inventory, "revision": digest(canonical(inventory))}


if __name__ == "__main__":
    require(len(sys.argv) == 1 and os.getuid() == os.geteuid() == 0 and os.getgid() == os.getegid() == 0)
    print(json.dumps(inspect_archive(ROOT), sort_keys=True))
