import { mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'dist');

if (dirname(destination) !== resolve(root) || destination === resolve(root)) {
  throw new Error('Invalid build destination');
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const file of ['index.html', 'favicon.svg', 'marketsim.js']) {
  await copyFile(resolve(root, file), resolve(destination, file));
}

const modules = [
  'agents.js', 'analytics.js', 'clock.js', 'diagnostics.js', 'exchange.js',
  'flow.js', 'information.js', 'main.js', 'metrics.js', 'model.js', 'options.js',
  'page.js', 'panels.js', 'playback.js', 'sim.js', 'strategies.js', 'template.js',
  'view.js', 'style.css', 'paper.jpg',
  'views/canvas.js', 'views/field.js', 'views/history.js', 'views/ink.js', 'views/panels.js'
];
for (const dir of ['src', 'embed']) await mkdir(resolve(destination, dir));
for (const file of modules) {
  await mkdir(dirname(resolve(destination, 'src', file)), { recursive: true });
  await copyFile(resolve(root, 'src', file), resolve(destination, 'src', file));
}
await copyFile(resolve(root, 'embed/index.html'), resolve(destination, 'embed/index.html'));

console.log('Built dist/ — static files, no runtime dependencies');
await writeFile(resolve(destination, '.nojekyll'), '');
