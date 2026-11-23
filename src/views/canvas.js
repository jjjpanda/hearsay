export const PALETTES = {
  dark: {
    NEWS: '#72b4eb',
    INK: '#eae6dc', MUTED: '#adb5ba', GRID: '#ffffff1f', ACCENT: '#f45b69',
    BAR: '#8d979c', UP: '#38daa4', DOWN: '#f45b69',
    TYPE_INK: { maker: '#f0ece2', value: '#c5ccd0', trend: '#99a3a8', random: '#7a8489' }
  },
  light: {
    NEWS: '#1b3654',
    INK: '#221f1c', MUTED: '#575046', GRID: '#221f1c1c', ACCENT: '#802230',
    BAR: '#575046', UP: '#18765c', DOWN: '#802230',
    TYPE_INK: { maker: '#221f1c', value: '#46423d', trend: '#66615a', random: '#88827a' }
  }
};

export const LANE_LABELS = { maker: 'Makers', value: 'Value', trend: 'Trend', random: 'Random' };
const surfacePalettes = new WeakMap();
export const CANVAS_SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
export const CANVAS_FONT = 'ui-monospace, "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace';

export function prepareSurface(canvas, palette) {
  const { width, height } = canvas.getBoundingClientRect();
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const targetWidth = Math.round(width * dpr);
  const targetHeight = Math.round(height * dpr);

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  const ctx = canvas.getContext('2d');
  surfacePalettes.set(ctx, palette);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  return { ctx, w: width, h: height };
}

export function drawText(ctx, text, x, y, { color = surfacePalettes.get(ctx).MUTED, align = 'left', weight = 400, family = 'mono' } = {}) {
  ctx.font = `${weight} 10px ${family === 'sans' ? CANVAS_SANS : CANVAS_FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

export function drawLine(ctx, x1, y1, x2, y2, color, dash = []) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawPath(ctx, points, color, width = 1.5, dash = []) {
  if (!points.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  if (!dash.length && points.length > 1) {
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = width + 0.9;
    ctx.stroke();
  }
  ctx.restore();
}

export function drawDot(ctx, x, y, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

export function sampleModelAt(model, seconds, span, params, context = {}) {
  const defaults = { q: 1, time: 0, impact: 0, price: 100, mid: 100, spread: 0, buyDepth: 0, sellDepth: 0 };
  const { rates, share } = model.evaluate(Object.freeze({ ...defaults, ...context, ...params, t: seconds, W: span }));
  return { seconds, share, rates, rate: rates ? rates.reduce((sum, r) => sum + r, 0) : 0 };
}

export function drawGlyph(ctx, type, x, y, r, filled = true) {
  ctx.beginPath();
  if (type === 'maker') {
    ctx.rect(x - r, y - r, r * 2, r * 2);
  } else if (type === 'trend') {
    ctx.moveTo(x, y - r - 1);
    ctx.lineTo(x + r + 1, y + r);
    ctx.lineTo(x - r - 1, y + r);
    ctx.closePath();
  } else if (type === 'random') {
    ctx.moveTo(x, y - r - 1);
    ctx.lineTo(x + r + 1, y);
    ctx.lineTo(x, y + r + 1);
    ctx.lineTo(x - r - 1, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  if (filled) ctx.fill();
  else ctx.stroke();
}
