import { useCallback, useRef, useState } from 'react';

/**
 * Manages YouTube audio-only preview on the controller device.
 *
 * Requests `/api/youtube-dj/audio-stream` which runs yt-dlp to extract a
 * direct audio URL, then plays that URL in an <audio> element — much faster
 * than loading the full YouTube IFrame player.
 */
export function useYouTubePreview(host: string) {
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handlePreviewPlay = useCallback((videoId: string) => {
    // Stop any currently playing preview first
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setPreviewVideoId(videoId);
    setPreviewLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25_000);

    fetch(`${host}/api/youtube-dj/audio-stream?videoId=${encodeURIComponent(videoId)}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data: { ok?: boolean; url?: string; error?: string }) => {
        clearTimeout(timeoutId);
        if (!data.url) {
          console.warn('YouTube preview: no URL returned', data);
          setPreviewLoading(false);
          setPreviewVideoId(null);
          return;
        }
        const audio = new Audio(data.url);
        audio.volume = 0.7;
        audioRef.current = audio;
        // play() fires while we still have the user-gesture chain
        audio.play().catch((err) => {
          console.warn('YouTube preview play blocked:', err);
          setPreviewLoading(false);
          setPreviewVideoId(null);
        });
        audio.addEventListener('canplay', () => setPreviewLoading(false), { once: true });
        audio.addEventListener('error', () => {
          setPreviewLoading(false);
          setPreviewVideoId(null);
        }, { once: true });
        audio.addEventListener('ended', () => {
          setPreviewVideoId(null);
          setPreviewLoading(false);
        }, { once: true });
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        console.warn('YouTube preview fetch failed:', err);
        setPreviewLoading(false);
        setPreviewVideoId(null);
      });
  }, [host]);

  const handlePreviewStop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setPreviewVideoId(null);
    setPreviewLoading(false);
  }, []);

  return {
    previewVideoId,
    previewLoading,
    handlePreviewPlay,
    handlePreviewStop,
  };
}
