import { NEUTRAL } from '../src/model.js';

const kernel = q => Math.exp(-2 * Math.log(q / 50) ** 2);

export const model = {
  id: 'test-bump',
  params: [['h', 'Insider activity (h)', 'Informed rate multiplier', 0, 2, 0.05, 1]],
  noise: NEUTRAL.noise,
  penetration: (seconds, windowSeconds) => 0.05 + 0.9 * NEUTRAL.penetration(seconds, windowSeconds),
  informed: (seconds, windowSeconds, { h }) => NEUTRAL.noise.map((weight, i) => h * weight * kernel(i + 1))
};
