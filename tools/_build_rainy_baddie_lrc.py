#!/usr/bin/env python3
"""Build 3-layer LRC for Rainy Baddie from YouTube Thai auto-captions.

Parses yt-dlp VTT with nested word timestamps, dedupes rolling cues,
writes sung/native Thai tracks, then callers romanize + translate.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

VIDEO_ID = "GpW64ABLoM8"
LIBRARY = Path("/Volumes/maxone/Deskreen/karaoke")
VTT = Path("/tmp/karol-rainy-subs/GpW64ABLoM8.th.vtt")
DURATION = 152.0

TS_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*"
    r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})"
)
# YouTube karaoke: leading text + optional <ts><c>chunk</c> repeats
WORD_RE = re.compile(
    r"(?:<(\d{2}):(\d{2}):(\d{2})\.(\d{3})><c>(.*?)</c>)|([^<]+)"
)
TAG_RE = re.compile(r"<[^>]+>")


def _sec(h, m, s, ms) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _clean_text(s: str) -> str:
    s = TAG_RE.sub("", s or "")
    s = s.replace("\xa0", " ").strip()
    s = re.sub(r"\s+", " ", s)
    return s


def _is_music_marker(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    if t in ("[เพลง]", "[Music]", "[music]", "♪", "♫"):
        return True
    if re.fullmatch(r"[\[\(]?เพลง[\]\)]?", t):
        return True
    return False


def parse_youtube_karaoke_vtt(vtt_path: Path):
    """Return list of {start,end,text,words[]} from YouTube auto-caption VTT."""
    content = vtt_path.read_text(encoding="utf-8")
    raw_cues = []
    current_start = current_end = None
    current_raw: list[str] = []

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE", "STYLE", "Region:", "::")):
            continue
        m = TS_RE.search(line)
        if m:
            if current_start is not None and current_raw:
                raw_cues.append((current_start, current_end, "\n".join(current_raw)))
            current_start = _sec(m[1], m[2], m[3], m[4])
            current_end = _sec(m[5], m[6], m[7], m[8])
            current_raw = []
            continue
        if current_start is not None:
            current_raw.append(line)
    if current_start is not None and current_raw:
        raw_cues.append((current_start, current_end, "\n".join(current_raw)))

    # Prefer cues that contain nested word timestamps (growing karaoke line).
    # Fall back to plain settled text when no nested timing exists.
    timed_cues = []
    for start, end, blob in raw_cues:
        # Use last non-empty payload line (YouTube often stacks prev+new)
        parts = [p for p in blob.split("\n") if p.strip()]
        if not parts:
            continue
        payload = parts[-1]
        has_nested = bool(re.search(r"<\d{2}:\d{2}:\d{2}\.\d{3}><c>", payload))
        words = []
        if has_nested:
            # Leading fragment starts at cue start
            pos = start
            for wm in WORD_RE.finditer(payload):
                if wm.group(1) is not None:
                    pos = _sec(wm.group(1), wm.group(2), wm.group(3), wm.group(4))
                    chunk = _clean_text(wm.group(5) or "")
                    if chunk:
                        words.append({"text": chunk, "startTime": round(pos, 3)})
                else:
                    chunk = _clean_text(wm.group(6) or "")
                    if chunk:
                        words.append({"text": chunk, "startTime": round(pos, 3)})
            # Assign end times from next word start / cue end
            for i, w in enumerate(words):
                if i + 1 < len(words):
                    w["endTime"] = round(words[i + 1]["startTime"], 3)
                else:
                    w["endTime"] = round(end, 3)
            text = "".join(w["text"] for w in words)
        else:
            text = _clean_text(payload)
            if text:
                words = [{"text": text, "startTime": round(start, 3), "endTime": round(end, 3)}]

        text = _clean_text(text)
        if not text or _is_music_marker(text):
            continue
        # Drop ultra-short flash cues that are just prev-line echoes
        if (end - start) < 0.05 and not has_nested:
            continue
        timed_cues.append({
            "startTime": round(start, 3),
            "endTime": round(end, 3),
            "text": text,
            "words": words,
            "has_nested": has_nested,
        })

    # Deduplicate rolling captions: keep the longest nested version for each
    # advancing phrase, then emit when text stops being a prefix extension.
    lines = []
    best = None
    for cue in timed_cues:
        t = cue["text"]
        if best is None:
            best = cue
            continue
        # Same / extension of current phrase → keep richer timing
        if t == best["text"] or t.startswith(best["text"]) or best["text"].startswith(t):
            # Prefer more words / longer text
            if len(t) >= len(best["text"]) and (cue["has_nested"] or not best["has_nested"]):
                # Extend end; keep earliest start of the phrase
                merged = dict(cue)
                merged["startTime"] = best["startTime"]
                # If growing, first word times from best when shared prefix
                best = merged
            else:
                best["endTime"] = max(best["endTime"], cue["endTime"])
            continue
        # New phrase — commit previous
        lines.append(best)
        best = cue
    if best:
        lines.append(best)

    # Merge tiny residual duplicates / fix ends
    cleaned = []
    for line in lines:
        text = line["text"]
        if cleaned and cleaned[-1]["text"] == text:
            cleaned[-1]["endTime"] = max(cleaned[-1]["endTime"], line["endTime"])
            continue
        # Clamp end before next start later
        cleaned.append({
            "startTime": line["startTime"],
            "endTime": line["endTime"],
            "text": text,
            "words": line["words"] or [{
                "text": text,
                "startTime": line["startTime"],
                "endTime": line["endTime"],
            }],
        })

    for i in range(len(cleaned) - 1):
        if cleaned[i]["endTime"] > cleaned[i + 1]["startTime"]:
            cleaned[i]["endTime"] = cleaned[i + 1]["startTime"]
            if cleaned[i]["words"]:
                cleaned[i]["words"][-1]["endTime"] = cleaned[i]["endTime"]

    return cleaned


def main() -> None:
    if not VTT.exists():
        raise SystemExit(f"Missing VTT: {VTT}")

    dest = LIBRARY / f"{VIDEO_ID}-karaoke.lrc.json"
    bak = dest.with_suffix(dest.suffix + ".pre-thai-rebuild-bak")
    if dest.exists() and not bak.exists():
        shutil.copy2(dest, bak)
        print(f"backup → {bak.name}")

    lines = parse_youtube_karaoke_vtt(VTT)
    print(f"parsed {len(lines)} lines")
    for i, l in enumerate(lines[:12]):
        print(f"  {i:02d} {l['startTime']:6.2f}-{l['endTime']:6.2f} nW={len(l['words'])} {l['text'][:60]}")

    track = {
        "lang": "th",
        "label": "As sung",
        "role": "primary",
        "lines": lines,
        "alignMode": "youtube_auto_th+word",
    }
    native = {
        "lang": "th",
        "label": "Native",
        "role": "native",
        "lines": json.loads(json.dumps(lines)),
        "alignMode": "youtube_auto_th+word",
    }
    data = {
        "videoId": VIDEO_ID,
        "duration": DURATION,
        "title": "ฝนตกเปาะแปะ (Rainy Baddie) | Official MV",
        "artist": "เบบี้โจลี่สตาร์",
        "alignMode": "youtube_auto_th+word",
        "source": "youtube_auto_th+word",
        "tracks": {
            "sung": track,
            "native": native,
        },
        "display": {
            "primary": "sung",
            "secondary": None,
            "tertiary": "native",
        },
        "lines": lines,
    }
    dest.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {dest} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
