#!/usr/bin/env python3
"""
LRC to ASS subtitle generator for karaoke video rendering.

Parses LRC format [mm:ss.cc]Lyric text and generates an ASS (Advanced
SubStation Alpha) subtitle file with progressive word-by-word karaoke
highlighting via ASS \\k tags.

Features:
- Word-by-word progressive fill (gold highlight sweeps left-to-right)
- One active line (gold, large, centered) + one preview line below (dim white, smaller)
- Semi-transparent background bar behind lyric area
- 3-2-1 countdown before first lyric (when there's room)
- Aspect-ratio-aware positioning for square vs widescreen video

Usage as library:
    from karaoke_render_lrc import parse_lrc, generate_ass, generate_ass_karaoke

Usage as CLI:
    python3 scripts/karaoke-render-lrc.py --lrc lyrics.lrc --duration 248 --ass subtitles.ass
    python3 scripts/karaoke-render-lrc.py --lrc lyrics.lrc --duration 248 --output ffmpeg-cmd \\
        --ass subtitles.ass --input-video input.mp4 --input-audio instr.wav --output-video out.mp4
"""

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class LyricLine:
    timestamp: float  # start time in seconds
    end_time: float = 0.0  # computed: next line's timestamp or song duration
    text: str = ""
    words: list["LyricWord"] = None  # type: ignore

    def __post_init__(self):
        if self.words is None:
            self.words = []


@dataclass
class LyricWord:
    text: str
    start_time: float
    end_time: float

    @property
    def cs(self) -> int:
        """Duration in centiseconds (for ASS \\k tags)."""
        return max(1, int((self.end_time - self.start_time) * 100))


def parse_lrc(text: str) -> list[LyricLine]:
    """Parse LRC format into timed lyric lines."""
    lines: list[LyricLine] = []
    tag_re = re.compile(r"\[(?P<min>\d{1,3}):(?P<sec>\d{2}(?:\.\d{2,3})?)\]")

    for raw in text.strip().split("\n"):
        raw = raw.strip()
        if not raw:
            continue

        matches = list(tag_re.finditer(raw))
        if not matches:
            if lines:
                lines[-1].text += " " + raw
            continue

        text_part = tag_re.sub("", raw).strip()
        if not text_part:
            continue

        for m in matches:
            mins = int(m.group("min"))
            secs = float(m.group("sec"))
            ts = mins * 60 + secs
            lines.append(LyricLine(timestamp=ts, text=text_part))

    lines.sort(key=lambda x: x.timestamp)
    return lines


def _compute_word_timing(lines: list[LyricLine]) -> None:
    """Distribute each line's duration across its words proportionally.

    Word boundaries are determined by splitting on whitespace.
    Each word's share of the line's time is proportional to its character count.
    """
    for line in lines:
        raw_words = line.text.split()
        if not raw_words:
            continue

        total_chars = sum(len(w) for w in raw_words)
        line_dur = line.end_time - line.timestamp

        if total_chars == 0 or line_dur <= 0:
            dur_per_word = line_dur / len(raw_words) if raw_words else 0
            t = line.timestamp
            words = []
            for w in raw_words:
                words.append(LyricWord(text=w, start_time=t, end_time=t + dur_per_word))
                t += dur_per_word
            line.words = words
            continue

        t = line.timestamp
        words = []
        for w in raw_words:
            share = len(w) / total_chars
            w_dur = share * line_dur
            words.append(LyricWord(text=w, start_time=t, end_time=t + w_dur))
            t += w_dur
        line.words = words


def _secs_to_ass_time(secs: float) -> str:
    """Convert seconds to ASS timestamp format H:MM:SS.cc."""
    h = int(secs // 3600)
    m = int((secs % 3600) // 60)
    s = secs % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass_escape(text: str) -> str:
    """Escape text for ASS format."""
    return text


def _build_karaoke_text(words: list[LyricWord]) -> str:
    """Build ASS text with \\k tags for progressive word-by-word highlighting.

    Example: "{\\k40}I {\\k50}see {\\k30}a {\\k80}green"
    """
    if not words:
        return ""
    parts = []
    for w in words:
        parts.append(f"{{\\k{w.cs}}}{w.text}")
    return " ".join(parts)


def _word_timing_to_json(lines: list[LyricLine]) -> list[dict]:
    """Export line and word timing as JSON-serializable dict list.

    Used for generating .lrc.json files for the real-time overlay.
    """
    result = []
    for line in lines:
        entry = {
            "text": line.text,
            "startTime": round(line.timestamp, 3),
            "endTime": round(line.end_time, 3),
        }
        if line.words:
            entry["words"] = [
                {
                    "text": w.text,
                    "startTime": round(w.start_time, 3),
                    "endTime": round(w.end_time, 3),
                }
                for w in line.words
            ]
        result.append(entry)
    return result


def generate_ass(
    lrc_text: str,
    duration: float,
    out_path: str,
    video_width: int = 1280,
    video_height: int = 720,
    fontname: str = "Arial",
    fontsize_active: int = 56,
    fontsize_inactive: int = 38,
    countdown_fontsize: int = 120,
    preview_lead_seconds: float = 1.8,
) -> str:
    """Generate an ASS subtitle file with progressive karaoke highlighting.

    Returns the path to the generated ASS file.

    Features:
    - Word-by-word progressive fill via ASS \\k tags
    - Active line: gold, large, centered on a dark bar
    - Preview line: dim white, smaller, appears ~1.8s before it becomes active
    - 3-2-1 countdown if first lyric starts after 3.5 seconds
    - Aspect-ratio-aware positioning
    """
    lines = parse_lrc(lrc_text)
    if not lines:
        return ""

    for i, line in enumerate(lines):
        if i + 1 < len(lines):
            line.end_time = lines[i + 1].timestamp
        else:
            line.end_time = duration

    _compute_word_timing(lines)

    # ── Aspect ratio aware positioning ──
    aspect = video_width / max(1, video_height)
    is_square = aspect < 1.35
    is_near_square = aspect < 1.55

    if is_square:
        fontsize_active = max(26, fontsize_active - 4)
        fontsize_inactive = max(15, fontsize_inactive - 3)
        countdown_fontsize = max(54, countdown_fontsize - 18)
        bar_top_y = int(video_height * 0.82)
        bar_height = int(video_height * 0.12)
        active_y = int(video_height * 0.855)
        line_offset = int(video_height * 0.065)
    elif is_near_square:
        fontsize_active = max(30, fontsize_active - 2)
        bar_top_y = int(video_height * 0.78)
        bar_height = int(video_height * 0.14)
        active_y = int(video_height * 0.82)
        line_offset = int(video_height * 0.06)
    else:
        bar_top_y = video_height - 195
        bar_height = 175
        active_y = video_height - 145
        line_offset = 72

    # ── Colors (ASS format: &HAABBGGRR; PrimaryColour=fill, SecondaryColour=unfilled) ──
    active_color_ass = "&H0000D7FF"     # opaque gold (filled portion)
    dim_color_ass = "&H00FFFFFF"         # opaque white (unfilled portion)
    preview_color_ass = "&H66FFFFFF"     # white @ 40% alpha for preview
    countdown_color = "&H0000D7FF"       # gold for countdown
    bar_color = "&H73000000"             # black @ 45% alpha

    first_lyric_start = lines[0].timestamp if lines else duration
    has_countdown = first_lyric_start > 3.5

    with open(out_path, "w", encoding="utf-8") as f:
        # ── Script header ──
        f.write("[Script Info]\n")
        f.write("Title: Karaoke Lyrics\n")
        f.write("ScriptType: v4.00+\n")
        f.write(f"PlayResX: {video_width}\n")
        f.write(f"PlayResY: {video_height}\n")
        f.write("WrapStyle: 2\n")
        f.write("\n")

        # ── Styles ──
        f.write("[V4+ Styles]\n")
        f.write(
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        )

        # KaraokeActive with SecondaryColour for unfilled text:
        # The \\k tag causes the text to start in SecondaryColour (white) and
        # transition left-to-right into PrimaryColour (gold) as time advances.
        f.write(
            f"Style: KaraokeActive,{fontname},{fontsize_active},{active_color_ass},"
            f"{dim_color_ass},&H00000000,&H73000000,-1,0,0,0,100,100,0,0,1,3,0,2,0,0,0,1\n"
        )
        # KaraokePreview: dim preview of next line below active
        f.write(
            f"Style: KaraokePreview,{fontname},{fontsize_inactive},{preview_color_ass},"
            f"&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,0,0,0,1\n"
        )
        # KaraokeCountdown: large centered gold with dark shadow
        f.write(
            f"Style: KaraokeCountdown,{fontname},{countdown_fontsize},{countdown_color},"
            f"&H00000000,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,1,3,0,5,0,0,0,1\n"
        )
        # KaraokeBar: thin drawing style for semi-transparent background
        f.write(
            f"Style: KaraokeBar,{fontname},1,{bar_color},&H00000000,"
            f"&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,0,0,0,1\n"
        )
        f.write("\n")

        # ── Events ──
        f.write("[Events]\n")
        f.write(
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
            "MarginV, Effect, Text\n"
        )

        # Background bar behind lyrics — full duration
        bar_draw = (
            f"{{\\p1}}m 0 {bar_top_y} l {video_width} {bar_top_y} "
            f"l {video_width} {bar_top_y + bar_height} l 0 {bar_top_y + bar_height}"
            f"{{\\p0}}"
        )
        f.write(
            f"Dialogue: 0,{_secs_to_ass_time(0)},{_secs_to_ass_time(duration)},"
            f"KaraokeBar,,0,0,0,,{bar_draw}\n"
        )

        # ── 3-2-1 Countdown ──
        if has_countdown:
            cx = video_width // 2
            cy = video_height // 2 - 30
            for num, secs in [(3, 0.0), (2, 1.0), (1, 2.0)]:
                cs = _secs_to_ass_time(secs)
                ce = _secs_to_ass_time(secs + 0.9)
                pos = f"{{\\pos({cx},{cy})}}"
                fade = f"{{\\fad(200,200)}}"
                f.write(
                    f"Dialogue: 10,{cs},{ce},KaraokeCountdown,,0,0,0,,"
                    f"{fade}{pos}{num}\n"
                )

        # ── Lyric lines with progressive \\k fill ──
        for i, line in enumerate(lines):
            start = line.timestamp
            end = line.end_time
            start_ass = _secs_to_ass_time(start)
            end_ass = _secs_to_ass_time(end)
            cx = video_width // 2

            # Active line: \\k tags between words drive progressive left-to-right fill
            karaoke_text = _build_karaoke_text(line.words)
            if not karaoke_text:
                karaoke_text = line.text

            pos_active = f"{{\\pos({cx},{active_y})}}"
            f.write(
                f"Dialogue: 1,{start_ass},{end_ass},KaraokeActive,,0,0,0,,"
                f"{pos_active}{karaoke_text}\n"
            )

            # Preview line: next lyric appears ~1.8s before it becomes active
            if i < len(lines) - 1:
                next_line = lines[i + 1]
                preview_start = next_line.timestamp - preview_lead_seconds
                if preview_start < start + 0.3:
                    preview_start = start + 0.3
                if preview_start < next_line.timestamp:
                    ps = _secs_to_ass_time(preview_start)
                    ns = _secs_to_ass_time(next_line.timestamp)
                    pos_preview = f"{{\\pos({cx},{active_y + line_offset})}}"
                    f.write(
                        f"Dialogue: 0,{ps},{ns},KaraokePreview,,0,0,0,,"
                        f"{pos_preview}{next_line.text}\n"
                    )

    return out_path


def generate_ass_karaoke(
    lrc_text: str,
    duration: float,
    out_path: str,
    video_width: int = 1280,
    video_height: int = 720,
    fontname: str = "Arial",
    fontsize_active: int = 56,
    fontsize_inactive: int = 38,
) -> str:
    """Convenience wrapper — calls generate_ass with karaoke defaults."""
    return generate_ass(
        lrc_text=lrc_text,
        duration=duration,
        out_path=out_path,
        video_width=video_width,
        video_height=video_height,
        fontname=fontname,
        fontsize_active=fontsize_active,
        fontsize_inactive=fontsize_inactive,
    )


def build_ffmpeg_cmd(
    ass_path: str,
    input_video: str,
    input_audio: str,
    output_path: str,
    video_codec: str = "libx264",
    crf: int = 23,
    preset: str = "medium",
) -> list[str]:
    """Build FFmpeg command for karaoke video rendering with ASS subtitle burn-in."""
    ass_abs = str(Path(ass_path).resolve())
    subtitles_filter = f"subtitles='{ass_abs}'"

    return [
        "ffmpeg",
        "-y",
        "-i", input_video,
        "-i", input_audio,
        "-vf", subtitles_filter,
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", video_codec,
        "-preset", preset,
        "-crf", str(crf),
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
        output_path,
    ]


# ── CLI ────────────────────────────────────────────────────────────────

def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Generate ASS subtitle file and FFmpeg command from LRC lyrics"
    )
    parser.add_argument("--lrc", help="Path to LRC file (reads stdin if omitted)")
    parser.add_argument("--duration", type=float, required=True,
                       help="Song/audio duration in seconds")
    parser.add_argument("--ass", help="Output path for ASS subtitle file")
    parser.add_argument("--width", type=int, default=1280, help="Video width (px)")
    parser.add_argument("--height", type=int, default=720, help="Video height (px)")
    parser.add_argument("--font", default="Arial", help="Font name for subtitles")
    parser.add_argument("--font-size-active", type=int, default=56,
                       help="Active lyric font size")
    parser.add_argument("--font-size-inactive", type=int, default=38,
                       help="Inactive lyric font size")
    parser.add_argument(
        "--output", choices=["ass", "ffmpeg-cmd"], default="ass",
        help="Output format: generate ASS file or full ffmpeg command"
    )
    parser.add_argument("--input-video", help="Input video (for ffmpeg-cmd)")
    parser.add_argument("--input-audio", help="Input audio (for ffmpeg-cmd)")
    parser.add_argument("--output-video", help="Output video (for ffmpeg-cmd)")

    args = parser.parse_args()

    if args.lrc:
        with open(args.lrc) as fh:
            lrc_text = fh.read()
    else:
        if sys.stdin.isatty():
            print("Error: LRC input required via --lrc or stdin", file=sys.stderr)
            sys.exit(1)
        lrc_text = sys.stdin.read()

    if args.output == "ass":
        ass_path = args.ass or "/tmp/karaoke-subtitles.ass"
        generate_ass(
            lrc_text=lrc_text,
            duration=args.duration,
            out_path=ass_path,
            video_width=args.width,
            video_height=args.height,
            fontname=args.font,
            fontsize_active=args.font_size_active,
            fontsize_inactive=args.font_size_inactive,
        )
        print(ass_path)
    else:
        missing = []
        if not args.input_video:
            missing.append("--input-video")
        if not args.input_audio:
            missing.append("--input-audio")
        if not args.output_video:
            missing.append("--output-video")
        if not args.ass:
            missing.append("--ass")
        if missing:
            print(
                f"Error: {' '.join(missing)} required for ffmpeg-cmd output",
                file=sys.stderr,
            )
            sys.exit(1)

        generate_ass(
            lrc_text=lrc_text,
            duration=args.duration,
            out_path=args.ass,
            video_width=args.width,
            video_height=args.height,
            fontname=args.font,
            fontsize_active=args.font_size_active,
            fontsize_inactive=args.font_size_inactive,
        )

        cmd = build_ffmpeg_cmd(
            ass_path=args.ass,
            input_video=args.input_video,
            input_audio=args.input_audio,
            output_path=args.output_video,
        )
        import shlex
        print(" ".join(shlex.quote(arg) for arg in cmd))


if __name__ == "__main__":
    main()
