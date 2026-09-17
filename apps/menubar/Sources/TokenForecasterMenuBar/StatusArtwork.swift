import AppKit

/// Template artwork for the status item.
///
/// Everything here is shape, never colour. The menu bar renders a template
/// image in the system's own foreground colour, so hue is not ours to spend:
/// the three faces have to be told apart by a colourblind user and in a
/// grayscale screenshot, and they are — the mouth curves up, runs flat, or
/// curves down. The same state is repeated in the tooltip and in the first row
/// of the menu, so nothing depends on reading a 13pt glyph at all.
enum StatusArtwork {

    /// How the turn is tracking against the forecast.
    enum Face {
        case happy      // at or under P50
        case neutral    // between P50 and P90
        case sad        // past P90
    }

    private static let height: CGFloat = 16
    private static let barWidth: CGFloat = 22
    private static let barHeight: CGFloat = 8
    private static let faceSize: CGFloat = 13
    private static let gap: CGFloat = 3

    /// The usage bar, optionally preceded by a face.
    ///
    /// `fill` is 0…1 on the daemon's curve — half width at P50, full at P90 —
    /// so the bar in the menu bar and the bar in the status line are the same
    /// measurement rendered twice. `generic` dashes the outline, because a
    /// number from the bundled profile must never pass as a personal one.
    static func meter(fill: Double, face: Face?, generic: Bool) -> NSImage {
        let faceWidth = face == nil ? 0 : faceSize + gap
        let size = NSSize(width: faceWidth + barWidth, height: height)
        let image = NSImage(size: size, flipped: false) { _ in
            if let face {
                drawFace(face, generic: generic,
                         in: NSRect(x: 0, y: (height - faceSize) / 2,
                                    width: faceSize, height: faceSize))
            }
            drawBar(fill: fill, generic: generic,
                    in: NSRect(x: faceWidth, y: (height - barHeight) / 2,
                               width: barWidth, height: barHeight))
            return true
        }
        image.isTemplate = true
        return image
    }

    /// The face on its own, for when a number is shown beside it and there is
    /// no room for the bar as well.
    static func face(_ face: Face, generic: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: faceSize, height: height), flipped: false) { _ in
            drawFace(face, generic: generic,
                     in: NSRect(x: 0, y: (height - faceSize) / 2,
                                width: faceSize, height: faceSize))
            return true
        }
        image.isTemplate = true
        return image
    }

    /// Menu-bar sized template symbol, with fallbacks for older systems.
    static func symbol(_ names: [String]) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        for name in names {
            if let image = NSImage(systemSymbolName: name, accessibilityDescription: "Token Forecaster") {
                let configured = image.withSymbolConfiguration(config) ?? image
                configured.isTemplate = true
                return configured
            }
        }
        return nil
    }

    // MARK: - Accuracy chart

    /// One finished turn, as the chart needs it.
    struct AccuracyBar {
        /// Actual output over the forecast P50 it was given.
        let ratio: Double
        /// "under" | "near" | "over".
        let verdict: String
        /// P90 over P50 for that same turn, or nil when it had none.
        let bandRatio: Double?
        /// True when the forecast came from the bundled generic profile.
        let generic: Bool
    }

    private static let chartSize = NSSize(width: 244, height: 84)

    /// Decades either side of the forecast that the y axis covers.
    private static let chartSpan = 1.0

    /// Ticks on the y axis, as multiples of the forecast median.
    private static let chartTicks: [(ratio: Double, label: String)] = [
        (10, "10×"), (3, "3×"), (1, "1×"), (1.0 / 3, "0.3×"), (0.1, "0.1×"),
    ]

    /// A bar per finished turn, plotted against the forecast it was given.
    ///
    /// The y axis is log-scaled and clamped to a tenth-to-ten-times window,
    /// because the interesting question is "how far off, in orders of
    /// magnitude" and a linear axis lets one runaway turn flatten every other
    /// bar to nothing. It is labelled in multiples of the forecast: `1×` is the
    /// forecast median itself, and a bar's height is how many times over or
    /// under it the turn came in.
    ///
    /// Two lines cross the plot. `P90` is the ceiling only one turn in ten
    /// should pass. `med` is the middle of these very bars — the answer to the
    /// question the shape poses: consistently high, consistently low, or noise
    /// around the forecast.
    ///
    /// Bars pegged at the top or bottom of the window end in a chevron, so a
    /// turn twenty times its forecast cannot be read as one that was merely ten.
    ///
    /// Not a template image — this one is read for its colour, and each bar's
    /// hue repeats the verdict already shown as a face in the bar.
    static func accuracyChart(_ bars: [AccuracyBar],
                              medianRatio: Double? = nil,
                              appearance: NSAppearance? = nil) -> NSImage? {
        guard !bars.isEmpty else { return nil }
        let size = chartSize
        // A drawing handler runs whenever AppKit decides to, and outside a
        // view the semantic colours resolve against no appearance at all —
        // `secondaryLabelColor` comes back white, so the guide lines vanish on
        // a light menu. Resolving against a captured appearance is what keeps
        // the chart legible in both themes.
        let theme = appearance ?? NSApp?.effectiveAppearance ?? NSAppearance(named: .aqua)
        let image = NSImage(size: size, flipped: false) { _ in
            theme?.performAsCurrentDrawingAppearance { draw(bars, median: medianRatio, in: size) }
            return true
        }
        image.isTemplate = false
        return image
    }

    /// Axis furniture, small and quiet: it must never outweigh the bars.
    private static func label(_ text: String, at point: NSPoint,
                              align: NSTextAlignment = .left,
                              colour: NSColor = .tertiaryLabelColor,
                              bold: Bool = false) {
        let font = NSFont.systemFont(ofSize: 8, weight: bold ? .semibold : .regular)
        let attributed = NSAttributedString(
            string: text, attributes: [.font: font, .foregroundColor: colour])
        let width = attributed.size().width
        let x: CGFloat
        switch align {
        case .right:  x = point.x - width
        case .center: x = point.x - width / 2
        default:      x = point.x
        }
        attributed.draw(at: NSPoint(x: x, y: point.y))
    }

    private static func draw(_ bars: [AccuracyBar], median: Double?, in size: NSSize) {
        // Left gutter for the tick labels; right strip for the two line labels,
        // which no bar is allowed to run under.
        let plot = NSRect(x: 26, y: 8, width: size.width - 34, height: size.height - 16)
        let barArea = plot.divided(atDistance: 32, from: .maxXEdge).remainder
        let mid = plot.midY
        let span = chartSpan
        let y = { (ratio: Double) -> CGFloat in
            let l = max(-span, min(span, log10(max(ratio, 0.0001))))
            return mid + CGFloat(l / span) * (plot.height / 2)
        }

        // The axis: gridline and label per tick, the forecast line solid and
        // the rest hairlines, so the scale is readable without competing with
        // the bars.
        for tick in chartTicks {
            let level = y(tick.ratio)
            let line = NSBezierPath()
            line.move(to: NSPoint(x: plot.minX, y: level))
            line.line(to: NSPoint(x: plot.maxX, y: level))
            let forecast = tick.ratio == 1
            line.lineWidth = forecast ? 1 : 0.5
            (forecast ? NSColor.secondaryLabelColor : NSColor.quaternaryLabelColor).setStroke()
            line.stroke()
            label(tick.label, at: NSPoint(x: plot.minX - 5, y: level - 4), align: .right,
                  colour: forecast ? .secondaryLabelColor : .tertiaryLabelColor,
                  bold: forecast)
        }

        // P90: the ceiling only one turn in ten is supposed to cross, so bars
        // poking above it are the ones worth noticing. A line rather than a
        // shaded band — shading from the forecast up would say a small turn is
        // out of band, and shading from the floor up buries the bars.
        let bands = bars.compactMap(\.bandRatio).sorted()
        if let band = bands.isEmpty ? nil : bands[bands.count / 2] {
            let dotted = NSBezierPath()
            dotted.move(to: NSPoint(x: plot.minX, y: y(band)))
            dotted.line(to: NSPoint(x: plot.maxX, y: y(band)))
            dotted.lineWidth = 1
            dotted.setLineDash([2, 3], count: 2, phase: 0)
            NSColor.tertiaryLabelColor.setStroke()
            dotted.stroke()
            label("P90", at: NSPoint(x: plot.maxX, y: y(band) + 2), align: .right)
        }

        let slot = barArea.width / CGFloat(bars.count)
        let width = max(2, min(10, slot - 2))
        for (index, bar) in bars.enumerated() {
            let colour: NSColor
            switch bar.verdict {
            case "over":  colour = .systemRed
            case "near":  colour = .systemOrange
            default:      colour = .systemGreen
            }
            // A generic forecast is never dressed up as a personal one:
            // here that is a washed-out bar rather than a dashed outline,
            // which is unreadable at four points wide.
            colour.withAlphaComponent(bar.generic ? 0.35 : 0.9).setFill()
            let top = y(bar.ratio)
            let x = barArea.minX + slot * CGFloat(index) + (slot - width) / 2
            // Always at least a sliver, so a turn that landed exactly on the
            // forecast is still visibly a turn.
            let height = max(1.5, abs(top - mid))
            NSRect(x: x, y: min(mid, top), width: width, height: height).fill()

            // Pegged at the end of the scale: say so, rather than letting 10×
            // and 100× draw the same bar.
            if abs(log10(max(bar.ratio, 0.0001))) > span {
                let up = bar.ratio > 1
                let chevron = NSBezierPath()
                chevron.move(to: NSPoint(x: x, y: up ? plot.maxY : plot.minY))
                chevron.line(to: NSPoint(x: x + width / 2, y: up ? plot.maxY + 3 : plot.minY - 3))
                chevron.line(to: NSPoint(x: x + width, y: up ? plot.maxY : plot.minY))
                chevron.close()
                chevron.fill()
            }
        }

        // The median of the bars on screen: which way the forecast leans.
        if let median, median.isFinite, median > 0, bars.count >= 4 {
            let level = y(median)
            let line = NSBezierPath()
            line.move(to: NSPoint(x: plot.minX, y: level))
            line.line(to: NSPoint(x: plot.maxX, y: level))
            line.lineWidth = 1.5
            NSColor.controlAccentColor.withAlphaComponent(0.85).setStroke()
            line.stroke()
            // Above its own line when the forecast runs low, below when it runs
            // high, so the label never lands on the forecast line it is being
            // read against.
            label("med \(Fmt.multiple(median))",
                  at: NSPoint(x: plot.maxX, y: median >= 1 ? level + 2 : level - 10),
                  align: .right, colour: .controlAccentColor, bold: true)
        }
    }

    // MARK: - Drawing

    private static func drawBar(fill: Double, generic: Bool, in rect: NSRect) {
        NSColor.black.setStroke()
        NSColor.black.setFill()

        let body = rect.insetBy(dx: 0.5, dy: 0.5)
        let outline = NSBezierPath(roundedRect: body,
                                   xRadius: body.height / 2, yRadius: body.height / 2)
        outline.lineWidth = 1
        // A dashed track is the shape-only way to say "this is the generic
        // profile", readable without colour and without reading the tooltip.
        if generic { outline.setLineDash([2, 2], count: 2, phase: 0) }
        outline.stroke()

        let clamped = max(0, min(1, fill))
        if clamped > 0 {
            let track = rect.insetBy(dx: 2, dy: 2)
            var filled = track
            filled.size.width = max(track.height, track.width * clamped)
            let radius = min(filled.height, filled.width) / 2
            NSBezierPath(roundedRect: filled, xRadius: radius, yRadius: radius).fill()
        }

        // The P50 mark, punched clear through both track and fill so it reads
        // whether or not the bar has reached it yet.
        NSRect(x: rect.midX - 0.5, y: rect.minY - 1, width: 1, height: rect.height + 2)
            .fill(using: .clear)
    }

    private static func drawFace(_ face: Face, generic: Bool, in rect: NSRect) {
        NSColor.black.setStroke()
        NSColor.black.setFill()

        let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1))
        ring.lineWidth = 1.2
        // Dashed means the same thing everywhere: these are the bundled
        // generic numbers, not yours.
        if generic { ring.setLineDash([2, 2], count: 2, phase: 0) }
        ring.stroke()

        let eyeY = rect.midY + 1.9
        let eyeR: CGFloat = 0.85
        for dx in [-2.4 as CGFloat, 2.4] {
            NSBezierPath(ovalIn: NSRect(x: rect.midX + dx - eyeR, y: eyeY - eyeR,
                                        width: eyeR * 2, height: eyeR * 2)).fill()
        }

        let mouth = NSBezierPath()
        mouth.lineWidth = 1.2
        mouth.lineCapStyle = .round
        let mouthY = rect.midY - 1.6
        switch face {
        case .happy:
            // Centre above the mouth, so the drawn arc is the bottom of the
            // circle: a curve that opens upward.
            mouth.appendArc(withCenter: NSPoint(x: rect.midX, y: mouthY + 1.4),
                            radius: 3.1, startAngle: 205, endAngle: 335)
        case .neutral:
            mouth.move(to: NSPoint(x: rect.midX - 2.6, y: mouthY))
            mouth.line(to: NSPoint(x: rect.midX + 2.6, y: mouthY))
        case .sad:
            // Centre below the mouth: the top of the circle, curving down.
            mouth.appendArc(withCenter: NSPoint(x: rect.midX, y: mouthY - 2.6),
                            radius: 3.1, startAngle: 25, endAngle: 155)
        }
        mouth.stroke()
    }
}
