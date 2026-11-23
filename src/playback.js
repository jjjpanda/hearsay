export const SPEEDS = [1, 4, 16, 64, 128, 256];

export class Playback {
  constructor() {
    this.playing = true;
    this.speed = 64;
    this.pending = 0;
    this.last = null;
  }

  clear() {
    this.pending = 0;
    this.last = null;
  }

  pause() {
    this.playing = false;
    this.clear();
  }

  tick(now, hidden, advance, measure = () => performance.now()) {
    if (hidden || !this.playing) {
      this.clear();
      return false;
    }

    const elapsedWallMs = this.last === null ? 0 : Math.max(0, now - this.last);
    this.last = now;
    this.pending += elapsedWallMs * this.speed;

    const frameStartTime = measure();
    let advancedAny = false;

    while (this.pending > 0 && measure() - frameStartTime < 8) {
      const chunkMs = Math.min(250, this.pending);
      advance(chunkMs);
      if (!this.playing) break;
      this.pending -= chunkMs;
      advancedAny = true;
    }

    return advancedAny;
  }
}
