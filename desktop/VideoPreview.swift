//  A video source as the card shows it: the file on this Mac, and the moment
//  the quoted words are said, which the card's player and Open file start at.

import Foundation

struct AssistVideoPreview: Equatable {
    /// The video in its folder on this Mac.
    let fileURL: URL
    /// Seconds into the video where the quoted words begin.
    let startTime: Double
    let duration: Double?

    /// Longer than any video a folder holds: a day.
    static let maximumTime: Double = 86_400

    /// Reads the server's video preview; nil for any other kind or a malformed one.
    init?(json: Any?) {
        guard let json = json as? [String: Any], json["kind"] as? String == "video",
              let path = json["localPath"] as? String, path.hasPrefix("/"),
              let start = Self.seconds(json["startTime"]) else { return nil }
        fileURL = URL(fileURLWithPath: path)
        startTime = start
        duration = Self.seconds(json["duration"])
    }

    /// A finite, non-negative number of seconds within a day; booleans and strings are not times.
    static func seconds(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let seconds = number.doubleValue
        return seconds.isFinite && seconds >= 0 && seconds <= maximumTime ? seconds : nil
    }
}

enum AssistVideoTime {
    /// A time as a player shows it: 0:02, 12:40, 1:02:03.
    static func label(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        let hours = whole / 3600, minutes = (whole % 3600) / 60, rest = whole % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }

    /// Whole milliseconds, which an AppleScript reads the same in every language.
    static func milliseconds(_ seconds: Double) -> String {
        String(Int((max(0, seconds) * 1000).rounded()))
    }
}
