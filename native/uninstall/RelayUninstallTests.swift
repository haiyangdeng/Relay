import Foundation
import Darwin

enum RelayUninstallTests {
    static func run() throws {
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
            guard condition() else { throw RelayRemoval.fail("Fixture failed: " + message) }; count += 1
        }
        let home = "/Users/fixture"
        try check(RelayRemoval.trashPath(home + "/.Trash/Relay.app", home: home, uid: 501), "home Trash")
        try check(RelayRemoval.trashPath("/Volumes/Data/.Trashes/501/Relay.app", home: home, uid: 501), "volume Trash")
        try check(!RelayRemoval.trashPath("/Users/other/.Trash/Relay.app", home: home, uid: 501), "other user")
        try check(!RelayRemoval.trashPath(home + "/.Trash-copy/Relay.app", home: home, uid: 501), "prefix collision")
        try check(!RelayRemoval.trashPath(home + "/.Trash/../Applications/Relay.app", home: home, uid: 501), "normalized path")
        try check(!RelayRemoval.trashPath("/Volumes/Data/.Trashes/502/Relay.app", home: home, uid: 501), "volume UID")
        try check(!RelayRemoval.removalFact(currentPath: nil, links: 1, originalOccupied: false, home: home, uid: 501), "missing path is not deletion")
        try check(!RelayRemoval.removalFact(currentPath: home + "/Documents/Relay.app", links: 1, originalOccupied: false, home: home, uid: 501), "ordinary move")
        try check(!RelayRemoval.removalFact(currentPath: home + "/.Trash/Relay.app", links: 1, originalOccupied: true, home: home, uid: 501), "replacement blocks old cleanup")
        try check(RelayRemoval.removalFact(currentPath: nil, links: 0, originalOccupied: false, home: home, uid: 501), "same held vnode deleted")
        guard let temporary = realpath(FileManager.default.temporaryDirectory.path, nil) else { throw RelayRemoval.fail("Fixture temporary path unavailable") }
        let root = URL(fileURLWithPath: String(cString: temporary)).appendingPathComponent("RelayTrashFixture-" + UUID().uuidString)
        free(temporary)
        defer { try? FileManager.default.removeItem(at: root) }
        let installed = root.appendingPathComponent("Applications/Relay.app")
        let moved = root.appendingPathComponent("Documents/Relay.app")
        let trashed = root.appendingPathComponent(".Trash/Relay.app")
        for directory in [installed, moved.deletingLastPathComponent(), trashed.deletingLastPathComponent()] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        let fd = open(installed.path, O_EVTONLY | O_NOFOLLOW | O_DIRECTORY)
        guard fd >= 0 else { throw RelayRemoval.fail("Fixture FD unavailable") }; defer { close(fd) }
        var before = stat(); _ = fstat(fd, &before)
        let bookmark = try installed.bookmarkData(options: [.minimalBookmark], includingResourceValuesForKeys: nil, relativeTo: nil)
        try FileManager.default.moveItem(at: installed, to: moved)
        try check(RelayRemoval.trackedPath(fd) == moved.path, "FD follows ordinary rename")
        try FileManager.default.moveItem(at: moved, to: trashed)
        try check(RelayRemoval.trackedPath(fd) == trashed.path, "FD follows Trash rename")
        var after = stat(); _ = fstat(fd, &after)
        try check(before.st_dev == after.st_dev && before.st_ino == after.st_ino, "same vnode identity")
        var stale = false
        let resolved = try URL(resolvingBookmarkData: bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale)
        var resolvedInfo = stat(), trashInfo = stat()
        try check(lstat(resolved.path, &resolvedInfo) == 0 && lstat(trashed.path, &trashInfo) == 0 && resolvedInfo.st_dev == trashInfo.st_dev && resolvedInfo.st_ino == trashInfo.st_ino, "restart bookmark follows move")
        try FileManager.default.moveItem(at: trashed, to: installed)
        try check(RelayRemoval.trackedPath(fd) == installed.path, "undo follows same vnode")
        try FileManager.default.moveItem(at: installed, to: trashed)
        let deletion = DispatchSemaphore(value: 0)
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.delete], queue: .global())
        source.setEventHandler { if source.data.contains(.delete) { deletion.signal() } }
        source.resume()
        try FileManager.default.removeItem(at: trashed)
        try check(deletion.wait(timeout: .now() + 3) == .success, "actual vnode DELETE observed")
        let resultStat = fstat(fd, &after), missing = errno == ENOENT
        try check((resultStat != 0 && missing) || (resultStat == 0 && after.st_nlink == 0), "deleted vnode remains identifiable by original FD event")
        try check(RelayRemoval.removalFact(currentPath: RelayRemoval.trackedPath(fd), links: 1, descriptorDeleted: true, originalOccupied: false, home: root.path, uid: getuid()), "immediate empty admits cleanup")
        try check(!RelayRemoval.removalFact(currentPath: nil, links: 1, descriptorDeleted: false, originalOccupied: false, home: root.path, uid: getuid()), "failed fstat without DELETE cannot admit cleanup")
        source.cancel()
        var registrationEvents: [String] = []
        try RelayRemovalLifecycle.run(phase: "requested", restoreUser: { registrationEvents.append("user") },
            removeRegistrations: { registrationEvents.append("registrations") },
            removeComponents: { registrationEvents.append("components") },
            checkpoint: { registrationEvents.append($0) }, finish: { registrationEvents.append("finish") })
        try check(registrationEvents == ["user", "registrations", "user-cleaned", "components", "components-cleaned", "finish"],
                  "registered App entries must be removed before the user-cleaned checkpoint")
        for initial in ["requested", "user-cleaned", "components-cleaned"] {
            var events: [String] = []
            try RelayRemovalLifecycle.run(phase: initial, restoreUser: { events.append("user") }, removeComponents: { events.append("components") }, checkpoint: { events.append($0) }, finish: { events.append("finish") })
            let expected = initial == "requested" ? ["user", "user-cleaned", "components", "components-cleaned", "finish"] : initial == "user-cleaned" ? ["components", "components-cleaned", "finish"] : ["finish"]
            try check(events == expected, "resume only unfinished phases")
        }
        for failed in ["user", "user-cleaned", "components", "components-cleaned", "finish"] {
            var events: [String] = []
            func step(_ name: String) throws { events.append(name); if name == failed { throw RelayRemoval.fail("Injected interruption") } }
            do {
                try RelayRemovalLifecycle.run(phase: "requested", restoreUser: { try step("user") }, removeComponents: { try step("components") }, checkpoint: { try step($0) }, finish: { try step("finish") })
                throw RelayRemoval.fail("Expected lifecycle interruption")
            } catch { try check(events.last == failed, "failure blocks later cleanup") }
        }
        let result = try RelayRemoval.run("/usr/bin/printf", ["fixture-output"])
        try check(result.0 == 0 && String(decoding: result.1, as: UTF8.self) == "fixture-output", "cleanup output and result captured")
        count += try RelayUninstallPrivateBrowser.tests()
        count += try RelayUninstallRegistrationTests.run()
        print("{\"passed\":true,\"checks\":\(count),\"systemChangesExecuted\":false}")
    }
}
