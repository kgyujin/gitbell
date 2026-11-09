// swift-tools-version: 5.10
// GitBell: GitHub 활동을 macOS 메뉴 막대에서 보여 주는 앱.
// GitBellCore는 UI 없는 로직(GitHub 읽기, 항목 만들기, 상태)이라 테스트하기 쉽게 따로 둔다.
import PackageDescription

let package = Package(
    name: "GitBell",
    defaultLocalization: "en",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "GitBell", targets: ["GitBell"]),
    ],
    targets: [
        .target(name: "GitBellCore"),
        .executableTarget(name: "GitBell", dependencies: ["GitBellCore"]),
        .testTarget(name: "GitBellCoreTests", dependencies: ["GitBellCore"]),
    ],
    swiftLanguageVersions: [.v5]
)
