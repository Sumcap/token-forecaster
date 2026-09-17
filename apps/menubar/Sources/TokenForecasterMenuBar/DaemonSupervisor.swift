import AppKit
import Foundation

/// Where the supervisor thinks the companion daemon is, from the app's point of
/// view. `connected` is decided by the poller, not here.
enum SupervisorStatus: Equatable {
    /// Nothing attempted yet, or a daemon someone else started is answering.
    case idle
    /// We spawned a child and are waiting for it to publish runtime.json.
    case starting
    /// Our child is alive.
    case running
    /// The child exited, or could not be spawned. Details are in the log.
    case failed(String)
    /// No `node` binary anywhere we looked.
    case nodeMissing

    var isBusy: Bool { self == .starting }
}

/// Starts and owns a companion daemon process so the app is self-sufficient.
///
/// Rules it never breaks:
///   * if a daemon already answers `/health`, we do not start a second one;
///   * we only ever terminate a child **we** spawned.
@MainActor
final class DaemonSupervisor {

    private(set) var status: SupervisorStatus = .idle

    /// Non-nil only while a daemon *we* started is alive.
    private var child: Process?
    private var startAttemptInFlight = false
    private var lastStartAt: Date?

    /// Don't thrash: at most one spawn attempt per this many seconds.
    private static let restartCooldown: TimeInterval = 8
    /// How long we let a fresh child publish runtime.json before giving up.
    private static let startupGrace: TimeInterval = 25
    private static let maxLogBytes: UInt64 = 5 * 1024 * 1024

    private let client: DaemonClient

    init(client: DaemonClient) {
        self.client = client
    }

    var isOwningChild: Bool { child?.isRunning == true }

    // MARK: - Paths

    static let logURL: URL = {
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        return home
            .appendingPathComponent("Library/Logs/TokenForecaster", isDirectory: true)
            .appendingPathComponent("companion.log", isDirectory: false)
    }()

    /// First existing candidate wins:
    ///   1. the copy bundled into the .app (`make dist`),
    ///   2. `UserDefaults.companionCliPath` (point at a repo build),
    ///   3. `<repo>/apps/companion/dist/cli.js` inferred from where we run from.
    static func resolveCliPath() -> String? {
        let fm = FileManager.default

        if let bundled = Bundle.main.resourceURL?
            .appendingPathComponent("companion", isDirectory: true)
            .appendingPathComponent("cli.js", isDirectory: false),
           fm.fileExists(atPath: bundled.path) {
            return bundled.path
        }

        if let override = UserDefaults.standard.string(forKey: "companionCliPath"),
           !override.isEmpty,
           fm.fileExists(atPath: override) {
            return override
        }

        // Development: walk up from the executable looking for the workspace.
        var dir = Bundle.main.executableURL?.resolvingSymlinksInPath().deletingLastPathComponent()
        var hops = 0
        while let current = dir, hops < 12 {
            let candidate = current
                .appendingPathComponent("apps/companion/dist/cli.js", isDirectory: false)
            if fm.fileExists(atPath: candidate.path) { return candidate.path }
            let parent = current.deletingLastPathComponent()
            if parent.path == current.path { break }
            dir = parent
            hops += 1
        }
        return nil
    }

    /// GUI apps do not inherit the login shell's PATH, so probe real paths.
    /// Order: Homebrew, /usr/local, whatever a login shell resolves, then the
    /// path the user picked in the "choose node" panel.
    static func resolveNodePath() -> String? {
        let fm = FileManager.default
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if fm.isExecutableFile(atPath: path) { return path }
        }
        if let viaShell = nodeViaLoginShell(), fm.isExecutableFile(atPath: viaShell) {
            return viaShell
        }
        if let stored = UserDefaults.standard.string(forKey: "nodePath"),
           !stored.isEmpty,
           fm.isExecutableFile(atPath: stored) {
            return stored
        }
        return nil
    }

    private static func nodeViaLoginShell() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    // MARK: - Logging

    /// Opens the log for appending, creating the directory and truncating a log
    /// that has grown past the cap.
    private static func openLogHandle() -> FileHandle? {
        let fm = FileManager.default
        let url = logURL
        try? fm.createDirectory(at: url.deletingLastPathComponent(),
                                withIntermediateDirectories: true)
        if let attrs = try? fm.attributesOfItem(atPath: url.path),
           let size = attrs[.size] as? UInt64,
           size > maxLogBytes {
            try? Data().write(to: url)
        }
        // O_APPEND so the app's own notes and the child's stdout/stderr can
        // share the file without one overwriting the other's offset.
        let fd = open(url.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        guard fd >= 0 else { return nil }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    /// Append one line to the shared companion log. Used by other parts of the
    /// app (e.g. the status item's placement self-check) so there is exactly
    /// one log file.
    func log(_ line: String) {
        note(line)
    }

    private func note(_ line: String) {
        guard let handle = Self.openLogHandle() else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        try? handle.write(contentsOf: Data("[\(stamp)] menubar: \(line)\n".utf8))
        try? handle.close()
    }

    // MARK: - Lifecycle

    /// Start a daemon unless one is already reachable. Safe to call on every
    /// failed poll: it self-throttles and never starts a second daemon.
    func ensureRunning() {
        guard !startAttemptInFlight else { return }
        if case .nodeMissing = status { return }   // wait for the user to pick node
        if let last = lastStartAt, Date().timeIntervalSince(last) < Self.restartCooldown { return }
        if isOwningChild { return }                 // ours is up; poller will notice

        startAttemptInFlight = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.startAttemptInFlight = false }

            if await self.daemonIsReachable() {
                if self.child == nil { self.status = .idle }
                return
            }
            self.spawn()
        }
    }

    /// Kill ours (if any) and start fresh. Used by the "Restart daemon" item.
    func restart() {
        terminateOwnedChild()
        lastStartAt = nil
        // Re-probe node in case the user just installed or picked it.
        status = .idle
        ensureRunning()
    }

    private func daemonIsReachable() async -> Bool {
        do {
            _ = try await client.health()
            return true
        } catch {
            return false
        }
    }

    private func spawn() {
        guard let cli = Self.resolveCliPath() else {
            status = .failed("Companion CLI not found")
            note("no companion cli.js found (bundle, UserDefaults.companionCliPath, repo)")
            return
        }
        guard let node = Self.resolveNodePath() else {
            status = .nodeMissing
            note("no node binary found at /opt/homebrew/bin, /usr/local/bin, login shell, or UserDefaults.nodePath")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["--no-warnings", cli, "start"]
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)

        var env = ProcessInfo.processInfo.environment
        // Give the child a usable PATH even though we launched from Finder.
        let nodeDir = (node as NSString).deletingLastPathComponent
        let existing = env["PATH"] ?? ""
        env["PATH"] = ([nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            + existing.split(separator: ":").map(String.init))
            .reduce(into: [String]()) { acc, item in if !acc.contains(item) { acc.append(item) } }
            .joined(separator: ":")
        process.environment = env

        note("starting: \(node) --no-warnings \(cli) start")

        if let handle = Self.openLogHandle() {
            process.standardOutput = handle
            process.standardError = handle
        } else {
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
        }
        process.standardInput = FileHandle.nullDevice

        process.terminationHandler = { finished in
            let code = finished.terminationStatus
            Task { @MainActor [weak self] in
                guard let self, self.child === finished else { return }
                self.child = nil
                if code != 0 {
                    self.status = .failed("companion exited with status \(code)")
                    self.note("companion exited with status \(code)")
                } else {
                    self.status = .idle
                }
            }
        }

        do {
            try process.run()
        } catch {
            status = .failed(error.localizedDescription)
            note("spawn failed: \(error.localizedDescription)")
            return
        }

        child = process
        lastStartAt = Date()
        status = .starting

        // If it never comes up, stop claiming we are still starting.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.startupGrace * 1_000_000_000))
            guard let self, self.status == .starting else { return }
            if await self.daemonIsReachable() {
                self.status = self.isOwningChild ? .running : .idle
            } else {
                self.status = .failed("daemon did not become reachable")
                self.note("daemon did not become reachable within \(Int(Self.startupGrace))s")
            }
        }
    }

    /// Called by the poller when a health check succeeds.
    func noteHealthy() {
        status = isOwningChild ? .running : .idle
    }

    /// Terminate the child **only** if we started it.
    func terminateOwnedChild() {
        guard let process = child else { return }
        child = nil
        process.terminationHandler = nil
        guard process.isRunning else { return }
        note("terminating companion (pid \(process.processIdentifier))")
        process.terminate()
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }

    // MARK: - User-facing helpers

    func openLog() {
        _ = Self.openLogHandle()   // make sure the file exists before opening it
        NSWorkspace.shared.open(Self.logURL)
    }

    /// NSOpenPanel to pick a node binary, stored in `UserDefaults.nodePath`.
    /// Returns true when a path was chosen and a retry was kicked off.
    @discardableResult
    func chooseNodeBinary() -> Bool {
        let panel = NSOpenPanel()
        panel.title = "Choose the node binary"
        panel.message = "Select the Node.js executable (for example /opt/homebrew/bin/node)."
        panel.prompt = "Choose"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.treatsFilePackagesAsDirectories = true
        panel.directoryURL = URL(fileURLWithPath: "/opt/homebrew/bin", isDirectory: true)
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        UserDefaults.standard.set(url.path, forKey: "nodePath")
        status = .idle
        lastStartAt = nil
        ensureRunning()
        return true
    }

    /// The header line shown when the poller cannot reach a daemon.
    var disconnectedStatusLine: String {
        switch status {
        case .starting:            return "Starting daemon…"
        case .nodeMissing:         return "Node.js not found"
        case .failed:              return "Daemon failed to start — see log"
        case .idle, .running:      return "Daemon not running"
        }
    }
}
