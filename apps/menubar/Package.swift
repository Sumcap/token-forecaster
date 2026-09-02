// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TokenForecasterMenuBar",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "TokenForecasterMenuBar",
            path: "Sources/TokenForecasterMenuBar"
        )
    ]
)
