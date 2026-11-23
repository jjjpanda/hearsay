const hash = n => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
};

let paperValley = null;
let paperPeak = null;
let paperGrain = null;
let paperVersion = 0;
const paperListeners = new Set();

export function onPaperReady(listener) {
  paperListeners.add(listener);
  return () => paperListeners.delete(listener);
}

if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  const paper = new Image();
  paper.crossOrigin = 'anonymous';
  paper.onload = () => {
    try {
      const surface = document.createElement('canvas');
      surface.width = surface.height = 512;
      const context = surface.getContext('2d');
      if (!context) return;
      context.drawImage(paper, 0, 0, 512, 512);
      const { data } = context.getImageData(0, 0, 512, 512);

      const valley = new Uint8Array(512 * 512);
      const peak = new Uint8Array(512 * 512);
      const grain = new Float32Array(64 * 64);
      const counts = new Uint16Array(64 * 64);

      for (let y = 0; y < 512; y++) {
        const gy = y >> 3;
        for (let x = 0; x < 512; x++) {
          const idx = (y << 9) | x;
          const p4 = idx << 2;
          const lum = (data[p4] * 0.3 + data[p4 + 1] * 0.59 + data[p4 + 2] * 0.11) / 255;
          const relief = 1 - lum;
          valley[idx] = Math.round(255 * Math.min(1, Math.max(0.58, 0.62 + relief * 4.2)));
          peak[idx] = Math.round(255 * Math.min(1, Math.max(0.58, 0.98 - relief * 3.8)));
          const gi = (gy << 6) | (x >> 3);
          grain[gi] += lum;
          counts[gi]++;
        }
      }
      for (let i = 0; i < grain.length; i++) {
        const avg = grain[i] / Math.max(1, counts[i]);
        grain[i] = Math.max(0.76, Math.min(1.22, 0.78 + (1 - avg) * 4.0));
      }

      paperValley = valley;
      paperPeak = peak;
      paperGrain = grain;
      paperVersion++;
      for (const listener of paperListeners) listener();
    } catch {
      paperValley = null;
      paperPeak = null;
      paperGrain = null;
    }
  };
  paper.src = new URL('../paper.jpg', import.meta.url).href;
}

export class InkFluid {
  constructor() {
    this.gw = 0;
    this.gh = 0;
    this.w = 0;
    this.h = 0;
    this.active = false;
    this.hasPaint = false;
    this.dirtyRender = false;
    this.offscreen = null;
    this.offCtx = null;
    this.imgData = null;
    this.cachedOffset = null;
    this.permVersion = -1;
    this.renderedPaperVersion = -1;
  }

  invalidateLayout() {
    this.cachedOffset = null;
  }

  channels(channel) {
    if (channel === 'up') return { pig: this.pigU, dry: this.dryU };
    if (channel === 'down') return { pig: this.pigD, dry: this.dryD };
    return { pig: this.pigN, dry: this.dryN };
  }

  reset() {
    if (!this.gw) return;
    this.wet.fill(0);
    this.u.fill(0);
    this.v.fill(0);
    this.pigN.fill(0);
    this.pigU.fill(0);
    this.pigD.fill(0);
    this.dryN.fill(0);
    this.dryU.fill(0);
    this.dryD.fill(0);
    this.active = false;
    this.hasPaint = false;
    this.dirtyRender = true;
    this.renderedLight = null;
  }

  fadeDry(factor = 0.35) {
    if (!this.gw) return;
    this.wet.fill(0);
    this.u.fill(0);
    this.v.fill(0);
    this.pigN.fill(0);
    this.pigU.fill(0);
    this.pigD.fill(0);
    for (let i = 0; i < this.dryN.length; i++) {
      this.dryN[i] *= factor;
      this.dryU[i] *= factor;
      this.dryD[i] *= factor;
    }
    this.active = false;
    this.hasPaint = this.hasPaint && factor > 0;
    this.dirtyRender = true;
    this.renderedLight = null;
  }

  decayDry(factor = 0.996) {
    if (!this.gw || factor >= 1) return;
    let changed = false;
    let anyDry = false;
    for (let i = 0; i < this.dryN.length; i++) {
      if (this.dryN[i] > 0) {
        this.dryN[i] *= factor;
        if (this.dryN[i] < 0.004) this.dryN[i] = 0;
        else anyDry = true;
        changed = true;
      }
      if (this.dryU[i] > 0) {
        this.dryU[i] *= factor;
        if (this.dryU[i] < 0.004) this.dryU[i] = 0;
        else anyDry = true;
        changed = true;
      }
      if (this.dryD[i] > 0) {
        this.dryD[i] *= factor;
        if (this.dryD[i] < 0.004) this.dryD[i] = 0;
        else anyDry = true;
        changed = true;
      }
    }
    if (!anyDry && !this.active) this.hasPaint = false;
    if (changed) this.dirtyRender = true;
  }

  syncPermeability() {
    if (!this.gw || this.permVersion === paperVersion) return;
    this.permVersion = paperVersion;
    const { gw, gh, perm } = this;
    for (let y = 0; y < gh; y++) {
      const gy = (y * 2) & 63;
      for (let x = 0; x < gw; x++) {
        if (paperGrain) {
          perm[y * gw + x] = paperGrain[(gy << 6) | ((x * 2) & 63)];
        } else {
          const nx = x * 0.07;
          const ny = y * 0.07;
          perm[y * gw + x] = 0.94 + 0.06 * Math.sin(nx + Math.cos(ny)) * Math.cos(ny * 1.3);
        }
      }
    }
  }

  ensureSize(w, h) {
    const cell = Math.max(3, Math.sqrt((w * h) / 18000));
    const gw = Math.max(24, Math.round(w / cell));
    const gh = Math.max(16, Math.round(h / cell));
    if (gw === this.gw && gh === this.gh) {
      if (this.w !== w || this.h !== h) this.invalidateLayout();
      this.w = w;
      this.h = h;
      this.syncPermeability();
      return false;
    }
    this.gw = gw;
    this.gh = gh;
    this.w = w;
    this.h = h;
    this.invalidateLayout();
    const n = gw * gh;
    this.perm = new Float32Array(n);
    this.wet = new Float32Array(n);
    this.wetNext = new Float32Array(n);
    this.u = new Float32Array(n);
    this.uNext = new Float32Array(n);
    this.v = new Float32Array(n);
    this.vNext = new Float32Array(n);
    this.pigN = new Float32Array(n);
    this.pigNNext = new Float32Array(n);
    this.dryN = new Float32Array(n);
    this.pigU = new Float32Array(n);
    this.pigUNext = new Float32Array(n);
    this.dryU = new Float32Array(n);
    this.pigD = new Float32Array(n);
    this.pigDNext = new Float32Array(n);
    this.dryD = new Float32Array(n);
    this.total = new Float32Array(n);
    this.smooth = new Float32Array(n);
    this.scratch = new Float32Array(n);
    this.active = false;
    this.hasPaint = false;
    this.renderedLight = null;
    this.permVersion = -1;
    this.syncPermeability();

    if (typeof document !== 'undefined') {
      this.offscreen = document.createElement('canvas');
      this.offscreen.width = gw;
      this.offscreen.height = gh;
      this.offCtx = this.offscreen.getContext('2d');
      this.imgData = this.offCtx ? this.offCtx.createImageData(gw, gh) : null;
    }
    this.dirtyRender = true;
    return true;
  }

  injectDroplet(px, py, radiusPx, strength, seed, dripStrength = 0, channel = 'news', vx = 0, vy = 0) {
    if (!this.gw || !this.w || !this.h) return;
    const gx = (px / this.w) * this.gw;
    const gy = (py / this.h) * this.gh;
    const grX = Math.max(1.8, (radiusPx / this.w) * this.gw);
    const grY = Math.max(1.8, (radiusPx / this.h) * this.gh);
    const x0 = Math.max(1, Math.floor(gx - grX - 2));
    const x1 = Math.min(this.gw - 2, Math.ceil(gx + grX + 2));
    const y0 = Math.max(1, Math.floor(gy - grY - 2));
    const y1 = Math.min(this.gh - 2, Math.ceil(gy + grY + 2));
    const { gw, perm, wet, u, v } = this;
    const { pig } = this.channels(channel);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - gx) / grX;
        const dy = (y - gy) / grY;
        const angle = Math.atan2(dy, dx);
        const lobe = 1 + 0.14 * Math.sin(angle * 3 + seed) + 0.08 * Math.cos(angle * 5 - seed * 1.3);
        const dist = Math.hypot(dx, dy) / lobe;
        if (dist >= 1) continue;
        const idx = y * gw + x;
        const falloff = (1 - dist * dist) ** 2;
        const addH = strength * falloff * (0.75 + 0.45 * perm[idx]);
        wet[idx] = Math.min(1.6, wet[idx] + addH);
        pig[idx] = Math.min(1.6, pig[idx] + addH * 0.94);
        const len = Math.max(0.4, Math.hypot(x - gx, y - gy));
        u[idx] += ((x - gx) / len) * 1.1 * strength + vx * falloff;
        v[idx] += ((y - gy) / len) * 1.1 * strength + dripStrength * (dy > 0 ? 1.15 : 0.45) * falloff + vy * falloff;
      }
    }
    this.active = true;
    this.hasPaint = true;
    this.dirtyRender = true;
  }

  injectMiddleSwell(centerXPx, y0Px, y1Px, strength, seed, channel = 'news', wetMode = true) {
    if (!this.gw || !this.w || !this.h || y1Px <= y0Px) return;
    const startGy = 1;
    const spanGy = Math.max(1, this.gh - 2 - startGy);
    const gy0 = Math.max(startGy, Math.floor(startGy + (y0Px / this.h) * spanGy));
    const gy1 = Math.min(this.gh - 2, Math.ceil(startGy + (y1Px / this.h) * spanGy));
    const centerGx = (centerXPx / this.w) * this.gw;
    const { gw, perm, wet, u, v } = this;
    const { pig, dry } = this.channels(channel);

    for (let y = gy0; y <= gy1; y++) {
      const spanFrac = Math.max(0, Math.min(1, (y - startGy) / spanGy));
      const yTaper = 0.55 + 0.45 * Math.sin(spanFrac * Math.PI);
      const lobe = 1 + 0.16 * Math.sin(spanFrac * 9 + seed);
      const halfWidthPx = Math.max(14, Math.min(24, 18 * yTaper * lobe));
      const halfGx = (halfWidthPx / this.w) * gw;
      const xMin = Math.max(1, Math.floor(centerGx - halfGx));
      const xMax = Math.min(gw - 2, Math.ceil(centerGx + halfGx));
      for (let x = xMin; x <= xMax; x++) {
        const dx = x - centerGx;
        const dxNorm = Math.abs(dx) / Math.max(0.5, halfGx);
        if (dxNorm >= 1) continue;
        const idx = y * gw + x;
        const bell = (1 - dxNorm * dxNorm) ** 1.8;
        const fiber = 0.78 + 0.34 * perm[idx];
        if (wetMode) {
          const targetW = Math.min(1.2, strength * 0.92 * bell * fiber);
          const targetP = Math.min(1.1, targetW * 0.92);
          if (targetW > wet[idx]) wet[idx] = targetW;
          if (targetP > pig[idx]) pig[idx] = targetP;
          u[idx] += Math.sign(dx || (x % 2 ? 1 : -1)) * (1 - dxNorm) * 2.6 * strength;
          v[idx] = Math.max(v[idx], (2.2 + 1.4 * (1 - dxNorm)) * strength);
        } else {
          const targetD = strength * 0.35 * bell * fiber;
          if (targetD > dry[idx]) dry[idx] = targetD;
        }
      }
    }
    if (wetMode) this.active = true;
    this.hasPaint = true;
    this.dirtyRender = true;
  }

  settleAll() {
    if (!this.gw || !this.active) return;
    const n = this.gw * this.gh;
    for (let i = 0; i < n; i++) {
      if (this.pigN[i] > 0) this.dryN[i] = Math.min(1.8, this.dryN[i] + this.pigN[i]);
      if (this.pigU[i] > 0) this.dryU[i] = Math.min(1.8, this.dryU[i] + this.pigU[i]);
      if (this.pigD[i] > 0) this.dryD[i] = Math.min(1.8, this.dryD[i] + this.pigD[i]);
      this.wet[i] = 0;
      this.pigN[i] = 0;
      this.pigU[i] = 0;
      this.pigD[i] = 0;
      this.u[i] = 0;
      this.v[i] = 0;
    }
    this.active = false;
    this.dirtyRender = true;
  }

  stampDryResidue(px, py, radiusPx, strength, seed, channel = 'news') {
    if (!this.gw || !this.w || !this.h) return;
    const gx = (px / this.w) * this.gw;
    const gy = (py / this.h) * this.gh;
    const grX = Math.max(1.5, (radiusPx / this.w) * this.gw);
    const grY = Math.max(1.5, (radiusPx / this.h) * this.gh);
    const x0 = Math.max(0, Math.floor(gx - grX - 1));
    const x1 = Math.min(this.gw - 1, Math.ceil(gx + grX + 1));
    const y0 = Math.max(0, Math.floor(gy - grY - 1));
    const y1 = Math.min(this.gh - 1, Math.ceil(gy + grY + 1));
    const { gw, perm } = this;
    const { dry } = this.channels(channel);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - gx) / grX;
        const dy = (y - gy) / grY;
        const angle = Math.atan2(dy, dx);
        const lobe = 1 + 0.10 * Math.sin(angle * 3 + seed);
        const dist = Math.hypot(dx, dy) / lobe;
        if (dist >= 1) continue;
        const idx = y * gw + x;
        const falloff = (1 - dist * dist) ** 2;
        dry[idx] = Math.min(1.4, dry[idx] + strength * falloff * (0.7 + 0.4 * perm[idx]));
      }
    }
    this.hasPaint = true;
    this.dirtyRender = true;
  }

  step(dtSec, isLight = true) {
    if (!this.active || !this.gw || dtSec <= 0) return;
    const hDt = Math.min(0.05, dtSec);
    const { gw, gh, perm, wet, wetNext, pigN, pigNNext, pigU, pigUNext, pigD, pigDNext, u, uNext, v, vNext, dryN, dryU, dryD } = this;
    const dampX = Math.exp(-3.0 * hDt);
    const dampY = Math.exp(-2.2 * hDt);
    const press = isLight ? 10 : 8;
    const grav = isLight ? 9 : 7;
    const stay = isLight ? 0.14 : 0.18;
    const move = 1 - stay;
    this.dirtyRender = true;

    for (let y = 1; y < gh - 1; y++) {
      const row = y * gw;
      for (let x = 1; x < gw - 1; x++) {
        const i = row + x;
        const hi = wet[i];
        if (hi <= 0.002) continue;
        const pL = wet[i - 1] * (0.6 + 0.6 * perm[i - 1]);
        const pR = wet[i + 1] * (0.6 + 0.6 * perm[i + 1]);
        const pU = wet[i - gw] * (0.6 + 0.6 * perm[i - gw]);
        const pD = wet[i + gw] * (0.6 + 0.6 * perm[i + gw]);
        const nu = (u[i] - press * (pR - pL) * hDt) * dampX;
        const nv = (v[i] - press * (pD - pU) * hDt) * dampY + grav * Math.min(1.0, hi * 1.6) * perm[i] * hDt;
        u[i] = nu > 12 ? 12 : nu < -12 ? -12 : nu;
        v[i] = nv > 8 ? 8 : nv < -8 ? -8 : nv;
      }
    }

    wetNext.fill(0);
    pigNNext.fill(0);
    pigUNext.fill(0);
    pigDNext.fill(0);
    uNext.fill(0);
    vNext.fill(0);

    const splat = (idx, wt, w0, pN0, pU0, pD0, mx0, my0) => {
      wetNext[idx] += w0 * wt;
      pigNNext[idx] += pN0 * wt;
      pigUNext[idx] += pU0 * wt;
      pigDNext[idx] += pD0 * wt;
      uNext[idx] += mx0 * wt;
      vNext[idx] += my0 * wt;
    };

    for (let y = 1; y < gh - 1; y++) {
      const row = y * gw;
      for (let x = 1; x < gw - 1; x++) {
        const i = row + x;
        const w0 = wet[i];
        if (w0 <= 0.001) continue;
        const pN0 = pigN[i];
        const pU0 = pigU[i];
        const pD0 = pigD[i];
        const mx0 = w0 * u[i];
        const my0 = w0 * v[i];
        splat(i, stay, w0, pN0, pU0, pD0, mx0, my0);

        const tx = Math.max(1, Math.min(gw - 2.001, x + Math.max(-0.95, Math.min(0.95, u[i] * hDt))));
        const ty = Math.max(1, Math.min(gh - 2.001, y + Math.max(-0.95, Math.min(0.45, v[i] * hDt))));
        const x0 = tx | 0;
        const y0 = ty | 0;
        const fx = tx - x0;
        const fy = ty - y0;
        const i00 = y0 * gw + x0;
        splat(i00, move * (1 - fx) * (1 - fy), w0, pN0, pU0, pD0, mx0, my0);
        splat(i00 + 1, move * fx * (1 - fy), w0, pN0, pU0, pD0, mx0, my0);
        splat(i00 + gw, move * (1 - fx) * fy, w0, pN0, pU0, pD0, mx0, my0);
        splat(i00 + gw + 1, move * fx * fy, w0, pN0, pU0, pD0, mx0, my0);
      }
    }

    for (let y = 1; y < gh - 1; y++) {
      const row = y * gw;
      for (let x = 1; x < gw - 1; x++) {
        const i = row + x;
        const wn = wetNext[i];
        if (wn > 0.002) {
          const nu = uNext[i] / wn;
          const nv = vNext[i] / wn;
          u[i] = nu > 12 ? 12 : nu < -12 ? -12 : nu;
          v[i] = nv > 8 ? 8 : nv < -8 ? -8 : nv;
        } else {
          u[i] = 0;
          v[i] = 0;
        }
      }
    }

    const capRate = isLight ? 4.2 : 2.0;
    const blend = (arr, i, cap) => {
      const cur = arr[i];
      const avg = 0.25 * (arr[i - 1] + arr[i + 1] + arr[i - gw] + arr[i + gw]);
      return Math.min(1.8, cur + cap * (avg - cur));
    };
    let anyWet = false;
    for (let y = 1; y < gh - 1; y++) {
      const row = y * gw;
      for (let x = 1; x < gw - 1; x++) {
        const i = row + x;
        const cap = Math.min(0.16, capRate * perm[i] * hDt);
        const hi = blend(wetNext, i, cap);
        const pN = blend(pigNNext, i, cap);
        const pU = blend(pigUNext, i, cap);
        const pD = blend(pigDNext, i, cap);
        const evap = hi <= 0.002
          ? hi
          : (isLight ? 0.16 + 0.14 * Math.exp(-hi * 2.5) : 0.13 + 0.10 * Math.exp(-hi * 2.2)) * hDt;
        const dh = Math.min(hi, evap);
        const wRem = hi - dh;
        if (wRem <= 0.002) {
          if (pN > 0.0005) dryN[i] = Math.min(1.8, dryN[i] + pN);
          if (pU > 0.0005) dryU[i] = Math.min(1.8, dryU[i] + pU);
          if (pD > 0.0005) dryD[i] = Math.min(1.8, dryD[i] + pD);
          wet[i] = pigN[i] = pigU[i] = pigD[i] = u[i] = v[i] = 0;
          continue;
        }
        anyWet = true;
        const pinFrac = dh / (hi + 0.04);
        const pinN = pN * pinFrac;
        const pinU = pU * pinFrac;
        const pinD = pD * pinFrac;
        dryN[i] = Math.min(1.8, dryN[i] + pinN);
        dryU[i] = Math.min(1.8, dryU[i] + pinU);
        dryD[i] = Math.min(1.8, dryD[i] + pinD);
        wet[i] = wRem;
        pigN[i] = Math.max(0, pN - pinN);
        pigU[i] = Math.max(0, pU - pinU);
        pigD[i] = Math.max(0, pD - pinD);
      }
    }
    this.active = anyWet;
  }

  render(ctx, left, top, w, h, isLight = true) {
    if (!this.imgData || !this.offCtx || !this.gw) return;
    this.syncPermeability();

    if (!this.cachedOffset || this.cachedOffset.left !== left || this.cachedOffset.top !== top) {
      let ox = 0;
      let oy = 0;
      if (ctx.canvas?.getBoundingClientRect) {
        const shell = ctx.canvas.getRootNode?.()?.querySelector?.('.shell');
        const canvasRect = ctx.canvas.getBoundingClientRect();
        const shellRect = shell?.getBoundingClientRect?.() ?? canvasRect;
        ox = Math.round(canvasRect.left - shellRect.left - (shell?.clientLeft ?? 0) + left);
        oy = Math.round(canvasRect.top - shellRect.top - (shell?.clientTop ?? 0) + top);
      }
      this.cachedOffset = { left, top, ox, oy };
    }

    if (this.dirtyRender || this.renderedLight !== isLight || this.renderedPaperVersion !== paperVersion) {
      this.dirtyRender = false;
      this.renderedLight = isLight;
      this.renderedPaperVersion = paperVersion;
      const { gw, gh, perm, pigN, dryN, pigU, dryU, pigD, dryD, total, smooth, scratch, imgData } = this;
      const data = imgData.data;
      const n = gw * gh;
      for (let i = 0; i < n; i++) {
        total[i] = dryN[i] + dryU[i] + dryD[i] + (pigN[i] + pigU[i] + pigD[i]) * 1.08;
      }

      for (let y = 0; y < gh; y++) {
        const row = y * gw;
        for (let x = 0; x < gw; x++) {
          scratch[row + x] = (
            total[row + Math.max(0, x - 1)] + 2 * total[row + x] + total[row + Math.min(gw - 1, x + 1)]
          ) * 0.25;
        }
      }
      for (let y = 0; y < gh; y++) {
        const yU = Math.max(0, y - 1) * gw;
        const yC = y * gw;
        const yD = Math.min(gh - 1, y + 1) * gw;
        for (let x = 0; x < gw; x++) {
          smooth[yC + x] = (scratch[yU + x] + 2 * scratch[yC + x] + scratch[yD + x]) * 0.25;
        }
      }
      const { ox, oy } = this.cachedOffset;
      const scaleX = w / gw;
      const scaleY = h / gh;
      const threshold = isLight ? 0.008 : 0.010;

      for (let y = 0; y < gh; y++) {
        const row = y * gw;
        const yUp = Math.max(0, y - 1) * gw;
        const yDn = Math.min(gh - 1, y + 1) * gw;
        const py = (oy + ((y * scaleY) | 0)) & 511;
        const pyShift = py << 9;
        for (let x = 0; x < gw; x++) {
          const i = row + x;
          const p4 = i << 2;
          const ink = smooth[i];
          if (ink <= threshold) {
            data[p4 + 3] = 0;
            continue;
          }

          const xLt = Math.max(0, x - 1);
          const xRt = Math.min(gw - 1, x + 1);
          let cN = dryN[i] + pigN[i] * 1.08;
          let cU = dryU[i] + pigU[i] * 1.08;
          let cD = dryD[i] + pigD[i] * 1.08;
          let sumC = cN + cU + cD;
          if (sumC < 0.005) {
            cN += dryN[row + xLt] + dryN[row + xRt] + dryN[yUp + x] + dryN[yDn + x]
              + pigN[row + xLt] + pigN[row + xRt] + pigN[yUp + x] + pigN[yDn + x];
            cU += dryU[row + xLt] + dryU[row + xRt] + dryU[yUp + x] + dryU[yDn + x]
              + pigU[row + xLt] + pigU[row + xRt] + pigU[yUp + x] + pigU[yDn + x];
            cD += dryD[row + xLt] + dryD[row + xRt] + dryD[yUp + x] + dryD[yDn + x]
              + pigD[row + xLt] + pigD[row + xRt] + pigD[yUp + x] + pigD[yDn + x];
            sumC = cN + cU + cD;
          }
          const invSum = sumC > 0.0001 ? 1 / sumC : 0;
          const wN = invSum ? cN * invSum : 1;
          const wU = invSum ? cU * invSum : 0;
          const wD = invSum ? cD * invSum : 0;
          const px = (ox + ((x * scaleX) | 0)) & 511;

          if (isLight) {
            const tooth = paperValley ? paperValley[pyShift | px] / 255 : (0.86 + 0.14 * perm[i]);
            const localInk = ink * (0.84 + 0.24 * tooth);
            const edge = Math.min(1, Math.max(0, (localInk - 0.012) / 0.024));
            const feather = edge * edge * (3 - 2 * edge);
            const gx = smooth[row + xRt] - smooth[row + xLt];
            const gy = smooth[yDn + x] - smooth[yUp + x];
            const grad = Math.sqrt(gx * gx + gy * gy);
            const body = (localInk * 0.9) / (1 + localInk * 1.9);
            const rim = Math.min(0.32, grad * 2.4) / (1 + localInk * 1.5);
            const dark = 1 - rim * 0.55 - body * 0.12;
            data[p4] = Math.round((wN * 34 + wU * 22 + wD * 146) * dark);
            data[p4 + 1] = Math.round((wN * 72 + wU * 128 + wD * 38) * dark);
            data[p4 + 2] = Math.round((wN * 118 + wU * 98 + wD * 56) * dark);
            data[p4 + 3] = Math.min(135, Math.round((body + rim) * feather * tooth * 190));
          } else {
            const tooth = paperPeak ? paperPeak[pyShift | px] / 255 : (0.86 + 0.14 * perm[i]);
            const localInk = ink * (0.84 + 0.24 * tooth);
            const edge = Math.min(1, Math.max(0, (localInk - 0.012) / 0.016));
            const feather = edge * edge * (3 - 2 * edge);
            const gx = smooth[row + xRt] - smooth[row + xLt];
            const gy = smooth[yDn + x] - smooth[yUp + x];
            const grad = Math.sqrt(gx * gx + gy * gy);
            const body = (localInk * 0.9) / (1 + localInk * 1.9);
            const rim = Math.min(0.36, grad * 2.6) / (1 + localInk * 1.5);
            const tone = 0.62 + rim * 0.7 + body * 0.08;
            data[p4] = Math.min(255, Math.round((wN * 70 + wU * 52 + wD * 228) * tone));
            data[p4 + 1] = Math.min(255, Math.round((wN * 140 + wU * 196 + wD * 82) * tone));
            data[p4 + 2] = Math.min(255, Math.round((wN * 214 + wU * 150 + wD * 98) * tone));
            data[p4 + 3] = Math.min(170, Math.round((body + rim * 1.1) * feather * tooth * 225));
          }
        }
      }
      this.offCtx.putImageData(imgData, 0, 0);
    }

    ctx.save();
    if (isLight) ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.offscreen, left, top, w, h);
    ctx.restore();
  }
}

export class InkPlayback {
  constructor() {
    this.fluid = new InkFluid();
    this.reset();
  }
  reset() {
    this.market = null;
    this.timeMs = null;
    this.clockMs = 0;
    this.stepAccumMs = 0;
    this.decayAccumMs = 0;
    this.lastWakeClockMs = -Infinity;
    this.episodeId = null;
    this.receipts = new Map();
    this.publicReceipt = null;
    this.absorbed = false;
    this.injected = new Set();
    this.publicSweepFrac = 0;
    this.fluid.reset();
  }
  update(market, delta = 0, playing = false, reducedMotion = false, isLight = true) {
    if (this.market !== market || (this.timeMs !== null && market.timeMs < this.timeMs)) this.reset();
    this.market = market;
    const now = market.timeMs;
    const previous = this.timeMs ?? now;
    const elapsed = now - previous;
    const wall = playing && elapsed > 0 ? Math.max(0, Math.min(100, delta)) : 0;
    this.clockMs += wall;
    const latest = market.events.at(-1);
    if (latest?.id !== this.episodeId) {
      this.receipts.clear();
      this.publicReceipt = null;
      this.absorbed = false;
      this.injected.clear();
      this.publicSweepFrac = 0;
      this.fluid.fadeDry(0.35);
      this.episodeId = latest?.id;
    }
    const since = playing ? previous : Math.max(previous, now - 1000);
    const birth = time => time >= since && time <= now
      ? this.clockMs - (elapsed > 0 ? wall * (now - time) / elapsed : 0) : null;
    for (const agent of market.agents) {
      if (!latest || agent.receivedEpisodeId !== latest.id) continue;
      const receipt = agent.signal?.receivedMs;
      if (receipt >= latest.releaseMs) continue;
      const existing = this.receipts.get(agent.id);
      if (!existing || existing.receivedMs !== receipt) {
        this.receipts.set(agent.id, { receivedMs: receipt, bornMs: Number.isFinite(receipt) ? birth(receipt) : null });
      }
    }
    if (latest && now >= latest.releaseMs && this.publicReceipt === null) {
      this.publicReceipt = { bornMs: birth(latest.releaseMs) };
    }
    if (latest && !this.absorbed) {
      const gap = latest.value - (latest.startPrice ?? latest.value);
      this.absorbed = now >= latest.releaseMs || (gap !== 0 && (market.price - latest.startPrice) / gap >= 1);
    }
    if (reducedMotion) {
      this.fluid.settleAll();
      this.stepAccumMs = 0;
      this.decayAccumMs = 0;
    } else if (wall > 0) {
      this.stepAccumMs += wall;
      if (this.stepAccumMs >= 24) {
        this.fluid.step(this.stepAccumMs / 1000, isLight);
        this.stepAccumMs = 0;
      }
      this.decayAccumMs += wall;
      if (this.decayAccumMs >= 60) {
        if (this.fluid.hasPaint && this.absorbed) {
          this.fluid.decayDry(Math.exp(-0.12 * this.decayAccumMs / 1000));
        }
        this.decayAccumMs = 0;
      }
    }
    this.timeMs = now;
  }
  wet(receipt, durationMs = 2200) {
    return receipt?.bornMs === null || receipt?.bornMs === undefined ? 0 :
      Math.max(0, 1 - (this.clockMs - receipt.bornMs) / durationMs);
  }
  traderWet(id) { return this.wet(this.receipts.get(id), 2200); }
  get publicWet() { return this.wet(this.publicReceipt, 1650); }
}

export const newsColor = (impact, isLight = true) =>
  isLight ? (impact >= 0 ? '#12986e' : '#c92a42') : (impact >= 0 ? '#38daa4' : '#f45b69');

export function drawBrushStroke(ctx, x1, y1, x2, y2, width, color, seed = 0, alpha = 1) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1 || width <= 0) return;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const steps = Math.max(4, Math.min(40, Math.round(len / 8)));
  const lift = Math.min(0.5, 14 / len);
  const edge = (t, k) => 0.82 + 0.13 * Math.sin(t * 9 + seed * k) + 0.07 * Math.sin(t * 31 + seed * k * 1.7);
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha *= alpha;
  ctx.beginPath();
  for (let side = 1; side >= -1; side -= 2) {
    for (let i = 0; i <= steps; i++) {
      const t = side > 0 ? i / steps : 1 - i / steps;
      const taper = Math.min(1, t / (lift * 0.6), (1 - t) / lift) ** 0.6;
      const half = width * 0.5 * (0.25 + 0.75 * taper) * edge(t, side > 0 ? 1 : 2.3);
      const x = x1 + (x2 - x1) * t + nx * half * side;
      const y = y1 + (y2 - y1) * t + ny * half * side;
      if (side > 0 && i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawInkWashBand(ctx, left, top, width, height, progress, seed = 0, isLight = true, impact = 0, alphaScale = 1) {
  const span = width * progress;
  if (span <= 2 || height <= 2) return;
  const color = newsColor(impact, isLight);
  const mag = Math.min(1, Math.max(0.25, Math.abs(impact) / 7));

  ctx.save();
  const grad = ctx.createLinearGradient?.(left, top + 2, left, top + height - 2);
  if (grad?.addColorStop) {
    grad.addColorStop(0, color);
    grad.addColorStop(0.55, color + '80');
    grad.addColorStop(1, color + '33');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = color;
  }
  if (isLight) ctx.globalCompositeOperation = 'multiply';
  const wash = (isLight ? 0.17 : 0.22) * (0.75 + 0.25 * mag) * alphaScale;
  const bottom = top + height - 2;
  ctx.globalAlpha = wash;
  ctx.beginPath();
  ctx.moveTo(left, top + 2);
  ctx.lineTo(left + span, top + 2);
  const bleed = Math.min(6, span * 0.08);
  for (let y = top + 2; y <= bottom; y += 24) {
    const t = (y - top) / height;
    ctx.lineTo(left + span + bleed * (0.5 + 0.5 * Math.sin(t * 13 + seed)), y);
  }
  ctx.lineTo(left + span, bottom);
  ctx.lineTo(left, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = wash * 1.6;
  ctx.fillRect(left, top + 2, Math.min(2, span), height - 4);
  ctx.restore();
  drawBrushStroke(ctx, left, top + 1.5, left + span, top + 1.5, 4, color, seed, alphaScale >= 0.8 ? 0.92 : 0.56);
}

export function drawWatercolorBloom(ctx, x, y, radius, wet, seed, color, impactSign = 0) {
  if (!(radius > 0.5) || wet <= 0.03) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  const startAngle = hash(seed + 2.3) * Math.PI * 2;
  const arcSpan = 0.85 + hash(seed + 5.7) * 0.9;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = startAngle + (i / 3) * arcSpan;
    const r = radius * (0.9 + 0.14 * Math.sin(a * 3 + seed));
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.lineWidth = 0.85;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.24 * wet;
  ctx.stroke();

  ctx.globalAlpha = 0.24 * wet;
  for (let k = 0; k < 2; k++) {
    const fa = hash(seed + k * 13.7) * Math.PI * 2;
    const fd = radius * (0.75 + hash(seed + k * 29.3) * 0.55);
    const fr = 0.65 + hash(seed + k * 41.1) * 0.8;
    const biasY = impactSign > 0 ? radius * 0.22 : impactSign < 0 ? -radius * 0.22 : 0;
    ctx.beginPath();
    ctx.arc(x + Math.cos(fa) * fd, y + Math.sin(fa) * fd + biasY, fr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawAcrylicDab(ctx, x, y, radius, wet, color) {
  if (!(radius > 0.5) || wet <= 0.04) return;
  const outer = radius * (0.68 + 0.32 * (1 - wet));
  ctx.save();

  const grad = ctx.createRadialGradient?.(x - outer * 0.25, y - outer * 0.25, 0.5, x, y, outer);
  if (grad?.addColorStop) {
    grad.addColorStop(0, '#eef7ff55');
    grad.addColorStop(0.55, color + '33');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = color;
  }
  ctx.globalAlpha = 0.72 * wet;
  ctx.beginPath();
  ctx.arc(x, y, outer, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineCap = 'round';
  ctx.strokeStyle = '#eef7ff';
  ctx.lineWidth = Math.max(1.0, outer * 0.13);
  ctx.globalAlpha = 0.68 * wet;
  ctx.beginPath();
  ctx.arc(x, y, outer * 0.48, Math.PI * 1.05, Math.PI * 1.68);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.78 * wet;
  ctx.beginPath();
  ctx.arc(x - outer * 0.28, y - outer * 0.28, Math.max(0.8, outer * 0.11), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawPublicSweep(ctx, centerX, top, height, progress, wet, palette, isLight = true) {
  const frac = Math.min(1, Math.max(0, progress));
  if (frac <= 0.01 || wet <= 0.01 || height <= 4) return;
  const spanY = height * frac;
  const frontY = top + spanY;
  const halfW = Math.min(16, 7 + 8 * wet);

  ctx.save();
  if (isLight) ctx.globalCompositeOperation = 'multiply';
  const washColor = isLight ? palette.NEWS : '#72b4eb';
  const grad = ctx.createLinearGradient?.(centerX - halfW, 0, centerX + halfW, 0);
  if (grad?.addColorStop) {
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.5, washColor);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = washColor;
  }
  ctx.globalAlpha = (isLight ? 0.14 : 0.2) * wet;
  ctx.fillRect(centerX - halfW, top, halfW * 2, spanY);

  if (!isLight) {
    const lineGrad = ctx.createLinearGradient?.(centerX, top, centerX, frontY);
    if (lineGrad?.addColorStop) {
      lineGrad.addColorStop(0, '#9cd0ff');
      lineGrad.addColorStop(1, '#eef7ff');
      ctx.strokeStyle = lineGrad;
    } else {
      ctx.strokeStyle = '#eef7ff';
    }
    ctx.beginPath();
    ctx.moveTo(centerX, top);
    ctx.lineTo(centerX, frontY);
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.48 * wet;
    ctx.stroke();
  }

  if (frac < 0.995) {
    ctx.fillStyle = isLight ? palette.NEWS : '#72b4eb';
    ctx.globalAlpha = (isLight ? 0.42 : 0.68) * wet;
    ctx.beginPath();
    ctx.arc(centerX, frontY, isLight ? 2.2 : 3.0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawInkBleed(ctx, x, y, radius, wet, color, isLight = true) {
  if (!(radius > 0.5) || wet <= 0.02) return;
  ctx.save();
  if (isLight) ctx.globalCompositeOperation = 'multiply';
  const grad = ctx.createRadialGradient?.(x, y, 0, x, y, radius);
  if (grad?.addColorStop) {
    grad.addColorStop(0, color + '58');
    grad.addColorStop(0.68, color + '1e');
    grad.addColorStop(0.9, color + '38');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = color;
  }
  ctx.globalAlpha = Math.min(1, wet) * (isLight ? 0.9 : 0.75);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const tracePath = (ctx, points) => points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));

export function drawInkBar(ctx, x, top, width, bottom, color, isLight = true, wet = 0) {
  const height = bottom - top;
  if (!(height > 0.5)) return;
  const left = x - width / 2;
  ctx.save();
  if (isLight) ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = color;
  ctx.globalAlpha = (isLight ? 0.08 : 0.12) * (1 + 1.5 * wet);
  ctx.fillRect(left - 1.5, top - 1.5, width + 3, height + 1.5);
  const grad = ctx.createLinearGradient?.(0, top, 0, bottom);
  if (grad?.addColorStop) {
    grad.addColorStop(0, color + 'e6');
    grad.addColorStop(0.3, color + '99');
    grad.addColorStop(1, color + '2e');
    ctx.fillStyle = grad;
  }
  ctx.globalAlpha = Math.min(1, (isLight ? 0.8 : 0.9) + 0.2 * wet);
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.95;
  ctx.fillRect(left, top, width, Math.min(2, height));
  if (width >= 3) {
    ctx.globalAlpha = 0.3;
    ctx.fillRect(left, top, 0.8, height);
    ctx.fillRect(left + width - 0.8, top, 0.8, height);
  }
  ctx.restore();
}

export function drawInkCurve(ctx, points, baseY, color, isLight = true, dash = [], washAlpha = 1) {
  if (points.length < 2) return;
  ctx.save();
  if (isLight) ctx.globalCompositeOperation = 'multiply';
  if (washAlpha > 0) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], baseY);
    tracePath(ctx, points);
    ctx.lineTo(points.at(-1)[0], baseY);
    ctx.closePath();
    const grad = ctx.createLinearGradient?.(0, Math.min(...points.map(p => p[1])), 0, baseY);
    if (grad?.addColorStop) {
      grad.addColorStop(0, color + '40');
      grad.addColorStop(1, color + '08');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = color;
    }
    ctx.globalAlpha = (isLight ? 0.7 : 0.85) * washAlpha;
    ctx.fill();
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.beginPath();
  tracePath(ctx, points);
  ctx.globalAlpha = 0.14;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.setLineDash?.(dash);
  ctx.globalAlpha = 0.92;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}
