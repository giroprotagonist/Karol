import CoreAudio
import AudioToolbox
import Foundation

// Find any BlackHole device and set its sample rate to 44100 Hz.
// The server calls this on startup to ensure BlackHole doesn't drift
// back to 48 kHz after reboot (which causes VLC audio glitching since
// the UMC404HD and all audio files are 44.1 kHz).

let targetRate: Float64 = 44100.0

var propertyAddress = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)

var dataSize: UInt32 = 0
var result = AudioObjectGetPropertyDataSize(
    AudioObjectID(kAudioObjectSystemObject),
    &propertyAddress, 0, nil, &dataSize
)
guard result == noErr else { print("Error getting device count: \(result)"); exit(1) }

let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)
result = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject),
    &propertyAddress, 0, nil, &dataSize, &deviceIDs
)
guard result == noErr else { print("Error getting device list: \(result)"); exit(1) }

for deviceID in deviceIDs {
    var nameProperty = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var nameSize = UInt32(MemoryLayout<CFString?>.size)
    var deviceName: CFString?
    result = AudioObjectGetPropertyData(deviceID, &nameProperty, 0, nil, &nameSize, &deviceName)
    guard result == noErr, let name = deviceName as String? else { continue }

    if name.contains("BlackHole") {
        var srProperty = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var currentRate: Float64 = 0
        var srSize = UInt32(MemoryLayout<Float64>.size)
        AudioObjectGetPropertyData(deviceID, &srProperty, 0, nil, &srSize, &currentRate)

        if currentRate == targetRate {
            print("BlackHole already at \(Int(targetRate)) Hz")
            exit(0)
        }

        var newRate = targetRate
        result = AudioObjectSetPropertyData(
            deviceID, &srProperty, 0, nil, UInt32(MemoryLayout<Float64>.size), &newRate
        )
        if result == noErr {
            print("BlackHole sample rate set to \(Int(targetRate)) Hz")
            exit(0)
        } else {
            print("Failed to set BlackHole sample rate: \(result)")
            exit(1)
        }
    }
}

print("BlackHole device not found")
exit(1)
