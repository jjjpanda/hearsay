export function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function uniform(stream) {
  stream.seed = (Math.imul(stream.seed, 1664525) + 1013904223) >>> 0;
  return (stream.seed + 0.5) / 4294967296;
}

export function gammaMultiplier(stream, shape = 3) {
  let sum = 0;
  for (let i = 0; i < shape; i++) {
    sum += -Math.log1p(-uniform(stream));
  }
  return sum / shape;
}

export function waitingMs(stream, multiplier = 1) {
  return (-Math.log1p(-uniform(stream)) * 1000) / (stream.rate * multiplier);
}

export function atOrBefore(series, targetMs) {
  const n = series.length;
  if (!n) return null;
  if (series[0].timeMs > targetMs) return series[0];
  let low = 0;
  let high = n - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (series[mid].timeMs <= targetMs) low = mid;
    else high = mid - 1;
  }
  return series[low];
}

export function elapsed(timeMs) {
  const totalSeconds = Math.floor(timeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map(unit => String(unit).padStart(2, '0'))
    .join(':');
}

export function signed(percent, digits = 1) {
  return `${percent > 0 ? '+' : ''}${percent.toFixed(digits)}%`;
}

export function credits(ticks) {
  return (ticks / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

const compactMoney = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', notation: 'compact', maximumSignificantDigits: 2, signDisplay: 'exceptZero'
});

export const money = ticks => compactMoney.format(Math.round(ticks / 100)).replace('-', '−');
