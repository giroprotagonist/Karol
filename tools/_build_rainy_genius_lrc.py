#!/usr/bin/env python3
"""Rebuild Rainy Baddie LRC from Genius Thai lyrics + YouTube auto-caption timing anchors."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

VIDEO_ID = "GpW64ABLoM8"
LIBRARY = Path("/Volumes/maxone/Deskreen/karaoke")
DEST = LIBRARY / f"{VIDEO_ID}-karaoke.lrc.json"
DURATION = 152.0

# Singable lines from Genius (cleaned) — order matches performance
GENIUS_LINES = [
    "เปาะ เปาะแปะ เปาะ",
    "เปาะแปะ เปาะแปะ",
    "เปาะเปาะแปะ เปาะแปะ เปาะแปะ",
    "เปาะแปะ เปาะแปะ เปาะแปะ เปาะแปะ",
    "เปาะเปาะแปะ เปาะแปะ เปาะแปะ",
    "ฝนตก I want kiss you more",
    "ฝนตก I want kiss you more",
    "ฝนตก I want kiss you more",
    "Yeah",
    "ฝนตกตอนเจ็ดโมง แปดโมง เก้าโมง สิบโมง",
    "ยังไม่ได้ไปไหนเลย",
    "เธออยู่ไหน you know",
    "ต้องการลม ต้องการเธอ",
    "ที่พักใจอยู่ที่ไหน ฉันต้องเจอ",
    "ฉันต้องมนตร์เธอสะกด",
    "ที่แบบฝนตกแบบไม่เคยหยุดเลย",
    "ฝนตกมันแบบเปาะเปาะแปะ",
    "เปาะแปะ เปาะแปะ เปาะแปะ เปาะแปะ",
    "เปาะเปาะแปะ เปาะแปะ เปาะแปะ",
    "ฝนตก I want kiss you more",
    "ฝนตก I want kiss you more",
    "ฝนตก I want kiss you more",
    "Yeah",
    "ฝนตกแพลม ๆ ฝนตกปรอย ๆ",
    "ฝนตกที่ไหน ตกถึงคอนโด",
    "บ้านเธอ บ้านเธออยู่ไหน",
    "ฉันคิดอยากรู้",
    "Yeah ดูเธอสิ ตอนนี้เธอ so cute",
    "ตอนฝนตก เธอต้องการอยู่ที่ไหน",
    "เธอ ๆ ต้องการคนนอนกอดไหม",
    "แค่นอนกอด ฝนข้างนอกไม่ได้นอน",
    "ฝนตกแรง นอนคนเดียวฉันก็กลัว",
    "ฉันอยากให้เธอมาอยู่ด้วยกัน",
    "อยู่ด้วยกันที่ไหน ฝนตกแปะแปะแปะ",
    "เปาะเปาะแปะ เปาะแปะ เปาะแปะ เปาะแปะ",
    "เปาะเปาะแปะ เปาะแปะ เปาะแปะ",
    "ฝนตก I want kiss you more",
    "ฝนตก I want kiss you more",
    "ฝนตก I want kiss you more",
    "Yeah",
]

# Rough section anchors from YouTube auto-captions (seconds)
# Used only as seed; retime-keep-text will refine.
ANCHORS = [
    (14.5, 29.7),   # peh peh chorus
    (29.7, 35.0),
    (35.0, 39.8),
    (39.8, 44.6),
    (44.6, 47.5),
    (47.5, 51.0),   # verse starts ~44-50 in YT but chorus kiss more earlier in song
    (51.0, 53.9),
    (53.9, 57.2),
    (57.2, 60.3),
    (44.6, 47.5),   # will re-spread below
]


def _spread(n: int, start: float, end: float):
    """Evenly spread n lines across [start, end)."""
    if n <= 0:
        return []
    dur = max(0.4, (end - start) / n)
    out = []
    t = start
    for i in range(n):
        e = start + (i + 1) * (end - start) / n
        out.append((round(t, 3), round(e, 3)))
        t = e
    return out


def _words_for(text: str, start: float, end: float):
    # Prefer space-separated tokens; Thai without spaces stays one word until romanize/retime
    parts = [p for p in re.split(r"(\s+)", text) if p and not p.isspace()]
    # Also split on Latin words boundaries already spaced
    tokens = []
    for p in parts:
        tokens.extend(p.split()) if False else tokens.append(p)
    # flatten: split text on spaces only
    tokens = text.split()
    if not tokens:
        tokens = [text]
    n = len(tokens)
    dur = max(0.05, (end - start) / n)
    words = []
    for i, tok in enumerate(tokens):
        ws = start + i * dur
        we = start + (i + 1) * dur if i < n - 1 else end
        words.append({"text": tok, "startTime": round(ws, 3), "endTime": round(we, 3)})
    return words


def main() -> None:
    bak = DEST.with_suffix(DEST.suffix + ".pre-genius-bak")
    if DEST.exists() and not bak.exists():
        shutil.copy2(DEST, bak)
        print("backup", bak.name)

    # Seed timings from song structure (Genius sections)
    # Intro chorus ~14.5-40, postchorus kiss ~ — listening/YT:
    # Actual YT: peh from 14.5, verse from ~44.6, drizzle ~57, verse2 ~88, bridge ~104, end chorus ~114
    ranges = [
        (0, 5, 14.5, 39.5),     # opening peh peh block (5 lines)
        (5, 9, 39.5, 44.6),     # I want kiss you more x3 + Yeah
        (9, 17, 44.6, 60.3),    # verse1 + prechorus
        (17, 19, 60.3, 72.0),   # short chorus peh
        (19, 23, 72.0, 84.0),   # kiss more again
        (23, 30, 84.0, 104.0),  # verse2
        (30, 34, 104.0, 120.5), # bridge
        (34, 40, 120.5, 148.0), # final chorus + kiss
    ]

    lines = []
    for a, b, st, en in ranges:
        chunk = GENIUS_LINES[a:b]
        slots = _spread(len(chunk), st, en)
        for text, (s, e) in zip(chunk, slots):
            lines.append({
                "startTime": s,
                "endTime": e,
                "text": text,
                "words": _words_for(text, s, e),
            })

    assert len(lines) == len(GENIUS_LINES), (len(lines), len(GENIUS_LINES))

    sung = {
        "lang": "th",
        "label": "As sung",
        "role": "primary",
        "lines": lines,
        "alignMode": "genius+seed_times",
    }
    native = {
        "lang": "th",
        "label": "Native",
        "role": "native",
        "lines": json.loads(json.dumps(lines)),
        "alignMode": "genius+seed_times",
    }
    data = {
        "videoId": VIDEO_ID,
        "duration": DURATION,
        "title": "ฝนตกเปาะแปะ (Rainy Baddie) | Official MV",
        "artist": "เบบี้โจลี่สตาร์",
        "alignMode": "genius+seed_times",
        "source": "genius+seed_times",
        "tracks": {"sung": sung, "native": native},
        "display": {"primary": "sung", "secondary": None, "tertiary": "native"},
        "lines": lines,
    }
    DEST.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(lines)} Genius lines → {DEST.name}")
    for i, l in enumerate(lines):
        print(f"{i:02d} {l['startTime']:6.1f}-{l['endTime']:6.1f} | {l['text']}")


if __name__ == "__main__":
    main()
