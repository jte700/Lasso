import Foundation
import AVFoundation
import Speech

// The words spoken in a video or audio file, with the time each is said,
// heard on this Mac by its own speech model. Nothing leaves the Mac: macOS
// downloads the language's model once, then recognises speech offline.
//
//   transcribe-video <input.mp4|mov|m4v|m4a> [locale]
//
// Prints one JSON object:
//   { "status": "ok", "locale": "en-US", "duration": 9.0,
//     "segments": [{ "start": 0, "end": 1.5, "text": "Welcome.",
//                    "words": [{ "text": "Welcome", "start": 0, "end": 0.6 }] }] }
// or { "status": "unsupported" | "no-audio" | "unreadable", "reason": "..." }.
// A file is read as the stream of audio its sound track holds, so any
// container AVFoundation opens is read: MPEG-4, QuickTime and M4V.

func emit(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"status\":\"unreadable\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

func problem(_ status: String, _ reason: String) -> Never {
    emit(["status": status, "reason": reason])
}

/// Seconds rounded to milliseconds, so the JSON stays short.
func seconds(_ time: CMTime) -> Double {
    guard time.isValid, time.isNumeric else { return 0 }
    return (time.seconds * 1000).rounded() / 1000
}

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: transcribe-video <file> [locale]\n".utf8))
    exit(2)
}
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let requestedLocale = CommandLine.arguments.count >= 3 ? Locale(identifier: CommandLine.arguments[2]) : Locale.current

@available(macOS 26.0, *)
func transcribe() async {
    let audio: AVAudioFile
    do {
        audio = try AVAudioFile(forReading: input)
    } catch {
        problem("no-audio", "This video has no sound track that could be read.")
    }
    let duration = audio.processingFormat.sampleRate > 0
        ? Double(audio.length) / audio.processingFormat.sampleRate : 0
    let fallback = Locale(identifier: "en-US")
    let matched = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale)
    let english = await SpeechTranscriber.supportedLocale(equivalentTo: fallback)
    guard let locale = matched ?? english else {
        problem("unsupported", "This Mac has no speech model for the video's language.")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [],
                                        attributeOptions: [.audioTimeRange])
    do {
        // The first video in a language fetches that language's model from Apple; speech is never sent.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    } catch {
        problem("unsupported", "The speech model for \(locale.identifier) could not be installed.")
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collected = Task { () -> [[String: Any]] in
        var segments: [[String: Any]] = []
        for try await result in transcriber.results {
            var words: [[String: Any]] = []
            for run in result.text.runs {
                guard let range = run.audioTimeRange else { continue }
                let text = String(result.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { continue }
                words.append(["text": text, "start": seconds(range.start), "end": seconds(range.end)])
            }
            let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            segments.append(["start": seconds(result.range.start), "end": seconds(result.range.end),
                             "text": text, "words": words])
        }
        return segments
    }
    do {
        if let last = try await analyzer.analyzeSequence(from: audio) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        let segments = try await collected.value
        emit(["status": "ok", "locale": locale.identifier(.bcp47), "duration": (duration * 1000).rounded() / 1000,
              "segments": segments])
    } catch {
        problem("unreadable", "The video's sound could not be transcribed.")
    }
}

guard FileManager.default.isReadableFile(atPath: input.path) else {
    problem("unreadable", "The video could not be read.")
}
if #available(macOS 26.0, *) {
    Task {
        await transcribe()
    }
    dispatchMain()
} else {
    problem("unsupported", "Video transcripts need macOS 26 or later.")
}
