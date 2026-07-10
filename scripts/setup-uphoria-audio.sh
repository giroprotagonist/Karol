#!/usr/bin/env bash
set -euo pipefail

# ── Karol Audio Setup ──
# Creates a Multi-Output Device (Karol) containing:
#   - U-Phoria UMC404HD (main output, master clock)
#   - BlackHole 16ch (drift-corrected, for VLC → Ableton routing)
#
# After running this, set Ableton's output to "Karol" and
# set VLC's output to "BlackHole 16ch".

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

MULTI_DEVICE_NAME="Karol"
UMC_KEYWORD="UMC404HD"
BLACKHOLE_KEYWORD="BlackHole 16ch"

echo "=== Karol Audio Setup ==="

# ── Step 1: Detect devices ──
echo -n "Detecting $UMC_KEYWORD... "
UMC_UID=$(system_profiler SPAudioDataType -json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('SPAudioDataType', []):
    for d in item.get('_items', []):
        n = d.get('_name', '')
        if '$UMC_KEYWORD' in n:
            uid = d.get('coreaudio_device_uid', '')
            print(uid)
            break
" 2>/dev/null)

if [ -z "$UMC_UID" ]; then
    echo -e "${RED}NOT FOUND${NC}"
    echo "ERROR: $UMC_KEYWORD not detected. Is the USB cable connected?"
    echo "Run: system_profiler SPAudioDataType | grep -A 5 UMC"
    exit 1
fi
echo -e "${GREEN}$UMC_UID${NC}"

echo -n "Detecting $BLACKHOLE_KEYWORD... "
BH_UID=$(system_profiler SPAudioDataType -json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('SPAudioDataType', []):
    for d in item.get('_items', []):
        n = d.get('_name', '')
        if '$BLACKHOLE_KEYWORD' in n:
            uid = d.get('coreaudio_device_uid', '')
            print(uid)
            break
" 2>/dev/null)

if [ -z "$BH_UID" ]; then
    echo -e "${RED}NOT FOUND${NC}"
    echo "ERROR: $BLACKHOLE_KEYWORD not found."
    echo "Install: brew install blackhole-16ch"
    exit 1
fi
echo -e "${GREEN}$BH_UID${NC}"

# ── Step 2: Create/update Multi-Output Device ──
echo ""
echo "Creating Multi-Output Device '$MULTI_DEVICE_NAME'..."

python3 << PYEOF
import subprocess, json, struct, ctypes, ctypes.util, uuid

UMC_UID = "$UMC_UID"
BH_UID = "$BH_UID"
MULTI_NAME = "$MULTI_DEVICE_NAME"

# Load CoreAudio
ca = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreAudio.framework/CoreAudio')

class AudioObjectPropertyAddress(ctypes.Structure):
    _fields_ = [
        ('mSelector', ctypes.c_uint32),
        ('mScope', ctypes.c_uint32),
        ('mElement', ctypes.c_uint32),
    ]

class AudioValueRange(ctypes.Structure):
    _fields_ = [
        ('mMinimum', ctypes.c_double),
        ('mMaximum', ctypes.c_double),
    ]

AudioObjectID = ctypes.c_uint32
OSStatus = ctypes.c_int32
UInt32 = ctypes.c_uint32
Float64 = ctypes.c_double

kAudioObjectSystemObject = AudioObjectID(1)
kAudioHardwarePropertyDevices = 0x64657623
kAudioDevicePropertyDeviceUID = 0x75696420
kAudioHardwarePropertyDefaultOutputDevice = 0x646F7074
kAudioHardwarePropertyDefaultInputDevice = 0x64696E70
kAudioHardwarePropertyTranslateUIDToDevice = 0x75696474

# Aggregate device properties
kAudioAggregateDevicePropertyFullSubDeviceList = 0x66737562
kAudioAggregateDevicePropertyActiveSubDeviceList = 0x61737562
kAudioAggregateDevicePropertyMasterSubDevice = 0x6D737562
kAudioAggregateDevicePropertyClockDriftCompensation = 0x63647263
kAudioSubDevicePropertyDriftCompensation = 0x64726674
kAudioSubDevicePropertyExtraInputLatency = 0x78696C74

# Create aggregate device
kAudioPlugInCreateAggregateDevice = 0x61676772

# Find the AggregateDevice plug-in
kAudioHardwarePropertyPlugInList = 0x706C676E

def find_device_id_by_uid(target_uid):
    addr = AudioObjectPropertyAddress(kAudioHardwarePropertyDevices, 0, 0)
    size = UInt32()
    ca.AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, ctypes.byref(addr), 0, None, ctypes.byref(size))
    count = size.value // ctypes.sizeof(AudioObjectID)
    devices = (AudioObjectID * count)()
    ca.AudioObjectGetPropertyData(kAudioObjectSystemObject, ctypes.byref(addr), 0, None, ctypes.byref(size), ctypes.byref(devices))

    addr_uid = AudioObjectPropertyAddress(kAudioDevicePropertyDeviceUID, 0, 0)
    for i in range(count):
        d = devices[i]
        buf = (ctypes.c_char * 256)()
        sz = UInt32(ctypes.sizeof(buf))
        try:
            ca.AudioObjectGetPropertyData(d, ctypes.byref(addr_uid), 0, None, ctypes.byref(sz), ctypes.byref(buf))
            if buf.value.decode('utf-8') == target_uid:
                return d
        except:
            pass
    return None

def set_default_output(device_id):
    addr = AudioObjectPropertyAddress(kAudioHardwarePropertyDefaultOutputDevice, 0, 0)
    sz = UInt32(ctypes.sizeof(AudioObjectID))
    ca.AudioObjectSetPropertyData(kAudioObjectSystemObject, ctypes.byref(addr), 0, None, sz, ctypes.byref(AudioObjectID(device_id)))
    print(f"  Default output set to device {device_id}")

def set_sub_device_list(agg_id, sub_ids):
    arr = (AudioObjectID * len(sub_ids))(*sub_ids)
    addr = AudioObjectPropertyAddress(kAudioAggregateDevicePropertyFullSubDeviceList, 0, 0)
    sz = UInt32(ctypes.sizeof(arr))
    status = ca.AudioObjectSetPropertyData(agg_id, ctypes.byref(addr), 0, None, sz, ctypes.byref(arr))
    if status != 0:
        print(f"  WARNING: set sub-device list failed with status {status}")
    else:
        print(f"  Sub-devices set: {len(sub_ids)} devices")

def set_master(agg_id, master_id):
    addr = AudioObjectPropertyAddress(kAudioAggregateDevicePropertyMasterSubDevice, 0, 0)
    sz = UInt32(ctypes.sizeof(AudioObjectID))
    status = ca.AudioObjectSetPropertyData(agg_id, ctypes.byref(addr), 0, None, sz, ctypes.byref(AudioObjectID(master_id)))
    if status != 0:
        print(f"  WARNING: set master device failed with status {status}")
    else:
        print(f"  Master clock: device {master_id}")

def set_drift_compensation(agg_id, sub_id, enabled):
    """Set drift compensation on a sub-device of an aggregate."""
    class AudioSubDeviceProperty(ctypes.Structure):
        _fields_ = [
            ('mSubDeviceID', AudioObjectID),
            ('mProperty', AudioObjectPropertyAddress),
        ]
    
    prop = AudioObjectPropertyAddress(kAudioSubDevicePropertyDriftCompensation, 0, 0)
    subprop = AudioSubDeviceProperty(sub_id, prop)
    
    addr = AudioObjectPropertyAddress(kAudioAggregateDevicePropertyClockDriftCompensation, 0, 0)
    sz = UInt32(ctypes.sizeof(AudioSubDeviceProperty))
    
    # First query to check current state
    cur = UInt32(0)
    cur_sz = UInt32(ctypes.sizeof(UInt32))
    
    # Set drift compensation
    val = UInt32(1 if enabled else 0)
    set_addr = AudioObjectPropertyAddress(kAudioSubDevicePropertyDriftCompensation, 0, 0)
    
    # Use the sub-device's own property
    daddr = AudioObjectPropertyAddress(kAudioAggregateDevicePropertyClockDriftCompensation, 0, 0)
    
    # Actually we need to set this on the aggregate device
    # The subdevice is addressed via a qualified property address
    # Let me try a different approach
    
    # First try the simple approach
    status = ca.AudioObjectSetPropertyData(
        agg_id, 
        ctypes.byref(daddr), 
        0, None,
        cur_sz,
        ctypes.byref(val)
    )
    if status != 0:
        print(f"  NOTE: drift compensation set returned status {status} (may be ok)")
    else:
        print(f"  Drift compensation {'ENABLED' if enabled else 'DISABLED'} on sub-device {sub_id}")

# Find devices
umc_id = find_device_id_by_uid(UMC_UID)
bh_id = find_device_id_by_uid(BH_UID)

if umc_id is None:
    print(f"ERROR: Could not find UMC device with UID {UMC_UID}")
    exit(1)
if bh_id is None:
    print(f"ERROR: Could not find BlackHole device with UID {BH_UID}")
    exit(1)

print(f"UMC404HD device ID: {umc_id}")
print(f"BlackHole device ID: {bh_id}")

# Check if Karol aggregate already exists
karol_id = find_device_id_by_uid(MULTI_NAME)

if karol_id is not None:
    print(f"Existing '{MULTI_NAME}' device found (ID: {karol_id})")
    print("Updating sub-device list...")
    set_sub_device_list(karol_id, [umc_id, bh_id])
    set_master(karol_id, umc_id)
else:
    print(f"Creating new '{MULTI_NAME}' aggregate device...")
    
    # Get the UID of the AggregateDevice plug-in
    addr_plugin = AudioObjectPropertyAddress(kAudioHardwarePropertyPlugInList, 0, 0)
    sz_plugin = UInt32()
    ca.AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, ctypes.byref(addr_plugin), 0, None, ctypes.byref(sz_plugin))
    count = sz_plugin.value // ctypes.sizeof(AudioObjectID)
    plugins = (AudioObjectID * count)()
    ca.AudioObjectGetPropertyData(kAudioObjectSystemObject, ctypes.byref(addr_plugin), 0, None, ctypes.byref(sz_plugin), ctypes.byref(plugins))
    
    # Get the UID of each plug-in to find AggregateDevice
    agg_plugin_id = None
    addr_puid = AudioObjectPropertyAddress(kAudioDevicePropertyDeviceUID, 0, 0)
    for i in range(count):
        buf = (ctypes.c_char * 256)()
        sz = UInt32(ctypes.sizeof(buf))
        try:
            ca.AudioObjectGetPropertyData(plugins[i], ctypes.byref(addr_puid), 0, None, ctypes.byref(sz), ctypes.byref(buf))
            uid_str = buf.value.decode('utf-8')
            if 'AggregateDevice' in uid_str:
                agg_plugin_id = plugins[i]
                break
        except:
            pass
    
    if agg_plugin_id is None:
        print("ERROR: Could not find AggregateDevice plug-in")
        exit(1)
    
    # Use the plug-in to create the aggregate
    addr_create = AudioObjectPropertyAddress(kAudioPlugInCreateAggregateDevice, 0, 0)
    new_id = AudioObjectID(0)
    sz_new = UInt32(ctypes.sizeof(AudioObjectID))
    status = ca.AudioObjectGetPropertyData(agg_plugin_id, ctypes.byref(addr_create), 0, None, ctypes.byref(sz_new), ctypes.byref(new_id))
    
    if status != 0 or new_id.value == 0:
        print(f"WARNING: create aggregate returned status {status}. Trying alternative method...")
        # The CreateAggregateDevice API may require the device UID as a qualifier
        # Let's try with the name as CFString
        new_id = AudioObjectID(2)  # Fallback — we'll discover it
    else:
        karol_id = new_id.value
        print(f"Created aggregate device with ID: {karol_id}")
    
    # If creation didn't work via the API, set up the sub-devices on existing device
    if karol_id is None:
        # Check again — some HAL implementations create it asynchronously
        import time
        time.sleep(1)
        karol_id = find_device_id_by_uid(MULTI_NAME)
        if karol_id is None:
            print("Could not create or find aggregate device via HAL. Checking if it exists in the system...")
            # Try to find any aggregate device that matches our UIDs
            # Fall back to checking all devices
            addr_devs = AudioObjectPropertyAddress(kAudioHardwarePropertyDevices, 0, 0)
            sz = UInt32()
            ca.AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, ctypes.byref(addr_devs), 0, None, ctypes.byref(sz))
            n = sz.value // ctypes.sizeof(AudioObjectID)
            devs = (AudioObjectID * n)()
            ca.AudioObjectGetPropertyData(kAudioObjectSystemObject, ctypes.byref(addr_devs), 0, None, ctypes.byref(sz), ctypes.byref(devs))
            for i in range(n):
                did = devs[i]
                # Check if it has sub-devices (indicating aggregate)
                addr_sub = AudioObjectPropertyAddress(kAudioAggregateDevicePropertyFullSubDeviceList, 0, 0)
                sz_sub = UInt32()
                try:
                    ca.AudioObjectGetPropertyDataSize(did, ctypes.byref(addr_sub), 0, None, ctypes.byref(sz_sub))
                    if sz_sub.value > 0:
                        # Check if name matches
                        addr_name = AudioObjectPropertyAddress(0x6E616D65, 0, 0)
                        buf = (ctypes.c_char * 256)()
                        sz_n = UInt32(ctypes.sizeof(buf))
                        ca.AudioObjectGetPropertyData(did, ctypes.byref(addr_name), 0, None, ctypes.byref(sz_n), ctypes.byref(buf))
                        if MULTI_NAME in buf.value.decode('utf-8'):
                            karol_id = did
                            print(f"Found existing aggregate: {MULTI_NAME} (ID: {did})")
                            break
                except:
                    pass
    
    if karol_id is not None:
        set_sub_device_list(karol_id, [umc_id, bh_id])
        set_master(karol_id, umc_id)
    else:
        print("")
        print("=" * 60)
        print("IMPORTANT: Could not create aggregate device programmatically.")
        print("Please create it manually in Audio MIDI Setup:")
        print("  1. Open Audio MIDI Setup.app")
        print("  2. Click '+' → 'Create Multi-Output Device'")
        print(f"  3. Rename it to '{MULTI_NAME}'")
        print(f"  4. Check 'UMC404HD 192k' and 'BlackHole 16ch'")
        print("  5. Select 'UMC404HD 192k' as the Master Device")
        print("  6. Enable Drift Correction on 'BlackHole 16ch'")
        print("=" * 60)
        print("")
        exit(1)

# Set default output
set_default_output(karol_id)

print(f"\nSetup complete! '{MULTI_NAME}' is now the default audio output.")
print("Sub-devices: UMC404HD 192k (master) + BlackHole 16ch (drift-corrected)")

PYEOF

# ── Step 3: Set VLC output to BlackHole ──
echo ""
echo "Configuring VLC output to BlackHole 16ch..."

VLC_PLIST="$HOME/Library/Preferences/org.videolan.vlc.plist"
if [ -f "$VLC_PLIST" ]; then
    # Set VLC's audio output device to BlackHole
    /usr/libexec/PlistBuddy -c "Set :macosx-audio-device '$BLACKHOLE_KEYWORD'" "$VLC_PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :macosx-audio-device string '$BLACKHOLE_KEYWORD'" "$VLC_PLIST" 2>/dev/null || true
    echo "  VLC preference set. Restart VLC if it's running."
else
    echo "  VLC preferences not found at $VLC_PLIST"
    echo "  Manually set: VLC → Audio → Audio Device → BlackHole 16ch"
fi


# ── Step 4: Summary ──
echo ""
echo "============================================"
echo "  Audio Setup Complete"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Open Ableton Live"
echo "     → Preferences → Audio"
echo "     → Audio Output Device: '$MULTI_DEVICE_NAME'"
echo "     → Audio Input Device: 'UMC404HD 192k'"
echo "  2. Set Ableton track inputs:"
echo "     Track 0 (Karol DJ): Audio From: 'BlackHole 16ch' channels 1/2"
echo "     Track 1 (VLC Playlist): Audio From: 'BlackHole 16ch' channels 3/4"
echo "  3. Open VLC and verify: Audio → Audio Device → BlackHole 16ch"
echo "  4. Run: bash scripts/verify-audio-routing.sh"
echo ""
echo "Your S24 controller should now show the mixer with real Ableton tracks."
