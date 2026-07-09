import { execSync } from 'child_process';
import * as os from 'os';

let savedMicVolume: number | null = null;

function isMacOS(): boolean {
  return os.platform() === 'darwin';
}

export async function getMicVolume(): Promise<number> {
  if (!isMacOS()) {
    return 50;
  }
  try {
    const output = execSync(
      'osascript -e "input volume of (get volume settings)"',
      { encoding: 'utf-8' },
    );
    const parsed = parseInt(output.trim(), 10);
    if (Number.isNaN(parsed)) {
      return 50;
    }
    return Math.max(0, Math.min(100, parsed));
  } catch {
    return 50;
  }
}

export async function setMicVolume(level: number): Promise<void> {
  if (!isMacOS()) {
    return;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  try {
    execSync(`osascript -e "set volume input volume ${clamped}"`);
  } catch {
    // ignore
  }
}

export async function getMicMuted(): Promise<boolean> {
  if (!isMacOS()) {
    return false;
  }
  try {
    const output = execSync(
      'osascript -e "output muted of (get volume settings)"',
      { encoding: 'utf-8' },
    );
    return output.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export async function setMicMuted(muted: boolean): Promise<void> {
  if (!isMacOS()) {
    return;
  }
  try {
    if (muted) {
      const current = await getMicVolume();
      savedMicVolume = current;
      await setMicVolume(0);
    } else {
      const restore = savedMicVolume ?? 50;
      savedMicVolume = null;
      await setMicVolume(restore);
    }
  } catch {
    // ignore
  }
}
