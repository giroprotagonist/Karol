-- Open Ableton Live Preferences → Audio tab (best-effort; Live must be running).
tell application "System Events"
    if not (exists process "Live") then
        display notification "Open Ableton Live first, then re-run karol-show-night.sh" with title "Karol Show Night"
        return
    end if
    tell process "Live"
        set frontmost to true
        delay 0.5
        -- Live 11: Live menu → Preferences (Cmd+,)
        keystroke "," using command down
        delay 1.2
        -- Click Audio tab if visible
        try
            click button "Audio" of toolbar 1 of window 1
        end try
    end tell
end tell
display notification "Enable Input Config channels 1, 2, 3 (mono ch3)" with title "Karol — Live Audio Prefs"
