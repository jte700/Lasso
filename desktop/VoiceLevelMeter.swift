// How loud the writer's voice is, for the dictation pill's waves. It runs
// only while the pill is up, that is while dictation is on, and keeps only
// the loudness of each moment for as long as it takes to draw it: no sound
// is recorded, stored or sent, and recognising speech is left to the
// dictation tool. macOS asks once for the microphone; without it the pill
// shows waves that do not follow the voice.
//
// It stays out of Dictation's way. A Bluetooth headset changes how it
// works when a second app opens its microphone, and Dictation starting at
// that moment hears nothing, so the meter listens through the Mac's own
// microphone and never a headset, never opens a speaker, and starts a
// moment after Dictation has taken the microphone.

import AVFoundation
import AudioToolbox
import CoreAudio

final class VoiceLevelMeter {
    /// Loudness readings from 0 to 1, a slice of about 21 ms each. Main thread.
    var onLevels: (([CGFloat]) -> Void)?
    /// Lasso's own reading of the input started or stopped. The dictation
    /// watch, which treats a running input as another app dictating, needs
    /// to know which running input is Lasso's. Main thread.
    var onCaptureChange: ((Bool) -> Void)?
    /// The pill wants the waves, whether or not the microphone may be read.
    private(set) var isWanted = false
    /// Readings are arriving.
    private(set) var isHearing = false

    /// Dictation takes the microphone as the shortcut is pressed; the meter follows after.
    static let startDelay: TimeInterval = 0.6
    /// Readings per second, two for each bar of the waves.
    static let readingsPerSecond: Double = 48
    private static let sampleRate: Double = 24_000

    private var queue: AudioQueueRef?
    private var readings: Timer?
    private var pendingStart: DispatchWorkItem?

    func start() {
        guard !isWanted else { return }
        isWanted = true
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            startSoon()
        case .notDetermined:
            dictationLog.debug("asking for the microphone, for the waves")
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self, granted, self.isWanted else { return }
                    self.startSoon()
                }
            }
        default:
            dictationLog.debug("waves without the microphone: not allowed")
        }
    }

    func stop() {
        isWanted = false
        pendingStart?.cancel()
        pendingStart = nil
        end()
    }

    private func startSoon() {
        pendingStart?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingStart = nil
            if self.isWanted { self.begin() }
        }
        pendingStart = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.startDelay, execute: work)
    }

    private func begin() {
        guard queue == nil else { return }
        let inputs = Self.inputDevices()
        guard let uid = MeterInput.choose(inputs, defaultInput: Self.defaultInputUID()) else {
            dictationLog.debug("waves without the microphone: only a headset to listen through")
            return
        }
        var format = AudioStreamBasicDescription(
            mSampleRate: Self.sampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var created: AudioQueueRef?
        // The sound itself is handed straight back unread; only the queue's meter is used.
        let made = AudioQueueNewInput(&format, { _, queue, buffer, _, _, _ in
            AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
        }, nil, nil, nil, 0, &created)
        guard made == noErr, let created else {
            dictationLog.debug("waves without the microphone: the input did not open")
            return
        }
        var device = uid as CFString
        var metering: UInt32 = 1
        let frames = UInt32(Self.sampleRate / Self.readingsPerSecond)
        guard AudioQueueSetProperty(created, kAudioQueueProperty_CurrentDevice, &device,
                                    UInt32(MemoryLayout<CFString>.size)) == noErr,
              AudioQueueSetProperty(created, kAudioQueueProperty_EnableLevelMetering, &metering,
                                    UInt32(MemoryLayout<UInt32>.size)) == noErr else {
            AudioQueueDispose(created, true)
            return
        }
        for _ in 0..<3 {
            var buffer: AudioQueueBufferRef?
            if AudioQueueAllocateBuffer(created, frames * 4, &buffer) == noErr, let buffer {
                AudioQueueEnqueueBuffer(created, buffer, 0, nil)
            }
        }
        // Said before the input runs, so the watch never takes it for dictation.
        onCaptureChange?(true)
        guard AudioQueueStart(created, nil) == noErr else {
            AudioQueueDispose(created, true)
            onCaptureChange?(false)
            dictationLog.debug("waves without the microphone: the input did not start")
            return
        }
        queue = created
        isHearing = true
        let timer = Timer(timeInterval: 1 / Self.readingsPerSecond, repeats: true) { [weak self] _ in self?.read() }
        RunLoop.main.add(timer, forMode: .common)
        readings = timer
    }

    private func read() {
        guard let queue else { return }
        var meter = AudioQueueLevelMeterState()
        var size = UInt32(MemoryLayout<AudioQueueLevelMeterState>.size)
        guard AudioQueueGetProperty(queue, kAudioQueueProperty_CurrentLevelMeter, &meter, &size) == noErr else { return }
        onLevels?([VoiceLevel.normalized(rms: meter.mAveragePower)])
    }

    private func end() {
        readings?.invalidate()
        readings = nil
        guard let queue else { return }
        AudioQueueStop(queue, true)
        AudioQueueDispose(queue, true)
        self.queue = nil
        isHearing = false
        onCaptureChange?(false)
    }

    // MARK: Devices

    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func inputDevices() -> [MeterInput] {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var devices = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &devices, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &devices, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            var streams = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput)
            var streamSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0,
                  let uid = uid(of: id) else { return nil }
            var transportAddress = address(kAudioDevicePropertyTransportType)
            var transport: UInt32 = 0
            var transportSize = UInt32(MemoryLayout<UInt32>.size)
            _ = AudioObjectGetPropertyData(id, &transportAddress, 0, nil, &transportSize, &transport)
            return MeterInput(uid: uid, transport: transport)
        }
    }

    private static func defaultInputUID() -> String? {
        var address = address(kAudioHardwarePropertyDefaultInputDevice)
        var id = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else { return nil }
        return uid(of: id)
    }

    private static func uid(of device: AudioObjectID) -> String? {
        var address = address(kAudioDevicePropertyDeviceUID)
        var uid: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid) == noErr, let uid else { return nil }
        return uid.takeRetainedValue() as String
    }
}
