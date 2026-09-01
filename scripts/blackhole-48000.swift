#!/usr/bin/swift
// Set BlackHole 2ch nominal sample rate to 48000 Hz (laptop + UMC path).
import Foundation
import CoreAudio

let targetName = ProcessInfo.processInfo.environment["KAROL_BLACKHOLE_NAME"] ?? "BlackHole 2ch"
let targetRate: Float64 = 48000

func audioErr(_ status: OSStatus) -> String {
    status == noErr ? "ok" : "OSStatus \(status)"
}

func getDeviceName(_ deviceID: AudioDeviceID) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &name) == noErr,
          let cf = name?.takeRetainedValue() else { return nil }
    return cf as String
}

func findDeviceID(_ name: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
    return ids.first { getDeviceName($0) == name }
}

func findByPrefix(_ prefix: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
    return ids.first { getDeviceName($0)?.contains(prefix) == true }
}

func readSampleRate(_ deviceID: AudioDeviceID) -> Float64? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var rate: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &rate) == noErr else { return nil }
    return rate
}

func setSampleRate(_ deviceID: AudioDeviceID, rate: Float64) -> OSStatus {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var r = rate
    return AudioObjectSetPropertyData(deviceID, &addr, 0, nil, UInt32(MemoryLayout<Float64>.size), &r)
}

func align(_ label: String, _ id: AudioDeviceID) -> Bool {
    let before = readSampleRate(id) ?? -1
    if abs(before - targetRate) < 1 {
        print("\(label) already at \(Int(targetRate)) Hz")
        return true
    }
    let st = setSampleRate(id, rate: targetRate)
    if st != noErr {
        fputs("ERROR: \(label) set rate failed: \(audioErr(st)) (was \(Int(before)) Hz)\n", stderr)
        return false
    }
    let after = readSampleRate(id) ?? -1
    if abs(after - targetRate) >= 1 {
        fputs("ERROR: \(label) still at \(Int(after)) Hz — quit Ableton and retry\n", stderr)
        return false
    }
    print("\(label) \(Int(before)) Hz → \(Int(after)) Hz")
    return true
}

guard let bhID = findDeviceID(targetName) else {
    fputs("ERROR: device not found: \(targetName)\n", stderr)
    exit(1)
}
var ok = align(targetName, bhID)

if let umcID = findByPrefix("UMC404"), let umcName = getDeviceName(umcID) {
    ok = align(umcName, umcID) && ok
}

exit(ok ? 0 : 2)
