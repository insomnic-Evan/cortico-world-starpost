import Foundation

struct MobileRelease: Decodable, Identifiable {
    let platform: String
    let version: String
    let build: String
    let signed: Bool
    let minimumIOS: String
    let url: URL

    var id: String { build }
    static let directory = "https://8.137.59.209/downloads/ffa/apps/starpost/ios"
    static let manifest = URL(string: directory + "/latest.json")!

    func isAvailable(after currentBuild: Int, systemVersion: String) -> Bool {
        guard platform == "ios", !signed, let number = Int(build), number > currentBuild,
              StarpostIdentity.matches(version, #"^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$"#),
              StarpostIdentity.matches(minimumIOS, #"^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$"#),
              systemVersion.compare(minimumIOS, options: .numeric) != .orderedAscending else { return false }
        return url.absoluteString == Self.directory + "/\(version)/starpost-ios-\(version)-unsigned.ipa"
    }

    static func beijingDay(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(parts.year!)-\(parts.month!)-\(parts.day!)"
    }
}
