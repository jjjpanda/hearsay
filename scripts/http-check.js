import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { startServer, artifacts, root } from './browser-driver.js';

await access(resolve(root, 'dist/index.html'));
await access(resolve(root, 'dist/.nojekyll'));
const publicFiles = await readdir(resolve(root, 'dist'), { recursive: true });
assert.ok(!publicFiles.some(path => /\.(json|jsonl)$/i.test(path)), 'Build must exclude JSON files.');
assert.ok(!publicFiles.some(path => /(?:^|[\\/])(?:examples|test|docs|scripts)(?:[\\/]|$)/.test(path)), 'Build must exclude non-public directories.');

await mkdir(artifacts, { recursive: true });
const staging = await mkdtemp(resolve(artifacts, 'http-'));
let server;
try {
  await cp(resolve(root, 'dist'), resolve(staging, 'marketsim'), { recursive: true });
  server = await startServer(staging);
  const base = server.url + '/marketsim';

  for (const path of ['/', '/embed/']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const resource = await fetch(new URL(asset, base + path));
      assert.equal(resource.status, 200, `${path}: ${asset}`);
    }
  }

  for (const path of publicFiles.filter(path => /\.(js|css)$/.test(path))) {
    const url = base + '/' + path.replaceAll('\\', '/');
    const response = await fetch(url);
    assert.equal(response.status, 200, path);
    if (path.endsWith('.js')) {
      assert.match(response.headers.get('content-type'), /text\/javascript/);
      const source = await response.text();
      for (const [, dependency] of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
        if (!dependency.startsWith('.')) continue;
        const imported = await fetch(new URL(dependency, url));
        assert.equal(imported.status, 200, `${path} imports ${dependency}`);
      }
    }
    if (path.endsWith('.css')) {
      assert.match(response.headers.get('content-type'), /text\/css/);
      for (const [, dependency] of (await response.text()).matchAll(/url\(['"]?(\.\.?\/[^'")]+)['"]?\)/g)) {
        assert.equal((await fetch(new URL(dependency, url))).status, 200, `${path} uses ${dependency}`);
      }
    }
  }

  const paper = await fetch(base + '/src/paper.jpg');
  assert.equal(paper.status, 200);
  assert.match(paper.headers.get('content-type'), /image\/jpeg/);

  const entry = await fetch(base + '/marketsim.js');
  assert.equal(entry.status, 200);
  assert.match(await entry.text(), /\.\/src\/main\.js/);

  const redirect = await fetch(base + '/embed?seed=7&autoplay=false', { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/marketsim/embed/?seed=7&autoplay=false');

  for (const path of ['/missing.js', '/.git/config', '/.nojekyll', '/package.json', '/test/sim.test.js']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  console.log('HTTP checks passed.');
} finally {
  server?.close();
  const local = relative(artifacts, staging);
  if (dirname(staging) !== artifacts || !local || local.startsWith('..' + sep)) {
    throw new Error('Invalid HTTP staging directory');
  }
  await rm(staging, { recursive: true, force: true });
}
