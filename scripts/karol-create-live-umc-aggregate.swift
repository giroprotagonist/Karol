#!/usr/bin/swift
// Create Karol Live Mic: BlackHole ch1-2 (Karol) + UMC404HD ch3-6 (mic) @ 48000.
// umc-pa Live-mix path. Clock = UMC (lowest mic latency); BlackHole drift ON.
// channels-out:0 on UMC is requested here but CoreAudio often ignores it —
// always finish with: sudo python3 scripts/karol-fix-plist-aggregate.py
import Foundation
import CoreAudio

let aggName = ProcessInfo.processInfo.environment["KAROL_AGGREGATE_NAME"] ?? "Karol Live Mic"
let aggUID = ProcessInfo.processInfo.environment["KAROL_AGGREGATE_UID"] ?? "com.karol.live-mic-aggregate"
let bhName = ProcessInfo.processInfo.environment["KAROL_BLACKHOLE_NAME"] ?? "BlackHole 2ch"
let umcName = ProcessInfo.processInfo.environment["KAROL_UMC_NAME"] ?? "UMC404HD 192k"

func err(_ status: OSStatus) -> String { status == noErr ? "ok" : "OSStatus \(status)" }

func getDeviceName(_ id: AudioDeviceID) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr,
          let cf = name?.takeRetainedValue() else { return nil }
    return cf as String
}

func getDeviceUID(_ id: AudioDeviceID) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var uid: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &uid) == noErr,
          let cf = uid?.takeRetainedValue() else { return nil }
    return cf as String
}

func allDevices() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func findByName(_ name: String) -> AudioDeviceID? {
    allDevices().first { getDeviceName($0) == name }
}

func findUmc() -> AudioDeviceID? {
    allDevices().first { getDeviceName($0)?.contains("UMC404") == true }
}

func isAggregate(_ id: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyClass,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var cls: AudioClassID = 0
    var size = UInt32(MemoryLayout<AudioClassID>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &cls) == noErr else { return false }
    return cls == kAudioAggregateDeviceClassID
}

func destroyAggregate(_ id: AudioDeviceID) -> OSStatus {
    AudioHardwareDestroyAggregateDevice(id)
}

func inputChannels(_ id: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr else { return 0 }
    let buf = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, buf) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(buf).reduce(0) { $0 + Int($1.mNumberChannels) }
}

func outputChannels(_ id: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr else { return 0 }
    let buf = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, buf) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(buf).reduce(0) { $0 + Int($1.mNumberChannels) }
}

guard let bhUID = findByName(bhName).flatMap({ getDeviceUID($0) }) else {
    fputs("ERROR: \(bhName) not found\n", stderr)
    exit(1)
}
guard let umcID = findByName(umcName) ?? findUmc(),
      let umcUID = getDeviceUID(umcID),
      let umcLabel = getDeviceName(umcID) else {
    fputs("ERROR: UMC404HD not found — plug in \(umcName)\n", stderr)
    exit(1)
}

for staleName in [aggName, "Karol Mic Ch1", "Aggregate Device"] {
    if let existing = findByName(staleName), isAggregate(existing) {
        let st = destroyAggregate(existing)
        if st == noErr {
            print("Removed stale \(staleName)")
        }
    }
}
Thread.sleep(forTimeInterval: 0.5)

// BlackHole FIRST → ch1-2 Karol (drift ON). UMC SECOND → ch3-6 mic, no outs (clock).
let subDevices: [[String: Any]] = [
    [
        kAudioSubDeviceUIDKey as String: bhUID,
        "channels-in": 2,
        "channels-out": 2,
        kAudioSubDeviceDriftCompensationKey as String: true,
    ],
    [
        kAudioSubDeviceUIDKey as String: umcUID,
        "channels-in": 4,
        "channels-out": 0,
        kAudioSubDeviceDriftCompensationKey as String: false,
    ],
]

let desc: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: aggName,
    kAudioAggregateDeviceUIDKey as String: aggUID,
    kAudioAggregateDeviceSubDeviceListKey as String: subDevices,
    kAudioAggregateDeviceMasterSubDeviceKey as String: umcUID,
    kAudioAggregateDeviceClockDeviceKey as String: umcUID,
]

var newID: AudioDeviceID = 0
let st = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &newID)
if st != noErr {
    fputs("ERROR: AudioHardwareCreateAggregateDevice failed: \(err(st))\n", stderr)
    fputs("  Run: sudo python3 scripts/karol-fix-plist-aggregate.py\n", stderr)
    exit(2)
}

Thread.sleep(forTimeInterval: 0.3)
let ins = inputChannels(newID)
let outs = outputChannels(newID)
print("Created \(aggName) (id=\(newID)): \(ins) in, \(outs) out")
print("  Clock: \(umcLabel)")
print("  ch1-2: \(bhName) (Karol stereo, drift ON)")
print("  ch3-6: \(umcLabel) (mic inputs, no outs — run plist fix if outs != 2)")

if ins != 6 || outs != 2 {
    fputs("WARN: expected 6 in / 2 out — got \(ins) in / \(outs) out\n", stderr)
    fputs("  Open Audio MIDI Setup → Karol Live Mic → uncheck UMC outputs + Offline Device\n", stderr)
    exit(3)
}

exit(0)
