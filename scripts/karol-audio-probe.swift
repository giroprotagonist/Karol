#!/usr/bin/swift
// CoreAudio probe for Karol show-night audio verification (JSON output).
import Foundation
import CoreAudio

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

func getAllDevices() -> [AudioDeviceID] {
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

func inputChannels(_ deviceID: AudioDeviceID) -> UInt32 {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr else { return 0 }
    let buf = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, buf) == noErr else { return 0 }
    let abl = UnsafeMutableAudioBufferListPointer(buf)
    return UInt32(abl.reduce(0) { $0 + Int($1.mNumberChannels) })
}

func aggregateSubDevices(_ deviceID: AudioDeviceID) -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioAggregateDevicePropertyActiveSubDeviceList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var subIDs = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &subIDs) == noErr else { return [] }
    return subIDs
}

func outputChannels(_ deviceID: AudioDeviceID) -> UInt32 {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr else { return 0 }
    let buf = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, buf) == noErr else { return 0 }
    let abl = UnsafeMutableAudioBufferListPointer(buf)
    return UInt32(abl.reduce(0) { $0 + Int($1.mNumberChannels) })
}

func aggregateClock(_ deviceID: AudioDeviceID) -> String? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioAggregateDevicePropertyClockDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var clockID: AudioDeviceID = 0
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &clockID) == noErr else { return nil }
    return getDeviceName(clockID)
}

func findDevice(_ name: String) -> AudioDeviceID? {
    getAllDevices().first { getDeviceName($0) == name }
}

struct AggregateProbe: Codable {
    let name: String
    let inputChannels: Int?
    let outputChannels: Int?
    let sampleRate: Int?
    let clock: String?
    let subs: [String]?
    let hasShure: Bool?
    let hasTV: Bool?
    let shureDrift: Bool?
    let shureOutputs: Int?
}

struct ProbeResult: Codable {
    let blackholeRate: Int?
    let tvRate: Int?
    let shureRate: Int?
    let shureCanSet44100: Bool
    let aggregateRate: Int?
    let aggregateInputChannels: Int?
    let aggregateOutputChannels: Int?
    let aggregateClock: String?
    let aggregateSubs: [String]?
    let shureDriftCorrection: Bool?
    let shureOutputsInAggregate: Int?
    let karolLiveMic: AggregateProbe?
    let allAggregates: [AggregateProbe]?
    let recommendedInputDevice: String?
}

func readAggregateMeta(_ aggName: String) -> (drift: Bool?, shureOut: Int?, hasShure: Bool, hasTV: Bool, subs: [String]) {
    let path = "/Library/Preferences/Audio/com.apple.audio.SystemSettings.plist"
    guard let data = NSDictionary(contentsOfFile: path) as? [String: Any] else { return (nil, nil, false, false, []) }
    let meta = data.first { key, val in
        key.hasPrefix("MetaDevice.") && (val as? [String: Any])?["name"] as? String == aggName
    }?.value as? [String: Any]
    guard let subs = meta?["subdevices"] as? [[String: Any]] else { return (nil, nil, false, false, []) }
    let names = subs.compactMap { $0["name"] as? String }
    let shure = subs.first { ($0["name"] as? String)?.contains("Shure") == true }
    let drift = (shure?["drift"] as? Int).map { $0 != 0 }
    let shureOut = shure?["channels-out"] as? Int
    let hasShure = names.contains { $0.contains("Shure") }
    let hasTV = names.contains { $0.contains("Living room") || $0.contains("TV") }
    return (drift, shureOut, hasShure, hasTV, names)
}

func probeAggregate(_ name: String) -> AggregateProbe? {
    guard let id = findDevice(name) else { return nil }
    let meta = readAggregateMeta(name)
    let subs = aggregateSubDevices(id).compactMap { getDeviceName($0) }
    let subNames = subs.isEmpty ? meta.subs : subs
    return AggregateProbe(
        name: name,
        inputChannels: Int(inputChannels(id)),
        outputChannels: Int(outputChannels(id)),
        sampleRate: readSampleRate(id).map { Int($0) },
        clock: aggregateClock(id),
        subs: subNames,
        hasShure: meta.hasShure || subNames.contains { $0.contains("Shure") },
        hasTV: meta.hasTV || subNames.contains { $0.contains("Living room") || $0.contains("TV") },
        shureDrift: meta.drift,
        shureOutputs: meta.shureOut
    )
}

func listAggregateNames() -> [String] {
    getAllDevices().compactMap { id -> String? in
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyClass,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var cls: AudioClassID = 0
        var size = UInt32(MemoryLayout<AudioClassID>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &cls) == noErr,
              cls == kAudioAggregateDeviceClassID else { return nil }
        return getDeviceName(id)
    }
}

let targetRate: Float64 = 44100
var shureCan44100 = false
if let shureID = getAllDevices().first(where: { getDeviceName($0)?.contains("Shure") == true }) {
    let before = readSampleRate(shureID) ?? 0
    let st = setSampleRate(shureID, rate: targetRate)
    let after = readSampleRate(shureID) ?? 0
    shureCan44100 = (st == noErr && abs(after - targetRate) < 1)
    if abs(before - 48000) < 1 || before > 0 {
        _ = setSampleRate(shureID, rate: 48000)
    }
}

let bhRate = findDevice("BlackHole 2ch").flatMap { readSampleRate($0).map { Int($0) } }
let tvRate = findDevice("Living room TV").flatMap { readSampleRate($0).map { Int($0) } }
let shureRate = getAllDevices().first(where: { getDeviceName($0)?.contains("Shure") == true })
    .flatMap { readSampleRate($0).map { Int($0) } }

let aggName = ProcessInfo.processInfo.environment["KAROL_AGGREGATE_NAME"] ?? "Aggregate Device"
let liveMicName = "Karol Live Mic"

var aggRate: Int?
var aggIn: Int?
var aggOut: Int?
var aggClock: String?
var aggSubs: [String]?
if let aggID = findDevice(aggName) {
    aggRate = readSampleRate(aggID).map { Int($0) }
    aggIn = Int(inputChannels(aggID))
    aggOut = Int(outputChannels(aggID))
    aggClock = aggregateClock(aggID)
    aggSubs = aggregateSubDevices(aggID).compactMap { getDeviceName($0) }
}

let meta = readAggregateMeta(aggName)
let karolLiveMic = probeAggregate(liveMicName)
let allAggs = listAggregateNames().compactMap { probeAggregate($0) }

var recommended = aggName
if let klm = karolLiveMic, (klm.inputChannels ?? 0) >= 3, klm.hasShure == true {
    recommended = liveMicName
} else if (aggIn ?? 0) < 3 || meta.hasShure == false {
    recommended = liveMicName
}

let result = ProbeResult(
    blackholeRate: bhRate,
    tvRate: tvRate,
    shureRate: shureRate,
    shureCanSet44100: shureCan44100,
    aggregateRate: aggRate,
    aggregateInputChannels: aggIn,
    aggregateOutputChannels: aggOut,
    aggregateClock: aggClock,
    aggregateSubs: aggSubs,
    shureDriftCorrection: meta.drift,
    shureOutputsInAggregate: meta.shureOut,
    karolLiveMic: karolLiveMic,
    allAggregates: allAggs,
    recommendedInputDevice: recommended
)

let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys]
if let data = try? enc.encode(result), let json = String(data: data, encoding: .utf8) {
    print(json)
}
