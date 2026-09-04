"""Shared AbletonOSC helpers and Autotuna preset definitions."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from pythonosc import udp_client
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import ThreadingOSCUDPServer

OSC_HOST = "127.0.0.1"
OSC_SEND_PORT = 11000
OSC_RECV_PORT = 11001

# Notes top-to-bottom in Autotuna UI.
NOTES_TOP_TO_BOTTOM = ["A", "G#", "G", "F#", "F", "E", "D#", "D", "C#", "C", "B", "A#"]
NOTE_PARAM_BASE = 4

# Autotuna parameter indices.
P_DEVICE_ON = 0
P_INPUT_THRESHOLD = 1
P_AMOUNT = 2
P_CORRECTION = 3
P_NOTE_FIRST = 4
P_NOTE_LAST = 15
P_DRY_WET = 16
P_GAIN = 17
P_LATENCY = 18
P_QUALITY = 19
P_SIBILANCE = 20
P_TONIC = 21
P_PATTERN = 22

# Tonic OSC values (UI dropdown order: B=0 … C=11).
TONIC = {
    "B": 0.0,
    "A#": 1.0,
    "Bb": 1.0,
    "A": 2.0,
    "G#": 3.0,
    "G": 4.0,
    "F#": 5.0,
    "F": 6.0,
    "E": 7.0,
    "D#": 8.0,
    "Eb": 8.0,
    "D": 9.0,
    "C#": 10.0,
    "C": 11.0,
}

# Pattern "1" in UI = OSC 0 (major templates); "2" = minor, etc.
PATTERN_UI_1 = 0.0
PATTERN_UI_2 = 1.0


@dataclass(frozen=True)
class AutotunaPreset:
    id: str
    title: str
    artist: str
    tempo: float
    tonic: str
    pattern: float
    scale_on: frozenset[str]
    amount: float = 100.0
    quality: float = 3.0  # best
    gain_db: float = 6.0
    sibilance: float = 100.0
    input_threshold: float = -6.0
    dry_wet: float = 100.0
    manual_scale_hint: str = ""

    @property
    def scale_off(self) -> set[str]:
        return set(NOTES_TOP_TO_BOTTOM) - set(self.scale_on)

    def manual_hint(self) -> str:
        if self.manual_scale_hint:
            return self.manual_scale_hint
        on = ", ".join(sorted(self.scale_on, key=lambda n: NOTES_TOP_TO_BOTTOM.index(n)))
        off = ", ".join(sorted(self.scale_off, key=lambda n: NOTES_TOP_TO_BOTTOM.index(n)))
        return f"ON: {on}  |  OFF: {off}"


PRESETS: dict[str, AutotunaPreset] = {
    "karaoke": AutotunaPreset(
        id="karaoke",
        title="Karol Karaoke",
        artist="General",
        tempo=0.0,  # 0 = preserve Live's current tempo
        tonic="C",
        pattern=PATTERN_UI_1,
        scale_on=frozenset(NOTES_TOP_TO_BOTTOM),  # chromatic — any key
        amount=78.0,
        quality=0.0,  # basic = lowest live tracking latency
        gain_db=3.0,
        sibilance=100.0,
        input_threshold=-6.0,
        dry_wet=100.0,
        manual_scale_hint="All notes ON (chromatic — any karaoke key)",
    ),
    "charli": AutotunaPreset(
        id="charli",
        title="Von Dutch",
        artist="Charli XCX",
        tempo=130.0,
        tonic="A#",
        pattern=PATTERN_UI_1,
        scale_on=frozenset({"A#", "C", "D", "D#", "F", "G", "A"}),
        gain_db=8.0,
        sibilance=120.0,
    ),
    "believe": AutotunaPreset(
        id="believe",
        title="Believe",
        artist="Cher",
        tempo=133.0,
        tonic="F#",
        pattern=PATTERN_UI_1,
        scale_on=frozenset({"F#", "G#", "A#", "B", "C#", "D#", "E"}),
        gain_db=6.0,
        sibilance=100.0,
        manual_scale_hint="ON: F#, G#, A#, B, C#, D#, E  |  OFF: A, G, F, D, C",
    ),
    "one-more-time": AutotunaPreset(
        id="one-more-time",
        title="One More Time",
        artist="Daft Punk",
        tempo=123.0,
        tonic="D",
        pattern=PATTERN_UI_1,
        scale_on=frozenset({"D", "E", "F#", "G", "A", "B", "C#"}),
        gain_db=6.0,
        sibilance=110.0,
        manual_scale_hint="ON: D, E, F#, G, A, B, C#  |  OFF: A#, G#, F, E, D#, C",
    ),
}


@dataclass
class OscClient:
    client: udp_client.SimpleUDPClient
    lock: threading.Lock = field(default_factory=threading.Lock)
    responses: list[tuple[str, tuple[Any, ...]]] = field(default_factory=list)

    def start_listener(self) -> ThreadingOSCUDPServer:
        def handler(address: str, *args: Any) -> None:
            with self.lock:
                self.responses.append((address, args))

        disp = Dispatcher()
        disp.set_default_handler(handler)
        server = ThreadingOSCUDPServer((OSC_HOST, OSC_RECV_PORT), disp)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server

    def query(self, address: str, *args: Any, wait: float = 0.2) -> list[tuple[str, tuple[Any, ...]]]:
        with self.lock:
            self.responses.clear()
        self.client.send_message(address, list(args))
        time.sleep(wait)
        with self.lock:
            return list(self.responses)

    def send(self, address: str, *args: Any, wait: float = 0.08) -> list[tuple[str, tuple[Any, ...]]]:
        with self.lock:
            self.responses.clear()
        self.client.send_message(address, list(args))
        if wait:
            time.sleep(wait)
        with self.lock:
            return list(self.responses)

    def errors(self, replies: list[tuple[str, tuple[Any, ...]]]) -> list[str]:
        out: list[str] = []
        for addr, args in replies:
            if addr == "/live/error":
                out.append(str(args[0]) if args else "unknown error")
        return out


def find_autotuna_device(osc: OscClient, track: int | None = None) -> tuple[int, int, str]:
    """Return (track_index, device_index, device_name)."""
    tracks = [track] if track is not None else range(8)
    for t in tracks:
        num_r = osc.query("/live/track/get/num_devices", t)
        if not num_r or num_r[0][0] != "/live/track/get/num_devices":
            continue
        num_devices = int(num_r[0][1][1])
        for di in range(num_devices):
            name_r = osc.query("/live/device/get/name", t, di)
            if not name_r:
                continue
            name = str(name_r[0][1][2])
            lower = name.lower()
            if any(k in lower for k in ("autotuna", "von dutch", "believe", "one more", "karol karaoke")):
                return t, di, name
            np_r = osc.query("/live/device/get/num_parameters", t, di)
            if np_r and int(np_r[0][1][2]) >= 23:
                dw = get_param(osc, t, di, P_DRY_WET)
                if dw is not None and dw >= 0:
                    return t, di, name
    if track is not None:
        raise RuntimeError(f"No Autotuna device on track {track}")
    raise RuntimeError("No Autotuna device found on any track (add Autotuna to mic track)")


def get_param(osc: OscClient, track: int, device: int, param: int) -> float | None:
    r = osc.query("/live/device/get/parameter/value", track, device, param)
    if r and r[0][0] == "/live/device/get/parameter/value":
        return float(r[0][1][3])
    return None


def set_param(osc: OscClient, track: int, device: int, param: int, value: float) -> list[str]:
    replies = osc.send("/live/device/set/parameter/value", track, device, param, float(value))
    return osc.errors(replies)


def reset_autotuna(osc: OscClient, track: int, device: int, preset: AutotunaPreset) -> None:
    tonic_val = TONIC[preset.tonic]
    set_param(osc, track, device, P_CORRECTION, 0.0)
    time.sleep(0.1)
    for p in range(P_NOTE_FIRST, P_NOTE_LAST + 1):
        set_param(osc, track, device, p, 0.0)
        time.sleep(0.05)
    set_param(osc, track, device, P_TONIC, tonic_val)
    time.sleep(0.2)
    set_param(osc, track, device, P_PATTERN, preset.pattern)
    time.sleep(0.3)


def apply_preset(
    osc: OscClient,
    preset: AutotunaPreset,
    track: int = 0,
    dry_run: bool = False,
    reset: bool = True,
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "preset": preset.id,
        "title": preset.title,
        "artist": preset.artist,
        "track_index": track,
        "device_index": None,
        "device_name": None,
        "set_ok": [],
        "set_failed": [],
        "manual": [],
        "errors": [],
        "readback": {},
    }

    found_track, device_index, device_name = find_autotuna_device(osc, track)
    track = found_track
    report["track_index"] = track

    track_name_r = osc.query("/live/track/get/name", track)
    if track_name_r and len(track_name_r[0][1]) > 1:
        report["track_name"] = track_name_r[0][1][1]
    else:
        report["track_name"] = "?"

    report["device_index"] = device_index
    report["device_name"] = device_name

    tonic_val = TONIC[preset.tonic]

    if reset and not dry_run:
        reset_autotuna(osc, track, device_index, preset)
        report["set_ok"].append(f"Reset scale → {preset.tonic} major, pattern {int(preset.pattern) + 1}")

    def do_set(label: str, param: int, value: float) -> None:
        if dry_run:
            report["set_ok"].append(f"{label} (dry-run p{param}={value})")
            return
        errs = set_param(osc, track, device_index, param, value)
        if errs:
            report["set_failed"].append(f"{label}: {errs[0]}")
        else:
            report["set_ok"].append(label)

    if not dry_run and preset.tempo and preset.tempo > 0:
        osc.send("/live/song/set/tempo", preset.tempo, wait=0.2)
        report["set_ok"].append(f"Tempo {preset.tempo} BPM")
    else:
        tempo_r = osc.query("/live/song/get/tempo")
        cur = float(tempo_r[0][1][0]) if tempo_r else None
        report["set_ok"].append(f"Tempo preserved ({cur} BPM)" if cur else "Tempo preserved")

    if not dry_run:
        osc.send("/live/track/set/current_monitoring_state", track, 1, wait=0.12)
        osc.send("/live/track/set/arm", track, 1, wait=0.12)
    report["set_ok"].append("Monitor In, Arm ON")

    do_set("Device On", P_DEVICE_ON, 1.0)
    do_set(f"Tonic {preset.tonic}", P_TONIC, tonic_val)
    time.sleep(0.12 if not dry_run else 0)
    do_set(f"Pattern {int(preset.pattern) + 1}", P_PATTERN, preset.pattern)
    time.sleep(0.2 if not dry_run else 0)
    do_set(f"Amount {preset.amount:.0f}%", P_AMOUNT, preset.amount)
    do_set(f"Dry/Wet {preset.dry_wet:.0f}%", P_DRY_WET, preset.dry_wet)
    qlabel = {0.0: "basic", 1.0: "good", 2.0: "better", 3.0: "best"}.get(preset.quality, str(preset.quality))
    do_set(f"Quality {qlabel}", P_QUALITY, preset.quality)
    do_set(f"Gain +{preset.gain_db:.0f} dB", P_GAIN, preset.gain_db)
    do_set(f"Sibilance {preset.sibilance:.0f}", P_SIBILANCE, preset.sibilance)
    do_set(f"Input threshold {preset.input_threshold:.0f} dB", P_INPUT_THRESHOLD, preset.input_threshold)
    do_set("Correction 0 ct", P_CORRECTION, 0.0)
    # Off = lower monitor delay (karaoke); On = better pitch look-ahead
    do_set("Latency off (low monitor delay)", P_LATENCY, 0.0)

    note_results: dict[str, float] = {}
    for i, note in enumerate(NOTES_TOP_TO_BOTTOM):
        param = NOTE_PARAM_BASE + i
        target = 1.0 if note in preset.scale_on else 0.0
        if dry_run:
            note_results[note] = target
            continue
        errs = set_param(osc, track, device_index, param, target)
        if errs:
            report["set_failed"].append(f"Note {note}: {errs[0]}")
        else:
            time.sleep(0.05)
            note_results[note] = get_param(osc, track, device_index, param) or target

    scale_ok = all(
        (note_results.get(n, 0) >= 0.5) == (n in preset.scale_on)
        for n in NOTES_TOP_TO_BOTTOM
    )
    if scale_ok:
        report["set_ok"].append(f"{preset.tonic} scale toggles OK")
    else:
        report["manual"].append(f"Click scale in UI: {preset.manual_hint()}")

    if not dry_run:
        msg_err = osc.errors(
            osc.send("/live/application/view/show_message", f"{preset.title} Autotuna applied", wait=0.15)
        )
        if msg_err:
            report["errors"].append(f"show_message: {msg_err[0]}")

    tempo_r = osc.query("/live/song/get/tempo")
    report["readback"]["tempo"] = tempo_r[0][1][0] if tempo_r else None
    for key, pidx in {
        "tonic": P_TONIC,
        "pattern": P_PATTERN,
        "amount": P_AMOUNT,
        "dry_wet": P_DRY_WET,
        "quality": P_QUALITY,
        "gain": P_GAIN,
        "sibilance": P_SIBILANCE,
        "correction": P_CORRECTION,
    }.items():
        report["readback"][key] = get_param(osc, track, device_index, pidx)

    report["readback"]["scale_notes"] = {
        note: get_param(osc, track, device_index, NOTE_PARAM_BASE + i)
        for i, note in enumerate(NOTES_TOP_TO_BOTTOM)
    }
    return report
