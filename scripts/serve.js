import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve(process.argv[2] || '.');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png'
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));

    if (!target.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }

    if (pathname.split('/').some(part => part.startsWith('.'))) {
      response.writeHead(404).end();
      return;
    }

    if (!pathname.endsWith('/') && (await stat(target)).isDirectory()) {
      const url = new URL(request.url, 'http://localhost');
      response.writeHead(308, { Location: `${url.pathname}/${url.search}` }).end();
      return;
    }

    const contents = await readFile(target);
    const mime = MIME_TYPES[extname(target)] || 'application/octet-stream';
    const contentType = mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml'
      ? `${mime}; charset=utf-8`
      : mime;
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    });
    response.end(contents);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(Number(process.env.PORT || 4180), '127.0.0.1', () => {
  console.log(`Marketsim · http://127.0.0.1:${server.address().port}`);
});
