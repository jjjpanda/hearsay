function createAttemptCounts() {
  return { generated: 0, buys: 0, sells: 0, sizes: {} };
}

export function createDiagnostics() {
  return {
    baseline: { ...createAttemptCounts(), expected: 0, sinceMs: 0 },
    informed: { ...createAttemptCounts(), expected: 0, unrouted: 0 },
    submitted: { baseline: 0, informed: 0, maker: 0 }
  };
}

export function countAttempt(market, origin, size, side) {
  const counts = market.diagnostics[origin];
  counts.generated++;
  counts.sizes[size] = (counts.sizes[size] ?? 0) + 1;
  if (side) counts[side === 'buy' ? 'buys' : 'sells']++;
}
