import AppKit

@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {

    private let statusItem: NSStatusItem
    private let client = DaemonClient()
    private let menu = NSMenu()
    private let supervisor: DaemonSupervisor

    private var state: DaemonState = .notRunning("Daemon not running")
    private var menuIsOpen = false
    private var pollTimer: Timer?
    private var pollTask: Task<Void, Never>?

    private static let closedInterval: TimeInterval = 5
    private static let openInterval: TimeInterval = 2
    /// Only while a turn is actually in flight. The bar is worth watching then
    /// and worth nothing the rest of the time, so the fast tick is conditional
    /// rather than the new global cadence.
    private static let liveInterval: TimeInterval = 1

    private var pollInterval: TimeInterval = StatusItemController.closedInterval

    // The dynamic rows, created once. `lazy` because `info`/`action` are
    // instance methods and set `self` as the target.
    private lazy var stateItem = info("", indented: true)
    private lazy var nodeItem: NSMenuItem = {
        let item = action("Node.js not found — click to choose…", #selector(chooseNode))
        item.indentationLevel = 1
        return item
    }()
    private lazy var numbersItem = info("", indented: true)
    private lazy var sourceItem = info("", indented: true)
    private lazy var genericItem = info("Generic profile — not yet your own numbers", indented: true)
    private lazy var accuracyHeaderItem = info("Accuracy")
    /// The graph itself: an image-only row.
    ///
    /// Built through the designated initialiser with an explicit empty title.
    /// `NSMenuItem()` is a convenience initialiser that leaves the title unset,
    /// and AppKit falls back to printing a placeholder for it — which is what
    /// put a stray "NSMenuItem" label where the chart should be.
    private lazy var accuracyChartItem: NSMenuItem = {
        let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }()
    private lazy var accuracyRatesItem = info("", indented: true)
    private lazy var rebuildItem = action("Rebuild profile", #selector(rebuildProfile), key: "r")
    private lazy var showNumberItem = action("Show number in menu bar", #selector(toggleShowNumber))
    private lazy var launchItem: NSMenuItem = {
        let item = action("Launch at login", #selector(toggleLaunchAtLogin))
        if LaunchAtLogin.requiresApproval {
            item.toolTip = "Approval needed in System Settings › General › Login Items"
        }
        return item
    }()
    /// The terminal bar's style, mirrored from the daemon so the checkmark can
    /// be drawn without asking for settings on every poll.
    private lazy var detailItem = {
        let item = action("Detailed terminal status line", #selector(toggleStatusStyle))
        item.toolTip = "Adds P50 / P90 and the session total to the bar in the terminal"
        return item
    }()
    /// Forecast from the prompt being typed. Mirrored from the daemon.
    private lazy var draftItem: NSMenuItem = {
        let item = action("Forecast from your draft", #selector(toggleDraftConditioning))
        item.toolTip =
            "Conditions the forecast on the prompt you are writing, when launched with tf-claude. "
            + "Sharpens P50/P90 and costs a little at P99, so it is off unless you ask for it. "
            + "Rebuilds the profile."
        return item
    }()
    /// Install the `claude` shell block that routes new sessions through the
    /// draft-aware launcher.
    private lazy var aliasItem: NSMenuItem = {
        let item = action("Wrap `claude` and `codex` in new terminals", #selector(toggleShellAlias))
        item.toolTip =
            "Adds a claude function to your shell startup file that runs Claude Code through "
            + "tf-claude, so the status line can forecast the prompt you are typing. "
            + "Removing the app falls back to plain claude."
        return item
    }()
    private lazy var pauseItem = action("Pause watching", #selector(togglePause))
    private lazy var chooseDirsItem = action("Choose history directories…", #selector(chooseDirectories))
    private lazy var resetItem = action("Delete all derived data…", #selector(deleteDerivedData))
    private lazy var uninstallItem = action("Uninstall Token Forecaster…", #selector(uninstall))

    /// Last known terminal bar style; refreshed whenever the menu opens.
    private var detailedStatusLine = false

    /// Last known draft-conditioning setting; refreshed whenever the menu opens.
    private var draftConditioning = false

    /// Last known state of the shell block, and whether this shell supports one.
    private var shellAlias = false
    private var shellAliasSupported = false
    /// Set once the first-run offer has been made, so it is never repeated.
    private var shellAliasOffered = true
    /// Whether the first-run setup has already been reported, ever.
    private static let shellNoticeKey = "shellAliasNoticeShown"
    private var shellNoticeShown: Bool {
        get { UserDefaults.standard.bool(forKey: Self.shellNoticeKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.shellNoticeKey) }
    }

    /// The bars currently drawn in the accuracy chart.
    private var drawnChartKey: String?

    /// What the button is currently drawing.
    ///
    /// The image is rebuilt on every poll — once a second while a turn is in
    /// flight — and reassigning it makes AppKit redraw the item even when the
    /// artwork is identical. Comparing a key first means the icon changes only
    /// when what it is saying changes.
    private var drawnKey: String?

    /// Persisted preference: show the compact P50 next to the icon. Off by
    /// default so the item stays ~24pt wide and has the best chance of fitting
    /// into a crowded (or notched) menu bar.
    private static let showNumberKey = "showNumberInMenuBar"

    private var showsNumber: Bool {
        get { UserDefaults.standard.bool(forKey: Self.showNumberKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.showNumberKey) }
    }

    /// Rebuilding the profile: a distinct shape, because the numbers either
    /// side of it are not the same numbers.
    private static let trainingImage: NSImage? = StatusArtwork.symbol([
        "arrow.triangle.2.circlepath", "arrow.clockwise", "gearshape"
    ])
    /// Daemon unreachable.
    private static let alertImage: NSImage? = StatusArtwork.symbol(["exclamationmark.triangle"])
    /// Nothing known yet, before the first poll answers.
    private static let idleImage: NSImage = StatusArtwork.meter(fill: 0, face: nil, generic: false)

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        supervisor = DaemonSupervisor(client: client)
        super.init()

        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu

        if let button = statusItem.button {
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            button.image = Self.idleImage
            button.imagePosition = .imageOnly
            button.title = ""
            button.toolTip = "Token Forecaster"
        }

        syncMenu()
        schedulePolling(interval: Self.closedInterval)
        // Be self-sufficient: adopt a daemon that is already up, else start one.
        supervisor.ensureRunning()
        refresh()
        // A clean install has a question to ask, and it should not have to wait
        // for the menu to be opened before asking it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.refreshStatusStyle()
        }
        logPlacement()
    }

    /// True when AppKit has parked the item under the notch, where it cannot
    /// be seen or clicked.
    ///
    /// `isVisible` stays true in that case — macOS reports the item as placed
    /// and simply never draws it — so the only reliable test is geometry:
    /// does the item's frame reach into the gap between the two notch-safe
    /// areas.
    private func isHiddenUnderNotch() -> Bool {
        guard let frame = statusItem.button?.window?.frame else { return false }
        if frame.width == 0 { return true }
        guard let screen = NSScreen.main,
              let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea else { return false }
        return frame.maxX > left.maxX && frame.minX < right.minX
    }

    /// One line in the companion log, shortly after AppKit has placed the item,
    /// so an invisible status item is diagnosable after the fact.
    private func logPlacement() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            let frame = self.statusItem.button?.window?.frame
            let geometry = frame.map {
                "\(Int($0.origin.x)),\(Int($0.origin.y)),\(Int($0.width))x\(Int($0.height))"
            } ?? "none"
            let screen = NSScreen.main
            let left = screen?.auxiliaryTopLeftArea.map { "\(Int($0.maxX))" } ?? "none"
            let right = screen?.auxiliaryTopRightArea.map { "\(Int($0.minX))" } ?? "none"
            self.supervisor.log(
                "status item frame=\(geometry) visible=\(self.statusItem.isVisible) "
                + "hiddenUnderNotch=\(self.isHiddenUnderNotch()) "
                + "notchSafeLeft=\(left) notchSafeRight=\(right)"
            )
        }
    }

    /// Called from the app delegate on quit. Only ever kills a child we spawned.
    func appWillTerminate() {
        pollTimer?.invalidate()
        pollTask?.cancel()
        supervisor.terminateOwnedChild()
    }

    deinit {
        pollTimer?.invalidate()
        pollTask?.cancel()
    }

    // MARK: - Polling

    private func schedulePolling(interval: TimeInterval) {
        pollInterval = interval
        pollTimer?.invalidate()
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    private func refresh() {
        guard pollTask == nil else { return }   // never pile up in-flight polls
        pollTask = Task { [weak self] in
            guard let self else { return }
            let result: DaemonState
            do {
                let health = try await self.client.health()
                result = .connected(health)
            } catch {
                let message = (error as? DaemonError)?.errorDescription ?? "Daemon not running"
                result = .notRunning(message)
            }
            await MainActor.run {
                self.state = result
                if case .connected = result {
                    self.supervisor.noteHealthy()
                } else {
                    // A connection error means nobody is serving: start one.
                    self.supervisor.ensureRunning()
                }
                self.updateTitle()
                self.retunePolling()
                if self.menuIsOpen { self.syncMenu() }
                self.pollTask = nil
            }
        }
    }

    /// Poll fast only while a turn is in flight, then drop straight back.
    private func retunePolling() {
        let wanted: TimeInterval
        if menuIsOpen {
            wanted = Self.openInterval
        } else if case .connected(let health) = state, health.liveTurn?.state == "in_flight" {
            wanted = Self.liveInterval
        } else {
            wanted = Self.closedInterval
        }
        if wanted != pollInterval { schedulePolling(interval: wanted) }
    }

    // MARK: - Status item title

    private func updateTitle() {
        guard let button = statusItem.button else { return }

        // Width is scarce, so state is carried by the artwork, not by the text.
        let number: String
        let stateText: String
        var image: NSImage? = Self.idleImage
        var isDimmed = false
        // What the artwork is saying, so identical artwork is not redrawn.
        // The fill is rounded to a fiftieth: finer steps than that are
        // invisible in a 22pt bar and only cost a redraw.
        var artworkKey = "idle"

        switch state {
        case .notRunning(let message):
            number = "—"
            image = Self.alertImage
            artworkKey = "alert"
            switch supervisor.status {
            case .starting:
                stateText = "starting…"
                isDimmed = true
            case .failed, .nodeMissing:
                stateText = supervisor.disconnectedStatusLine
            case .idle, .running:
                stateText = supervisor.status == .idle ? message : supervisor.disconnectedStatusLine
            }
        case .connected(let health):
            let turn = health.liveTurn
            // While a turn is running its own size is the interesting number;
            // the rest of the time, the P50 it will be measured against.
            number = turn.flatMap { $0.outputTokens.map { Fmt.compact(Double($0)) } }
                ?? Fmt.compact(health.defaultP50)
            stateText = Self.describeState(health)
            if Self.isBusy(health) {
                image = Self.trainingImage
                artworkKey = "training"
                isDimmed = true
            } else {
                let generic = Self.isGeneric(health)
                // Space is the whole constraint here. With a number beside it
                // the item shows the face or the bar, never both: the two
                // together plus text is wide enough that macOS hides the item
                // outright on a full menu bar, which reads as a crash.
                if showsNumber, let face = Self.face(turn) {
                    image = StatusArtwork.face(face, generic: generic)
                    artworkKey = "face:\(face)"
                } else {
                    // Fall back to the idle bar whenever nobody is reporting a
                    // turn: no status line, Codex work, or a stale report.
                    let fill = turn?.fill ?? 0
                    let face = showsNumber ? nil : Self.face(turn)
                    image = StatusArtwork.meter(fill: fill, face: face, generic: generic)
                    artworkKey = "meter:\(Int((fill * 50).rounded())):\(face.map(String.init(describing:)) ?? "-")"
                }
                artworkKey += generic ? ":generic" : ":personal"
                isDimmed = health.paused == true
            }
        }

        // Rebuilt on every poll — once a second while a turn is in flight —
        // and reassigning the image makes AppKit redraw the item whether or
        // not the artwork changed. That redraw is the flicker.
        let key = "\(artworkKey)|\(isDimmed)"
        if key != drawnKey {
            drawnKey = key
            button.image = image
            button.appearsDisabled = isDimmed
        }
        if showsNumber {
            button.imagePosition = .imageLeading
            button.title = " \(number)"
        } else {
            button.imagePosition = .imageOnly
            button.title = ""
        }
        button.toolTip = "Token Forecaster — \(stateText)"
    }

    // MARK: - NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        menuIsOpen = true
        schedulePolling(interval: Self.openInterval)
        syncMenu()
        refresh()
        refreshStatusStyle()
    }

    func menuDidClose(_ menu: NSMenu) {
        menuIsOpen = false
        schedulePolling(interval: Self.closedInterval)
    }

    // MARK: - Menu construction

    private func info(_ title: String, indented: Bool = false) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        if indented { item.indentationLevel = 1 }
        return item
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        return item
    }

    /// An item that opens a submenu of `items`.
    private func folder(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        sub.autoenablesItems = false
        for child in items { sub.addItem(child) }
        item.submenu = sub
        item.isEnabled = true
        return item
    }

    /// The menu is a glance, not a report.
    ///
    /// It answers one question — what is happening right now — and offers the
    /// things worth clicking. Numbers to read belong in the dashboard, which
    /// has room to lay them out properly, and are not repeated here.
    ///
    /// The item set is built once and then only ever updated in place. It used
    /// to be torn down and rebuilt on every poll, which is twice a second
    /// while the menu is open: that deallocated whichever item the pointer was
    /// resting on, so the Settings submenu never survived long enough for
    /// AppKit's hover delay to open it, and the highlight flickered off
    /// anything else being aimed at. A row that is not applicable right now is
    /// hidden rather than removed, so the structure never moves under the
    /// cursor either.
    private func buildMenu() {
        guard menu.numberOfItems == 0 else { return }

        menu.addItem(info("Token Forecaster"))
        menu.addItem(stateItem)
        menu.addItem(nodeItem)
        menu.addItem(numbersItem)
        menu.addItem(sourceItem)
        menu.addItem(genericItem)

        menu.addItem(.separator())
        menu.addItem(accuracyHeaderItem)
        menu.addItem(accuracyChartItem)
        menu.addItem(accuracyRatesItem)

        menu.addItem(.separator())
        menu.addItem(action("Open dashboard", #selector(openDashboard), key: "d"))
        menu.addItem(rebuildItem)

        menu.addItem(.separator())
        menu.addItem(folder("Settings", [
            showNumberItem, detailItem, draftItem, aliasItem, launchItem, pauseItem,
            .separator(),
            chooseDirsItem, action("Restart daemon", #selector(restartDaemon)),
            action("Open log", #selector(openLog)),
            .separator(),
            resetItem, uninstallItem,
        ]))

        menu.addItem(.separator())
        menu.addItem(action("Quit", #selector(quit), key: "q"))
    }

    /// Point every dynamic row at the current state. Safe to call while the
    /// menu is open and being hovered.
    private func syncMenu() {
        buildMenu()

        let health: HealthResponse?
        let stateLine: String
        switch state {
        case .notRunning(let message):
            health = nil
            // Prefer what the supervisor knows: starting / failed / no node.
            stateLine = supervisor.status == .idle ? message : supervisor.disconnectedStatusLine
        case .connected(let h):
            health = h
            stateLine = Self.describeState(h)
        }

        // 1 — the state, in words, so it never depends on reading the glyph
        stateItem.title = stateLine
        nodeItem.isHidden = supervisor.status != .nodeMissing

        // 2 — the numbers behind that line, only when that line is about the
        // turn: pairing "P50 · P90" with an "Indexing…" headline reads as two
        // unrelated facts stacked on top of each other.
        let describesTurn = health.map { !Self.isBusy($0) && $0.paused != true } ?? false
        let turn = describesTurn ? health?.liveTurn : nil
        if let turn, turn.outputTokens != nil {
            numbersItem.isHidden = false
            numbersItem.title =
                "P50 \(Fmt.compact(turn.p50)) · P90 \(Fmt.compact(turn.p90)) · \(Fmt.count(turn.calls)) calls"
            // Which chat this is. The bar is one measurement wide and several
            // sessions can be running, so naming the one on screen is the
            // difference between a number and an unattributed number.
            let source = Self.describeSource(turn)
            sourceItem.isHidden = source == nil
            sourceItem.title = source ?? ""
            genericItem.isHidden = turn.usedFallback != true
        } else {
            numbersItem.isHidden = true
            sourceItem.isHidden = true
            genericItem.isHidden = true
        }

        // 3 — how the forecast has actually been doing, which is the one claim
        // the app makes that a user can check for themselves.
        syncAccuracy(health?.accuracy)

        // 4 — the things worth clicking, and what they can do right now
        let connected = health != nil
        rebuildItem.isEnabled = connected
        showNumberItem.state = showsNumber ? .on : .off
        detailItem.state = detailedStatusLine ? .on : .off
        detailItem.isEnabled = connected
        draftItem.state = draftConditioning ? .on : .off
        draftItem.isEnabled = connected
        aliasItem.state = shellAlias ? .on : .off
        aliasItem.isEnabled = connected && shellAliasSupported
        launchItem.state = LaunchAtLogin.isEnabled ? .on : .off
        launchItem.isEnabled = LaunchAtLogin.isSupported
        pauseItem.title = (health?.paused ?? false) ? "Resume watching" : "Pause watching"
        pauseItem.isEnabled = connected
        chooseDirsItem.isEnabled = connected
        resetItem.isEnabled = connected
        uninstallItem.isEnabled = connected
    }

    /// The recent record, as a graph.
    ///
    /// Every bar is a turn the user watched happen, scored against the number
    /// that was on screen at the time — not a backtest. That is what makes it
    /// worth a graph rather than a line of text: the shape says whether the
    /// forecast is unbiased noise or is consistently low, which no single
    /// percentage does.
    private func syncAccuracy(_ accuracy: Accuracy?) {
        let bars: [StatusArtwork.AccuracyBar] = (accuracy?.points ?? []).compactMap { point in
            guard let ratio = point.ratio, ratio.isFinite, ratio > 0,
                  let verdict = point.verdict, verdict != "unknown" else { return nil }
            var band: Double?
            if let p50 = point.p50, p50 > 0, let p90 = point.p90, p90 > 0 {
                let value = p90 / p50
                band = value.isFinite ? value : nil
            }
            return StatusArtwork.AccuracyBar(
                ratio: ratio, verdict: verdict, bandRatio: band, generic: point.usedFallback == true)
        }

        guard !bars.isEmpty else {
            accuracyHeaderItem.title = "Accuracy"
            accuracyChartItem.isHidden = true
            accuracyRatesItem.isHidden = false
            accuracyRatesItem.attributedTitle = Self.caption(
                "No finished turns scored yet — this fills in as you work.")
            drawnChartKey = nil
            return
        }

        // Just the word. How many turns and how they landed is what the bars
        // are for; saying it again in text is the graph's caption arguing with
        // the graph.
        accuracyHeaderItem.title = "Accuracy"
        accuracyChartItem.isHidden = false
        accuracyRatesItem.isHidden = false
        accuracyRatesItem.attributedTitle = Self.accuracyCaption(accuracy)

        // Redrawing identical artwork every two seconds is a visible twitch in
        // an open menu, so the bars are only rendered when they change.
        let key = bars.map { "\(Int($0.ratio * 100)):\($0.verdict):\($0.generic)" }
            .joined(separator: ",")
            + "|\(Int((accuracy?.medianRatio ?? 0) * 100))"
        if key != drawnChartKey {
            drawnChartKey = key
            accuracyChartItem.image = StatusArtwork.accuracyChart(
                bars, medianRatio: accuracy?.medianRatio)
        }
        // Never leave a titleless row with nothing in it.
        accuracyChartItem.isHidden = accuracyChartItem.image == nil
    }

    /// Small, quiet, multi-line menu text.
    private static func caption(_ text: String) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 1
        return NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 11),
            .foregroundColor: NSColor.secondaryLabelColor,
            .paragraphStyle: paragraph,
        ])
    }

    /// What the two rates mean, in words, and what they say about the forecast.
    ///
    /// This row used to read "38% under P50 · 92% under P90 — calibrated is 50%
    /// and 90%", which asks the reader to know what a percentile is, to
    /// remember which way is good, and then to do the comparison themselves.
    /// All three are the menu's job. So: the rates in plain words on the first
    /// line, and on the second the conclusion they add up to — the forecast
    /// runs low, runs high, or is about right.
    private static func accuracyCaption(_ accuracy: Accuracy?) -> NSAttributedString {
        let p50 = accuracy?.withinP50
        let p90 = accuracy?.withinP90
        let counted = accuracy?.n ?? 0
        let rates = "\(Fmt.percent(p50)) came in under the estimate · "
            + "\(Fmt.percent(p90)) under the worst case"

        // Half of your turns are supposed to land over the estimate and one in
        // ten over the worst case: these targets are what "right" looks like,
        // and higher is not better.
        let verdict: String
        switch (p50, p90) {
        case let (under50?, under90?) where counted >= 10:
            if under90 < 0.8 || under50 < 0.3 {
                verdict = "Forecasts are running low — turns overshoot more often than they should."
            } else if under50 > 0.7 && under90 > 0.97 {
                verdict = "Forecasts are running high — most turns finish well under them."
            } else {
                verdict = "About right: the targets are 50% and 90%."
            }
        default:
            verdict = "Targets are 50% and 90% — a few more turns and this will mean something."
        }
        return caption("\(rates)\n\(verdict)")
    }

    /// "in token-forecaster · 1 of 3 active chats", or nil when the reporter
    /// named neither.
    private static func describeSource(_ turn: LiveTurn) -> String? {
        let sessions = turn.sessions ?? 1
        var parts: [String] = []
        if let label = turn.label, !label.isEmpty { parts.append("in \(label)") }
        if sessions > 1 { parts.append("1 of \(sessions) active chats") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func isBusy(_ health: HealthResponse) -> Bool {
        let state = health.indexing?.state
        return state == "scanning" || state == "training"
    }

    /// True when the forecast behind the bar is the bundled generic one.
    ///
    /// A live report says so directly; with no report, no personal samples
    /// means the same thing. The bar's track is dashed either way, so a generic
    /// number is never dressed up as a personal one.
    private static func isGeneric(_ health: HealthResponse) -> Bool {
        if let fallback = health.liveTurn?.usedFallback { return fallback }
        return (health.profile?.sampleCount ?? 0) == 0
    }

    private static func face(_ turn: LiveTurn?) -> StatusArtwork.Face? {
        switch turn?.verdict {
        case "under":   return .happy
        case "near":    return .neutral
        case "over":    return .sad
        default:        return nil   // no report, or nothing to judge against
        }
    }

    /// The state in words. Shown in the tooltip and in the first row of the
    /// menu, so a face is never the only way to know what is going on.
    private static func describeState(_ health: HealthResponse) -> String {
        if health.paused == true { return "Paused" }
        if let indexing = health.indexing, isBusy(health) {
            if indexing.state == "training" { return "Training… rebuilding your profile" }
            let done = indexing.filesScanned ?? 0
            if let total = indexing.filesTotal, total > 0 {
                return "Indexing… \(Fmt.count(done))/\(Fmt.count(total)) files"
            }
            return "Indexing… \(Fmt.count(done)) files"
        }
        if let line = describeTurn(health.liveTurn) { return line }
        return "Connected — no turn in flight"
    }

    /// "This turn 3.2k tokens · running long — past P90", or nil when nothing
    /// is reporting a turn.
    private static func describeTurn(_ turn: LiveTurn?) -> String? {
        guard let turn, let tokens = turn.outputTokens else { return nil }
        let lead = turn.state == "settled" ? "Last turn" : "This turn"
        let verdict: String
        switch turn.verdict {
        case "under":   verdict = "on track — at or under your P50"
        case "near":    verdict = "running warm — past P50, under P90"
        case "over":    verdict = "running long — past P90"
        default:        verdict = "no forecast to judge it against"
        }
        var line = "\(lead) \(Fmt.compact(Double(tokens))) tokens · \(verdict)"
        if let label = turn.label, !label.isEmpty { line += " · \(label)" }
        if turn.usedFallback == true { line += " · generic profile" }
        return line
    }

    // MARK: - Actions

    @objc private func rebuildProfile() {
        run("Rebuild failed") { try await self.client.rebuild() }
    }

    @objc private func openDashboard() {
        if let url = client.dashboardURL() {
            NSWorkspace.shared.open(url)
        } else {
            alert(title: "Daemon not running",
                  message: "Start the Token Forecaster companion daemon, then try again.\n\nExpected runtime file:\n\(DaemonClient.runtimeURL.path)")
        }
    }

    /// Read the terminal bar style back from the daemon. Best effort: a failure
    /// just leaves the checkmark showing what it showed before.
    private func refreshStatusStyle() {
        Task { [weak self] in
            guard let self else { return }
            let settings = try? await self.client.settings()
            guard let settings else { return }
            await MainActor.run {
                self.detailedStatusLine = settings.statusStyle == "detailed"
                self.draftConditioning = settings.draftConditioning ?? false
                self.shellAlias = settings.shellAlias ?? false
                self.shellAliasSupported = settings.shellAliasSupported ?? false
                self.shellAliasOffered = settings.shellAliasOffered ?? true
                self.syncMenu()
                self.announceShellAliasOnce()
            }
        }
    }

    @objc private func toggleStatusStyle() {
        let next = detailedStatusLine ? "simple" : "detailed"
        detailedStatusLine = !detailedStatusLine
        syncMenu()
        run("Could not change the status line style") {
            try await self.client.updateSettings(statusStyle: next)
        }
    }

    /// Say what the first run set up, once.
    ///
    /// The daemon writes the shell block itself on a clean install — forecasting
    /// the prompt being typed is the point of the app, and it cannot happen in a
    /// session that did not start through the launcher. Editing someone's
    /// startup file still deserves to be said out loud, so this reports it and
    /// offers to undo it on the spot.
    private func announceShellAliasOnce() {
        guard !shellNoticeShown, shellAlias, shellAliasSupported else { return }
        shellNoticeShown = true
        let panel = NSAlert()
        panel.messageText = "New terminals now forecast what you type"
        panel.informativeText =
            "Added a claude function to your shell startup file, with a backup beside it. "
            + "Terminals already open are unaffected."
        panel.addButton(withTitle: "OK")
        panel.addButton(withTitle: "Undo")
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() != .alertFirstButtonReturn else { return }
        shellAlias = false
        syncMenu()
        run("Could not update your shell startup file") {
            try await self.client.updateSettings(shellAlias: false)
        }
    }

    @objc private func toggleShellAlias() {
        let next = !shellAlias
        shellAlias = next
        syncMenu()
        run("Could not update your shell startup file") {
            try await self.client.updateSettings(shellAlias: next)
        }
    }

    /// Take the app back out of the machine, in the order that keeps it safe.
    @objc private func uninstall() {
        let panel = NSAlert()
        panel.alertStyle = .warning
        panel.messageText = "Uninstall Token Forecaster?"
        panel.informativeText =
            "Restores your shell startup file, deletes the profile and all settings, and moves "
            + "the app to the Trash. Your history files are not touched."
        panel.addButton(withTitle: "Cancel")
        let destructive = panel.addButton(withTitle: "Uninstall")
        destructive.hasDestructiveAction = true
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() != .alertFirstButtonReturn else { return }

        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.client.uninstall()
            } catch {
                let message = (error as? DaemonError)?.errorDescription ?? error.localizedDescription
                await MainActor.run { self.alert(title: "Could not uninstall", message: message) }
                return
            }
            await MainActor.run {
                // The daemon is a child of this process and goes with it; the
                // bundle is moved to the Trash rather than deleted, so an
                // uninstall by mistake is still recoverable.
                let bundle = Bundle.main.bundleURL
                NSWorkspace.shared.recycle([bundle]) { _, _ in
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                }
            }
        }
    }

    @objc private func toggleDraftConditioning() {
        let next = !draftConditioning
        draftConditioning = next
        syncMenu()
        run("Could not change draft forecasting") {
            try await self.client.updateSettings(draftConditioning: next)
        }
    }

    @objc private func togglePause() {
        guard case .connected(let health) = state else { return }
        let next = !(health.paused ?? false)
        run("Could not change watching state") { try await self.client.setPaused(next) }
    }

    @objc private func chooseDirectories() {
        let codex = pickDirectory(prompt: "Choose Codex sessions directory")
        let claude = pickDirectory(prompt: "Choose Claude Code projects directory")
        guard codex != nil || claude != nil else { return }
        run("Could not save settings") {
            try await self.client.updateSettings(codexDir: codex, claudeDir: claude)
        }
    }

    @objc private func toggleLaunchAtLogin() {
        let target = !LaunchAtLogin.isEnabled
        if let failure = LaunchAtLogin.set(target) {
            alert(title: "Launch at login unavailable", message: failure)
        }
        syncMenu()
    }

    @objc private func deleteDerivedData() {
        let panel = NSAlert()
        panel.alertStyle = .warning
        panel.messageText = "Delete all derived data?"
        panel.informativeText = "This removes the personal profile, the scan index, and all cached forecasts. Your history files are not touched. This cannot be undone."
        // Cancel is added first so it is the default button.
        panel.addButton(withTitle: "Cancel")
        let destructive = panel.addButton(withTitle: "Delete")
        destructive.hasDestructiveAction = true
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .alertSecondButtonReturn else { return }
        run("Could not delete derived data") { try await self.client.reset() }
    }

    @objc private func toggleShowNumber() {
        showsNumber = !showsNumber
        updateTitle()
        syncMenu()
        guard showsNumber else { return }
        // The wider item may not fit, and macOS hides it rather than shrinking
        // it — silently, which looks exactly like the app having crashed. Check
        // once AppKit has re-laid the bar out, and offer the way back.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.showsNumber, self.isHiddenUnderNotch() else { return }
            self.supervisor.log("number turned on and the item no longer fits; offering to revert")
            let a = NSAlert()
            a.alertStyle = .informational
            a.messageText = "No room for the number"
            a.informativeText = """
            The app is still running, but with the number beside it the icon is \
            wider than the free slot in your menu bar, so macOS parked it under \
            the notch instead of shrinking it.

            Turn the number off to get the icon back, or free a slot by quitting \
            a menu bar app, ⌘-dragging icons to rearrange them, or using a menu \
            bar manager such as Ice or Bartender.
            """
            a.addButton(withTitle: "Turn the number off")
            a.addButton(withTitle: "Keep it hidden")
            NSApp.activate(ignoringOtherApps: true)
            if a.runModal() == .alertFirstButtonReturn {
                self.showsNumber = false
                self.updateTitle()
                self.syncMenu()
            }
        }
    }

    @objc private func restartDaemon() {
        supervisor.restart()
        refresh()
    }

    @objc private func openLog() {
        supervisor.openLog()
    }

    @objc private func chooseNode() {
        supervisor.chooseNodeBinary()
        syncMenu()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Helpers

    private func pickDirectory(prompt: String) -> String? {
        let panel = NSOpenPanel()
        panel.title = prompt
        panel.message = prompt
        panel.prompt = "Choose"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.showsHiddenFiles = true
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK else { return nil }
        return panel.url?.path
    }

    private func run<T>(_ failureTitle: String, _ work: @escaping () async throws -> T) {
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await work()
                await MainActor.run {
                    self.refresh()
                }
            } catch {
                let message = (error as? DaemonError)?.errorDescription ?? error.localizedDescription
                await MainActor.run {
                    self.alert(title: failureTitle, message: message)
                }
            }
        }
    }

    private func alert(title: String, message: String) {
        let a = NSAlert()
        a.alertStyle = .informational
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }
}
