import { uniform } from './clock.js';
import { sampleModel } from './model.js';

export function activeEpisode(market) {
  if (market.episodeId === null) return null;
  const last = market.events.at(-1);
  if (last?.id === market.episodeId) return last;
  return market.events.find(event => event.id === market.episodeId) ?? null;
}

export function isInformed(market, agent) {
  const episode = activeEpisode(market);
  return episode !== null && agent.receivedEpisodeId === episode.id;
}

export function informedAgents(market) {
  return market.agents.filter(agent => (agent.type === 'value' || agent.type === 'trend') && isInformed(market, agent));
}

export function diffuse(market) {
  const episode = activeEpisode(market);
  if (!episode) {
    return;
  }
  const share = market.modelSample.share;
  for (const agent of market.agents) {
    if (agent.reach <= share) receive(market, agent, episode, false);
  }
}

export function releasePublic(market) {
  const episode = activeEpisode(market);
  if (!episode || market.timeMs < episode.releaseMs) {
    return;
  }
  for (const agent of market.agents) {
    receive(market, agent, episode, true);
  }
  market.episodeId = null;
}

export const EPISODE_BINS = 120;
export const BURST_FLOOR = 1.5;

function informedBursts(stream, W) {
  return Array.from({ length: Math.max(3, Math.round(W / 45)) }, () => ({
    at: W * (0.1 + 0.85 * uniform(stream)),
    width: W * (0.03 + 0.04 * uniform(stream)),
    height: 0.4 + 0.8 * uniform(stream)
  }));
}

export function burstLevel(episode, seconds) {
  const bursts = episode.bursts ?? [];
  const mass = episode.burstMass ??
    bursts.reduce((sum, b) => sum + b.height * b.width * Math.sqrt(2 * Math.PI), 0) / episode.durationSeconds;
  let level = 0;
  for (let i = 0; i < bursts.length; i++) {
    const b = bursts[i];
    const z = (seconds - b.at) / b.width;
    level += b.height * Math.exp(-0.5 * z * z);
  }
  return (BURST_FLOOR + level) / (BURST_FLOOR + mass);
}

export function startEpisode(market, impact, durationSeconds) {
  if (activeEpisode(market)) {
    throw new Error('A private episode is active. Wait for its public release.');
  }

  const value = Math.max(1, market.value * (1 + impact / 100));
  const bursts = informedBursts(market.informed, durationSeconds);
  const burstMass = bursts.reduce((sum, b) => sum + b.height * b.width * Math.sqrt(2 * Math.PI), 0) / durationSeconds;
  const episode = {
    id: ++market.signalSequence,
    startMs: market.timeMs,
    startPrice: market.price,
    releaseMs: market.timeMs + durationSeconds * 1000,
    durationSeconds,
    impact,
    delta: value - market.value,
    value,
    share: 0,
    params: market.episodeParams(),
    bursts,
    burstMass,
    arrivals: new Array(EPISODE_BINS).fill(0)
  };

  market.value = value;
  market.events.push(episode);
  market.episodeId = episode.id;
  if (market.events.length > 40) {
    market.events.shift();
  }
  sampleModel(market, episode);
  diffuse(market);
  return episode;
}

export function knowledge(market, episode = market.events.at(-1), type = null) {
  const agents = type ? market.agents.filter(agent => agent.type === type) : market.agents;
  const known = !episode
    ? 0
    : market.timeMs >= episode.releaseMs
      ? agents.length
      : agents.filter(agent => agent.receivedEpisodeId === episode.id).length;
  return { total: agents.length, known, waiting: agents.length - known };
}

function receive(market, agent, episode, publicNews) {
  if (!publicNews && agent.receivedEpisodeId === episode.id) return;
  if (agent.receivedEpisodeId !== episode.id) {
    const prior = agent.pendingTarget ?? agent.knownValue;
    agent.receivedEpisodeId = episode.id;
    agent.pendingTarget = null;
    agent.signal = { episodeId: episode.id, receivedMs: market.timeMs, prior, error: uniform(market.signals) * 2 - 1, public: false, disagreement: market.settings.uncertainty / 100 };
  }
  const signal = agent.signal;
  if (signal.public || (agent.pendingTarget !== null && !publicNews)) return;
  const error = signal.error * 4 * signal.disagreement * Math.abs(episode.delta);
  agent.pendingTarget = Math.max(1, signal.prior + (publicNews ? episode.delta + 0.5 * error : agent.confidence * (episode.delta + error)));
  if (publicNews) signal.public = true;
}
