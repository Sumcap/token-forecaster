import Foundation

// All fields are optional on purpose: the daemon owns the contract and may add
// or omit fields at any time. The menu bar app must never crash on a shape it
// does not recognise.

struct RuntimeInfo: Decodable {
    var port: Int?
    var token: String?
    var pid: Int?
    var startedAt: String?
}

struct IndexingStatus: Decodable {
    var state: String?          // "idle" | "scanning" | "training"
    var filesScanned: Int?
    var filesTotal: Int?
    var rowsUsed: Int?
    var startedAt: String?
    var finishedAt: String?
    var message: String?
}

struct SourceStatus: Decodable {
    var provider: String?
    var label: String?
    var path: String?
    var available: Bool?
    var files: Int?
    var usableCalls: Int?
    var lastScanAt: String?
}

struct ProviderGroupSummary: Decodable {
    var provider: String?
    var scale: String?
    var groups: Int?
    var samples: Int?
}

struct ProfileSummary: Decodable {
    var sampleCount: Int?
    var lastRebuildAt: String?
    var groups: Int?
    var providers: [ProviderGroupSummary]?
}

struct CoverageEntry: Decodable {
    var provider: String?
    var scale: String?
    var p50: Double?
    var p90: Double?
    var p99: Double?
    var n: Int?
}

struct CurrentSession: Decodable {
    var provider: String?
    var sessionId: String?
    var outputTokens: Int?
    var calls: Int?
    var startedAt: String?
}

/// The turn currently in flight, as reported by a client that can see it.
///
/// The daemon scans on demand, so it only knows this while something is
/// reporting — today the Claude Code status line. Absent means "nobody is
/// telling us", which is a different thing from "the turn is small": the UI
/// falls back to the idle bar rather than inventing a face.
struct LiveTurn: Decodable {
    var session: String?        // salted hash, never the raw session id
    var provider: String?
    var state: String?          // "in_flight" | "settled"
    var verdict: String?        // "under" | "near" | "over" | "unknown"
    var outputTokens: Int?
    var calls: Int?
    var p50: Double?
    var p90: Double?
    var fill: Double?           // 0…1, half width at P50 and full at P90
    var usedFallback: Bool?
    var sinceGrowthMs: Double?
    /// Name of the session this turn belongs to — the workspace directory.
    /// Absent when the reporter did not send one.
    var label: String?
    /// Sessions reporting a turn right now, this one included. More than one
    /// means the bar is showing a choice, and the menu says which.
    var sessions: Int?
}

/// One finished turn, scored against the forecast it was actually given.
struct AccuracyPoint: Decodable {
    var at: String?
    var provider: String?
    var outputTokens: Int?
    var p50: Double?
    var p90: Double?
    var verdict: String?        // "under" | "near" | "over" | "unknown"
    var usedFallback: Bool?
    /// Actual over forecast median. The one number the chart plots.
    var ratio: Double?
}

/// The rolling accuracy record, oldest point first.
struct Accuracy: Decodable {
    var points: [AccuracyPoint]?
    var n: Int?
    var withinP50: Double?
    var withinP90: Double?
    var medianRatio: Double?
}

struct HealthResponse: Decodable {
    var ok: Bool?
    var version: String?
    var paused: Bool?
    var indexing: IndexingStatus?
    var sources: [SourceStatus]?
    var profile: ProfileSummary?
    var coverage: [CoverageEntry]?
    var currentSession: CurrentSession?
    var liveTurn: LiveTurn?
    var accuracy: Accuracy?
    // Optional: the daemon may expose a headline personal P50 for the default
    // group. Guessed field name; the status title falls back to "—" when absent.
    var defaultP50: Double?
}

struct SettingsResponse: Decodable {
    var codexDir: String?
    var claudeDir: String?
    var launchAtLogin: Bool?
    /// "simple" (the default) or "detailed" — how much the terminal bar says.
    var statusStyle: String?
    /// Whether the forecast conditions on the prompt being typed.
    var draftConditioning: Bool?
    /// Whether the `claude` shell block is installed right now.
    var shellAlias: Bool?
    /// False for shells whose startup syntax this app will not write.
    var shellAliasSupported: Bool?
    /// Whether the first-run offer has already been made.
    var shellAliasOffered: Bool?
}

struct UninstallResponse: Decodable {
    var ok: Bool?
    var shellRestored: Bool?
    var dataDir: String?
}

struct RebuildResponse: Decodable {
    var started: Bool?
}

struct PauseResponse: Decodable {
    var paused: Bool?
}

struct OKResponse: Decodable {
    var ok: Bool?
}

/// What the UI needs to render, independent of transport details.
enum DaemonState {
    case notRunning(String)
    case connected(HealthResponse)
}
