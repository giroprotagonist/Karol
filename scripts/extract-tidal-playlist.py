#!/usr/bin/env python3
"""
Extract all tracks from a Tidal playlist with full metadata.
Usage: python3 scripts/extract-tidal-playlist.py [playlist_id]
       If no playlist_id is given, uses the default hardcoded one.
"""

import json
import sys
import os
import tidalapi

# Default playlist ID
PLAYLIST_ID = "380c880e-c4bc-4719-8e33-81624c9aab70"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", ".deskreen", "tidal-exports")
OUTPUT_JSON = os.path.join(OUTPUT_DIR, "playlist_tracks.json")
OUTPUT_CSV = os.path.join(OUTPUT_DIR, "playlist_tracks.csv")
SESSION_FILE = os.path.join(OUTPUT_DIR, "tidal-session.json")


def format_duration(seconds: int) -> str:
    """Format seconds into MM:SS."""
    if not seconds:
        return "0:00"
    m, s = divmod(seconds, 60)
    return f"{m}:{s:02d}"


def format_artists(artists: list) -> str:
    """Join artist names."""
    if not artists:
        return "Unknown Artist"
    return ", ".join(a.name for a in artists)


def extract_track_data(track: tidalapi.Track) -> dict:
    """Extract all relevant metadata from a Tidal track."""
    album = track.album
    return {
        "tidal_id": track.id,
        "title": track.name,
        "artists": format_artists(track.artists),
        "artist_list": [a.name for a in track.artists] if track.artists else [],
        "album": album.name if album else "Unknown Album",
        "album_id": album.id if album else None,
        "track_number": track.track_num,
        "disc_number": track.volume_num,
        "duration_seconds": track.duration,
        "duration_formatted": format_duration(track.duration),
        "isrc": getattr(track, "isrc", None),
        "explicit": getattr(track, "explicit", None),
        "copyright": getattr(track, "copyright", None),
        "popularity": getattr(track, "popularity", None),
        "audio_quality": str(track.audio_quality) if hasattr(track, "audio_quality") else None,
        "tidal_url": track.share_url if hasattr(track, "share_url") and track.share_url else f"https://tidal.com/browse/track/{track.id}",
    }


def login_or_restore(session: tidalapi.Session) -> bool:
    """Authenticate via OAuth device flow, restoring a saved session if possible."""
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, "r") as f:
                session_data = json.load(f)
            if session.load_oauth_session(
                token_type=session_data.get("token_type", "Bearer"),
                access_token=session_data.get("access_token"),
                refresh_token=session_data.get("refresh_token"),
                expiry_time=session_data.get("expiry_time"),
            ):
                print("✅ Restored saved Tidal session.")
                return True
        except Exception:
            print("⚠️  Saved session is invalid, re-authenticating...")

    # OAuth device flow
    print("\n🔐 Authenticating with Tidal...")
    login, future = session.login_oauth()
    print(f"\n📱 Open this URL in your browser to authorize:")
    print(f"   {login.verification_uri_complete}")
    print(f"\n   (Or visit {login.verification_uri} and enter code: {login.user_code})")
    print("\n⏳ Waiting for authorization...")

    future.result()  # blocks until user authorizes
    print("✅ Authenticated successfully.")

    # Save session for next time
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(SESSION_FILE, "w") as f:
        json.dump({
            "token_type": session.token_type,
            "access_token": session.access_token,
            "refresh_token": session.refresh_token,
            "expiry_time": session.expiry_time.isoformat() if session.expiry_time else None,
        }, f, indent=2)
    print(f"💾 Session saved to {SESSION_FILE}")
    return True


def main():
    playlist_id = sys.argv[1] if len(sys.argv) > 1 else PLAYLIST_ID
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    session = tidalapi.Session()
    if not login_or_restore(session):
        print("❌ Authentication failed.", file=sys.stderr)
        sys.exit(1)

    # Fetch playlist
    print(f"\n📋 Fetching playlist {playlist_id}...")
    try:
        playlist = session.playlist(playlist_id)
    except Exception as e:
        print(f"❌ Failed to fetch playlist: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"🎵 Playlist: \"{playlist.name}\"")
    print(f"   Creator: {playlist.creator.name if playlist.creator else 'Unknown'}")
    print(f"   Description: {playlist.description or '(none)'}")
    print(f"   Total tracks reported: {playlist.num_tracks}")
    print(f"\n⏳ Extracting all tracks (this may take a moment for {playlist.num_tracks} tracks)...")

    tracks_data = []
    track_count = 0

    for track in playlist.tracks():
        track_data = extract_track_data(track)
        tracks_data.append(track_data)
        track_count += 1
        if track_count % 50 == 0:
            print(f"   ... {track_count} tracks extracted so far")

    print(f"   ✅ Done. Extracted {track_count} tracks.")

    # Build output
    output = {
        "playlist_id": playlist.id,
        "playlist_name": playlist.name,
        "playlist_creator": playlist.creator.name if playlist.creator else None,
        "playlist_description": playlist.description,
        "playlist_url": playlist.share_url if hasattr(playlist, "share_url") else f"https://tidal.com/playlist/{playlist_id}",
        "track_count": track_count,
        "tracks": tracks_data,
    }

    # Write JSON
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\n📄 JSON written to: {OUTPUT_JSON}")

    # Write CSV
    csv_headers = ["tidal_id", "title", "artists", "album", "track_number", "disc_number", "duration_seconds", "duration_formatted", "isrc", "explicit", "popularity", "audio_quality", "tidal_url"]
    with open(OUTPUT_CSV, "w", encoding="utf-8") as f:
        f.write(",".join(csv_headers) + "\n")
        for t in tracks_data:
            row = [str(t.get(h, "")) for h in csv_headers]
            # CSV-escape fields with commas
            escaped = [f'"{v}"' if "," in v else v for v in row]
            f.write(",".join(escaped) + "\n")
    print(f"📊 CSV written to: {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
