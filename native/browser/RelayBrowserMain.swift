import Foundation
import AppKit

private final class RelayBrowserURLHandler: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        do {
            guard urls.count == 1 else { throw AssistantError("仅接受一个登录地址。") }
            try RelayBrowserLauncher.launch(urls[0].absoluteString, home: RelayBrowserContract.realHome())
        } catch {
            // Do not show OAuth URLs or fall back to another application.
            fputs("Relay 专用浏览器入口未就绪；没有调用其他浏览器。\n", stderr)
        }
        application.terminate(nil)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Launch Services may deliver its URL after didFinishLaunching.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { NSApplication.shared.terminate(nil) }
    }
}

@main struct RelayBrowserMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--browser-self-test"] { exit(runRelayBrowserSelfTests()) }
        if arguments == ["--describe"] {
            print("{\"version\":2,\"namespace\":\"\(RelayBrowserContract.namespace)\",\"binding\":\"live-relay-owner\",\"protocol\":\"http\"}")
            return
        }
        do {
            if arguments.isEmpty || arguments.allSatisfy({ $0.hasPrefix("-psn_") }) {
                _ = try RelayBrowserContract.wrapperURL()
                let delegate = RelayBrowserURLHandler()
                let app = NSApplication.shared
                app.setActivationPolicy(.accessory)
                app.delegate = delegate
                withExtendedLifetime(delegate) { app.run() }
                return
            }
            guard arguments.count == 1 else { throw AssistantError("仅接受一个 HTTP/HTTPS 登录地址。") }
            _ = try RelayBrowserContract.arguments(arguments[0], profile: URL(fileURLWithPath: "/unused"))
            try RelayBrowserLauncher.launch(arguments[0], home: RelayBrowserContract.realHome())
        } catch {
            // Never print URLs, OAuth state, parser errors or browser output.
            fputs("Relay 专用浏览器启动未确认。请检查代理、配置及专用资料是否已退出；不会调用默认浏览器。\n", stderr)
            exit(1)
        }
    }
}
