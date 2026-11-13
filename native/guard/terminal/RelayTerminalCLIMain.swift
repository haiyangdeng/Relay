import Darwin
import Foundation

@main
enum RelayTerminalCLIMain {
    static func main() {
        do { exit(try run()) }
        catch {
            let detail: String
            switch error {
            case RelayTerminalCLIResources.Failure.terminal, RelayTerminalLauncher.Failure.foregroundRequired:
                detail = "请在 macOS Terminal 的前台交互终端中运行。"
            case RelayTerminalCLIResources.Failure.workspace:
                detail = "请从个人主目录下的可写项目目录运行。"
            default:
                detail = "Relay 的专用代理租约或发布资源不可用。"
            }
            FileHandle.standardError.write(Data(("受保护的 Claude 未启动或已停止。 " + detail + "\n").utf8))
            exit(125)
        }
    }

    private static func run() throws -> Int32 {
        let image = try RelayTerminalCLIResources.load()
        let foreground = try RelayTerminalLauncher.captureForeground()
        try RelayTerminalCLIResources.verifyTerminalOrigin()
        let session = try RelayTerminalCLISession(application: image.application)
        try session.verifyExistingConfiguration()
        let lease = try RelayTerminalLeaseClient.acquire()
        defer { lease.close() }
        let launch = try session.prepare(proxyURL: lease.grant.proxyURL, caPEM: lease.grant.caPEM,
            application: image.application, node: image.node, inherited: ProcessInfo.processInfo.environment)
        try image.verifyCurrent()
        try RelayTerminalCLIResources.verifyTerminalOrigin()
        try lease.commit()
        try image.verifyCurrent()
        try session.verifyExistingConfiguration()
        return try withExtendedLifetime(session) {
            try RelayTerminalLauncher.run(foreground: foreground, executable: image.node,
                arguments: ["--use-env-proxy", image.script] + Array(CommandLine.arguments.dropFirst()),
                environment: launch.environment, workingDirectory: session.work, profile: launch.profile,
                leaseFD: lease.descriptor)
        }
    }
}
