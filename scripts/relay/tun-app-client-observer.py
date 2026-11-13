#!/usr/bin/env python3
"""This run's ordinary-UID, read-only stage/process observer. Never signals a process.

The acceptance controller calls snapshot/watch as the ordinary desktop user.
Managed mode also supports an App opened normally by LaunchServices.
--self-test observes two inert Python grandchildren, with no App/core/network.
"""
import argparse
import ctypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import re

NOTE_EXITSTATUS = 0x04000000  # Current SDK sys/event.h, absent from Python select.
APP = Path(__file__).resolve().parents[2]
FIXED_CLIENT = "/Library/Application Support/Relay/Tun/RelayTunClient"
MANIFEST = "/Library/Application Support/Relay/Tun/installation.json"
STAGE_PREFIX = "/private/tmp/relay-tun-main-"


def require(value):
    if not value:
        raise RuntimeError("Acceptance stage/process observation was not verified.")


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def plain(path):
    path = str(path)
    require(path.startswith("/") and os.path.realpath(path) == path)
    current = Path(path)
    while str(current) != "/":
        require(not stat.S_ISLNK(os.lstat(current).st_mode))
        current = current.parent


def read(path, limit, owner=None, mode=0o600):
    plain(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit)
        require(before.st_uid == (os.getuid() if owner is None else owner))
        if mode is not None:
            require(stat.S_IMODE(before.st_mode) == mode)
        blocks, length = [], 0
        while True:
            block = os.read(descriptor, 65536)
            if not block:
                break
            length += len(block)
            require(length <= limit)
            blocks.append(block)
        after, linked = os.fstat(descriptor), os.lstat(path)
        keys = ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_nlink", "st_mtime_ns", "st_ctime_ns")
        require(all(getattr(before, key) == getattr(item, key) for item in (after, linked) for key in keys))
        data = b"".join(blocks)
        return data, {"sha256": sha(data), "dev": before.st_dev, "ino": before.st_ino, "size": before.st_size}
    finally:
        os.close(descriptor)


def save(path, value):
    path = Path(path)
    require(path.is_absolute())
    plain(path.parent)
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n"
        offset = 0
        while offset < len(data):
            offset += os.write(descriptor, data[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def stage_snapshot():
    directories = []
    for entry in sorted(Path("/private/tmp").glob("relay-tun-main-*")):
        info = os.lstat(entry)
        if info.st_uid != os.getuid():
            continue
        plain(entry)
        require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700)
        files = {}
        for name, limit in (("source.json", 2 * 1024 * 1024), ("bundle.json", 3 * 1024 * 1024), ("config.json", 2 * 1024 * 1024)):
            _, files[name] = read(entry / name, limit)
        directories.append({"path": str(entry), "dev": info.st_dev, "ino": info.st_ino,
                            "uid": info.st_uid, "files": files, "hasRecovery": (entry / "recovery.json").exists()})
    return {"version": 1, "role": "tun-acceptance-stage-snapshot", "uid": os.getuid(),
            "observedAt": timestamp(), "directories": directories}


class BSDInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ("flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")]
    _fields_ += [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid")]
    _fields_ += [("nice", ctypes.c_int32), ("startSeconds", ctypes.c_uint64), ("startMicroseconds", ctypes.c_uint64)]


def proc(pid):
    require(0 < pid <= 0x7fffffff and ctypes.sizeof(BSDInfo) == 136)
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    value, path = BSDInfo(), ctypes.create_string_buffer(4096)
    require(library.proc_pidinfo(pid, 3, 0, ctypes.byref(value), ctypes.sizeof(value)) == ctypes.sizeof(value))
    require(library.proc_pidpath(pid, path, len(path)) > 0)
    require(value.pid == pid and value.uid == os.getuid() and value.ruid == os.getuid())
    return {"pid": pid, "ppid": value.ppid, "uid": value.uid, "path": os.fsdecode(path.value),
            "birth": [value.startSeconds, value.startMicroseconds]}


def clients(app_pid, executable=FIXED_CLIENT, argument="--tun-session"):
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    count = library.proc_listallpids(None, 0)
    require(0 < count < 100000)
    buffer = (ctypes.c_int * (count + 128))()
    count = library.proc_listallpids(buffer, ctypes.sizeof(buffer))
    require(0 < count <= len(buffer))
    found = []
    for pid in buffer[:count]:
        if pid <= 0:
            continue
        try:
            info = proc(pid)
        except RuntimeError:
            continue
        if info["ppid"] == app_pid and info["path"] == executable:
            command = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "args="], check=True,
                                     capture_output=True, text=True, timeout=5).stdout.strip()
            require(command == executable + " " + argument)
            found.append(info)
    require(len(found) == 1)
    return found[0]


def register(info):
    queue = select.kqueue()
    event = select.kevent(info["pid"], filter=select.KQ_FILTER_PROC,
                          flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                          fflags=select.KQ_NOTE_EXIT | NOTE_EXITSTATUS)
    queue.control([event], 0, 0)
    require(proc(info["pid"]) == info and not queue.control(None, 1, 0))
    return queue


def wait_exit(queue, pid, seconds=90):
    events = queue.control(None, 1, seconds)
    if not events:
        raise TimeoutError("Process exit was not observed before the deadline.")
    require(len(events) == 1)
    event = events[0]
    require(event.ident == pid and event.filter == select.KQ_FILTER_PROC)
    require(not (event.flags & select.KQ_EV_ERROR) and event.fflags & select.KQ_NOTE_EXIT and event.fflags & NOTE_EXITSTATUS)
    return os.waitstatus_to_exitcode(event.data & 0xffff)


def save_observation_failure(out, binding, phase, app_exit, client_exit, error):
    record = {"version": 1, "role": "managed-app-client-observation-failure",
              "failedAt": timestamp(), "phase": phase,
              "reason": "exit-timeout" if isinstance(error, TimeoutError) else "verification-rejected",
              "binding": binding, "appExitCode": app_exit, "clientExitCode": client_exit,
              "passed": False, "signalsSentByObserver": False}
    save(out + ".failure.json", record)
    return record


def watch(args):
    metadata_path = Path(os.path.abspath(args.app_candidate))
    require(os.lstat(metadata_path).st_mode & 0o022 == 0)
    metadata_bytes, _ = read(metadata_path, 65536, mode=None)
    metadata = json.loads(metadata_bytes)
    require(metadata.get("version") == 1 and metadata.get("role") == "connected-tun-app-candidate")
    binary = str(Path(metadata["path"]) / "Contents/MacOS/Relay")
    binary_bytes, _ = read(binary, 2 * 1024 * 1024, mode=None)
    binary_key = str(Path(binary).relative_to(APP.parent))
    require(sha(binary_bytes) == metadata["outputs"][binary_key])
    app = proc(args.app_pid)
    require(app["path"] == binary)
    manifest_bytes, _ = read(MANIFEST, 16384, owner=0, mode=0o644)
    manifest = json.loads(manifest_bytes)
    require(manifest["version"] == 2 and manifest["role"] == "network-executor-v1" and manifest["clientUID"] == os.getuid())
    client_bytes, _ = read(FIXED_CLIENT, 16 * 1024 * 1024, owner=0, mode=0o755)
    require(sha(client_bytes) == manifest["client"]["sha256"])
    client = clients(args.app_pid)
    before = json.loads(read(args.before, 1024 * 1024)[0])
    require(before["role"] == "tun-acceptance-stage-snapshot" and before["uid"] == os.getuid())
    snapshot = stage_snapshot()
    previous = {(entry["path"], entry["dev"], entry["ino"]) for entry in before["directories"]}
    new = [entry for entry in snapshot["directories"] if (entry["path"], entry["dev"], entry["ino"]) not in previous]
    require(len(new) == 1 and not new[0]["hasRecovery"])
    stage = new[0]
    source = json.loads(read(Path(stage["path"]) / "source.json", 2 * 1024 * 1024)[0])
    fixture = json.loads(read(args.fixture, 65536)[0])
    require(source == fixture)
    runtime = json.loads(read(Path(stage["path"]) / "config.json", 2 * 1024 * 1024)[0])
    expected = dict(source)
    expected["tun"] = {**source["tun"], "file-descriptor": 3}
    require(runtime == expected)
    import uuid
    require(str(uuid.UUID(args.session_id)) == args.session_id)
    queue = register(client)
    try:
        binding = {"version": 1, "role": "registered-tun-client-exit-observer", "registeredAt": timestamp(),
                   "sessionId": args.session_id, "app": app, "client": client, "stage": stage,
                   "appCandidateMetadata": str(metadata_path), "appCandidateMetadataSHA256": sha(metadata_bytes),
                   "manifestSHA256": sha(manifest_bytes), "clientSHA256": sha(client_bytes),
                   "appBinarySHA256": sha(binary_bytes),
                   "candidateArchiveSHA256": metadata["archive"]["sha256"], "fixtureSHA256": sha(read(args.fixture, 65536)[0])}
        save(args.out + ".binding.json", binding)
        require(proc(args.app_pid) == app and proc(client["pid"]) == client and not queue.control(None, 1, 0))
        print(json.dumps({"phase": "registered", "binding": args.out + ".binding.json", "clientPID": client["pid"]}), flush=True)
        code = wait_exit(queue, client["pid"])
        result = {**binding, "phase": "exit-observed", "observedAt": timestamp(), "exitCode": code,
                  "kernelExitEvent": True, "exitStatusPresent": True, "passed": code == 0}
        save(args.out, result)
        print(json.dumps({"phase": "exit-observed", "exitCode": code, "passed": code == 0}), flush=True)
        require(code == 0)
    finally:
        queue.close()


def validate_managed_recovery(raw, runtime_sha, device, baseline, session_id, evidence_sha):
    import uuid
    require(set(raw) == {"version", "status", "sessionId", "evidenceSHA256",
                        "runtimeConfigurationSHA256", "baseline", "ownedRecoveryRetained"})
    require(raw["version"] == 1 and raw["status"] == "restored" and raw["ownedRecoveryRetained"] is False)
    require(str(uuid.UUID(raw["sessionId"])) == raw["sessionId"])
    require(re.fullmatch(r"[a-f0-9]{64}", raw["evidenceSHA256"]) is not None)
    require(raw["sessionId"] == session_id and raw["evidenceSHA256"] == evidence_sha)
    require(raw["runtimeConfigurationSHA256"] == runtime_sha and raw["baseline"] == baseline)
    require(device == "utun" + str(10000 + int(raw["evidenceSHA256"][:8], 16) % 22768))


def watch_managed(args):
    # The App may be launched normally by LaunchServices. Bind its actual live
    # identity, then observe kernel exit events; this tool never sends a signal.
    delivery = json.loads(read(args.app_candidate, 131072, mode=None)[0])
    require(delivery.get("version") == 1 and delivery.get("batch") == 30)
    binary = str(Path(delivery["app"]) / "Contents/MacOS/Relay")
    app_bytes, _ = read(binary, 2 * 1024 * 1024, mode=None)
    archive = Path(delivery["app"]) / "Contents/Resources/app.asar"
    require(sha(app_bytes) == delivery["appExecutableSHA256"])
    require(sha(read(archive, 256 * 1024 * 1024, mode=None)[0]) == delivery["appAsarSHA256"])
    app = proc(args.app_pid)
    require(app["path"] == binary)
    root = Path("/Library/Application Support/Relay/TunManaged")
    manifest_bytes = read(root / "installation.json", 16384, owner=0, mode=0o644)[0]
    manifest = json.loads(manifest_bytes)
    require(sha(manifest_bytes) == delivery["manifestSHA256"])
    require(manifest.get("version") == 1 and manifest.get("role") == "core-managed-v1" and manifest.get("clientUID") == os.getuid())
    executable = str(root / "RelayTunClient")
    require(sha(read(executable, 16 * 1024 * 1024, owner=0, mode=0o755)[0]) == manifest["client"]["sha256"])
    client = clients(args.app_pid, executable, "--managed-session")
    import uuid
    require(str(uuid.UUID(args.session_id)) == args.session_id)
    require(re.fullmatch(r"[a-f0-9]{64}", args.evidence_sha256) is not None)
    before = json.loads(read(args.before, 1024 * 1024)[0])
    require(before.get("role") == "tun-acceptance-stage-snapshot" and before.get("uid") == os.getuid())
    previous = {(entry["path"], entry["dev"], entry["ino"]) for entry in before["directories"]}
    new = [entry for entry in stage_snapshot()["directories"] if (entry["path"], entry["dev"], entry["ino"]) not in previous]
    require(len(new) == 1 and not new[0]["hasRecovery"])
    stage = new[0]
    require(re.fullmatch(r"[a-f0-9]{64}", args.source_sha256) is not None)
    require(stage["files"]["source.json"]["sha256"] == args.source_sha256)
    source = json.loads(read(Path(stage["path"]) / "source.json", 2 * 1024 * 1024)[0])
    runtime = json.loads(read(Path(stage["path"]) / "config.json", 2 * 1024 * 1024)[0])
    device = runtime["tun"]["device"]
    require(source["tun"]["device"] == "utun" and re.fullmatch(r"utun[0-9]+", device) is not None)
    require(device == "utun" + str(10000 + int(args.evidence_sha256[:8], 16) % 22768))
    expected = dict(source)
    expected["tun"] = {**source["tun"], "device": device}
    expected["tun"].pop("file-descriptor", None)
    require(runtime == expected and runtime["dns"]["enable"] is False)
    baseline = json.loads(read(args.baseline, 131072)[0])["baseline"]
    require(set(baseline) == {"networkSHA256", "protectionSHA256"} and all(re.fullmatch(r"[a-f0-9]{64}", v) for v in baseline.values()))
    app_queue, client_queue = register(app), None
    binding, app_exit, client_exit = None, None, None
    phase = "client-registration"
    try:
        client_queue = register(client)
        binding = {"version": 1, "role": "registered-managed-app-client-exit-observer",
                   "registeredAt": timestamp(), "app": app, "client": client, "stage": stage,
                   "baseline": baseline, "appAsarSHA256": delivery["appAsarSHA256"],
                   "manifestSHA256": sha(manifest_bytes), "sourceSHA256": args.source_sha256,
                   "sessionId": args.session_id, "evidenceSHA256": args.evidence_sha256}
        save(args.out + ".binding.json", binding)
        require(proc(app["pid"]) == app and proc(client["pid"]) == client)
        require(not app_queue.control(None, 1, 0) and not client_queue.control(None, 1, 0))
        print(json.dumps({"phase": "registered", "appPID": app["pid"], "clientPID": client["pid"],
                          "appExitWaitSeconds": 90, "binding": args.out + ".binding.json"}), flush=True)
        phase = "app-exit-wait"
        app_exit = wait_exit(app_queue, app["pid"])
        phase = "app-exit-code"
        require(app_exit == -9)
        phase = "client-exit-wait"
        client_exit = wait_exit(client_queue, client["pid"])
        phase = "client-exit-code"
        require(client_exit == 0)
        phase = "recovery-record"
        info = os.lstat(stage["path"])
        require((info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)) == (stage["dev"], stage["ino"], os.getuid(), 0o700))
        recovery_bytes, recovery_info = read(Path(stage["path"]) / "recovery.json", 16384)
        recovery = json.loads(recovery_bytes)
        validate_managed_recovery(recovery, stage["files"]["config.json"]["sha256"], device, baseline,
                                  args.session_id, args.evidence_sha256)
        phase = "independent-baseline"
        inspection = subprocess.run([executable, "--managed-inspect"], capture_output=True, text=True, timeout=30, check=True)
        require(not inspection.stderr.strip())
        observed = json.loads(inspection.stdout)
        require(observed["baseline"] == baseline and observed["network"]["existingTunnel"] == "none")
        phase = "result-write"
        save(args.out, {**binding, "phase": "exit-and-recovery-observed", "appExitCode": app_exit,
                       "clientExitCode": client_exit, "recovery": recovery, "recoveryFile": recovery_info,
                       "baselineRestored": True, "passed": True, "signalsSentByObserver": False})
    except Exception as error:
        try:
            save_observation_failure(args.out, binding, phase, app_exit, client_exit, error)
        except Exception:
            print(json.dumps({"phase": phase, "passed": False, "failureRecordSaved": False}), file=sys.stderr, flush=True)
        else:
            print(json.dumps({"phase": phase, "passed": False, "failureRecordSaved": True,
                              "failure": args.out + ".failure.json"}), file=sys.stderr, flush=True)
        raise
    finally:
        app_queue.close()
        if client_queue is not None: client_queue.close()
    # A closed notification pipe must not contradict the persisted result.
    try:
        print(json.dumps({"phase": "exit-and-recovery-observed", "passed": True}), flush=True)
    except BrokenPipeError:
        pass


def self_test():
    rows = []
    for desired in (0, 7):
        parent = subprocess.Popen([sys.executable, __file__, "--inert-parent", str(desired)],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            pid = int(parent.stdout.readline())
            info = proc(pid)
            require(info["ppid"] == parent.pid and info["uid"] == os.getuid())
            queue = register(info)
            try:
                try: wait_exit(queue, pid, 0)
                except TimeoutError: pass
                else: raise RuntimeError("Gated inert child unexpectedly exited")
                parent.stdin.write(b"x"); parent.stdin.flush(); parent.stdin.close()
                code = wait_exit(queue, pid, 5)
                require(parent.wait(timeout=5) == 0 and code == desired)
                rows.append({"expectedExitCode": desired, "actualExitCode": code, "passed": True,
                             "sameUIDNonChild": True, "registeredBeforeExit": True})
            finally:
                queue.close()
        finally:
            if parent.stdin and not parent.stdin.closed:
                parent.stdin.close()  # EOF releases this inert fixture's gate.
            if parent.poll() is None:
                parent.wait(timeout=7)
    baseline = {"networkSHA256": "a" * 64, "protectionSHA256": "b" * 64}
    receipt = {"version": 1, "status": "restored", "sessionId": "11111111-1111-4111-8111-111111111111",
               "evidenceSHA256": "0" * 64, "runtimeConfigurationSHA256": "c" * 64,
               "baseline": baseline, "ownedRecoveryRetained": False}
    validate_managed_recovery(receipt, "c" * 64, "utun10000", baseline, receipt["sessionId"], "0" * 64)
    bounded = {**receipt, "evidenceSHA256": "b" * 64}
    validate_managed_recovery(bounded, "c" * 64, "utun18635", baseline, receipt["sessionId"], "b" * 64)
    try: validate_managed_recovery(bounded, "c" * 64, "utun652683", baseline, receipt["sessionId"], "b" * 64)
    except RuntimeError: pass
    else: raise RuntimeError("Old out-of-range device binding was accepted")
    for key, bad in [("runtimeConfigurationSHA256", "d" * 64), ("ownedRecoveryRetained", True),
                     ("status", "uncertain"), ("evidenceSHA256", "1" * 64),
                     ("sessionId", "22222222-2222-4222-8222-222222222222"),
                     ("evidenceSHA256", "0" * 63 + "1"),
                     ("baseline", {**baseline, "networkSHA256": "d" * 64})]:
        try: validate_managed_recovery({**receipt, key: bad}, "c" * 64, "utun10000", baseline, receipt["sessionId"], "0" * 64)
        except RuntimeError: pass
        else: raise RuntimeError("Mismatched recovery was accepted")
    import tempfile
    with tempfile.TemporaryDirectory(prefix="relay-observer-offline-") as temporary:
        out = str(Path(temporary).resolve() / "result.json")
        failure = save_observation_failure(out, {"fixture": True}, "client-exit-wait", -9, None, TimeoutError())
        require(failure == json.loads(read(out + ".failure.json", 16384)[0]))
        require(failure["reason"] == "exit-timeout" and failure["appExitCode"] == -9
                and failure["clientExitCode"] is None and not failure["passed"] and not Path(out).exists())
        try: save_observation_failure(out, {}, "app-exit-code", 0, None, RuntimeError())
        except FileExistsError: pass
        else: raise RuntimeError("Existing failure evidence was overwritten")
        require(json.loads(read(out + ".failure.json", 16384)[0]) == failure)
        rejected = save_observation_failure(out + "-rejected", {}, "app-exit-code", 0, None, RuntimeError())
        require(rejected["reason"] == "verification-rejected" and rejected["appExitCode"] == 0
                and rejected["clientExitCode"] is None and not rejected["passed"])
    print(json.dumps({"version": 1, "rows": rows, "passed": True, "actualAppLaunched": False,
                      "timeoutDoesNotConsumeLaterExit": True, "failureEvidencePreserved": True,
                      "actualCoreLaunched": False, "systemConfigurationChanged": False}))


def main():
    require(sys.platform == "darwin" and os.getuid() > 0 and os.getuid() == os.geteuid())
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--inert-parent", choices=["0", "7"])
    mode.add_argument("--snapshot-stages", action="store_true")
    mode.add_argument("--watch-client", action="store_true")
    mode.add_argument("--watch-managed-client", action="store_true")
    parser.add_argument("--out")
    parser.add_argument("--app-pid", type=int)
    parser.add_argument("--before")
    parser.add_argument("--session-id")
    parser.add_argument("--fixture")
    parser.add_argument("--source-sha256")
    parser.add_argument("--evidence-sha256")
    parser.add_argument("--baseline")
    parser.add_argument("--app-candidate", help="Explicit App metadata for this run; required by --watch-client.")
    args = parser.parse_args()
    if args.inert_parent is not None:
        child = subprocess.Popen([sys.executable, "-c", "import sys;sys.stdin.buffer.read(1);sys.exit(" + args.inert_parent + ")"], stdin=subprocess.PIPE)
        print(child.pid, flush=True)
        sys.stdin.buffer.read(1)
        child.stdin.write(b"x"); child.stdin.close(); child.wait(timeout=5)
    elif args.self_test:
        require(all(value is None for value in (args.out, args.app_pid, args.before, args.session_id, args.fixture, args.app_candidate, args.source_sha256, args.evidence_sha256, args.baseline)))
        self_test()
    elif args.snapshot_stages:
        require(args.out and all(value is None for value in (args.app_pid, args.before, args.session_id, args.fixture, args.app_candidate, args.source_sha256, args.evidence_sha256, args.baseline)))
        snapshot = stage_snapshot(); save(args.out, snapshot)
        print(json.dumps({"phase": "snapshot", "path": args.out, "count": len(snapshot["directories"])}))
    elif args.watch_managed_client:
        require(args.out and args.app_pid and args.before and args.app_candidate and args.source_sha256 and args.baseline and args.session_id and args.evidence_sha256 and not args.fixture)
        watch_managed(args)
    else:
        require(args.out and args.app_pid and args.before and args.session_id and args.fixture and args.app_candidate)
        require(not args.source_sha256 and not args.evidence_sha256 and not args.baseline)
        watch(args)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Acceptance process observation unverified; no signals or system changes were performed.", file=sys.stderr)
        sys.exit(1)
