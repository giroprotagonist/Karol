#!/usr/bin/swift
// Set BlackHole 2ch nominal sample rate to 44100 Hz (matches AirPlay TV).
import Foundation
import CoreAudio

let targetName = "BlackHole 2ch"
let targetRate: Float64 = 44100

func audioErr(_ status: OSStatus) -> String {
    if status == noErr { return "ok" }
    return "OSStatus \(status)"
}

func getDeviceName(_ deviceID: AudioDeviceID) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let st = AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &name)
    guard st == noErr, let cf = name?.takeRetainedValue() else { return nil }
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
    for id in ids {
        if getDeviceName(id) == name { return id }
    }
    return nil
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

guard let deviceID = findDeviceID(targetName) else {
    fputs("ERROR: device not found: \(targetName)\n", stderr)
    exit(1)
}

let before = readSampleRate(deviceID) ?? -1
if abs(before - targetRate) < 1 {
    print("BlackHole 2ch already at \(Int(targetRate)) Hz")
    exit(0)
}

let st = setSampleRate(deviceID, rate: targetRate)
if st != noErr {
    fputs("ERROR: set sample rate failed: \(audioErr(st)) (was \(Int(before)) Hz)\n", stderr)
    exit(1)
}

let after = readSampleRate(deviceID) ?? -1
if abs(after - targetRate) >= 1 {
    fputs("ERROR: still at \(Int(after)) Hz — quit Ableton/apps using BlackHole and retry\n", stderr)
    exit(2)
}
print("BlackHole 2ch \(Int(before)) Hz → \(Int(after)) Hz")
