import Foundation

enum Fmt {
    static let integer: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        return f
    }()

    static func count(_ value: Int?) -> String {
        guard let value else { return "—" }
        return integer.string(from: NSNumber(value: value)) ?? String(value)
    }

    /// Compact token count for the status-item title: 4321 -> "4.3k".
    static func compact(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        let v = abs(value)
        switch v {
        case 0..<1_000:
            return String(Int(value.rounded()))
        case 1_000..<1_000_000:
            let k = value / 1_000
            return k < 10 ? String(format: "%.1fk", k) : String(format: "%.0fk", k)
        default:
            let m = value / 1_000_000
            return m < 10 ? String(format: "%.1fM", m) : String(format: "%.0fM", m)
        }
    }

    /// A ratio as a multiple of the forecast: 1.42 -> "1.4×", 0.5 -> "0.5×".
    ///
    /// Two significant-ish digits under 10 and none above: past ten times the
    /// forecast the decimal is noise, and the point is the order of magnitude.
    static func multiple(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return abs(value) < 10
            ? String(format: "%.1f×", value)
            : String(format: "%.0f×", value)
    }

    static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%.0f%%", value * 100)
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return iso.date(from: raw) ?? isoPlain.date(from: raw)
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    /// "4m ago", or "never" when the timestamp is missing/unparseable.
    static func relativeTime(_ raw: String?) -> String {
        guard let d = date(raw) else { return "never" }
        return relative.localizedString(for: d, relativeTo: Date())
    }
}
