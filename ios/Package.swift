// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "StarpostCore",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "StarpostCore", targets: ["StarpostCore"])],
    targets: [
        .target(name: "StarpostCore", path: "Starpost/Core"),
        .testTarget(name: "StarpostCoreTests", dependencies: ["StarpostCore"], path: "Tests")
    ]
)
