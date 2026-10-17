import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Keep the reference grammar and digest identical to reader_assets.py.
export async function refresh(html, root) {
  const reference = /((?:src|href)=")([a-z-]+\.(?:js|css))(?:\?v=[^"]*)?(")/g;
  const digests = new Map();
  for (const [, , name] of html.matchAll(reference)) {
    if (!digests.has(name)) {
      const bytes = await readFile(join(root, name));
      digests.set(name, createHash('sha256').update(bytes).digest('hex').slice(0, 10));
    }
  }
  return html.replace(reference, (_, prefix, name, end) => `${prefix}${name}?v=${digests.get(name)}${end}`);
}

export async function updateReaderAssets(root, {check = false} = {}) {
  const path = join(root, 'index.html');
  const html = await readFile(path, 'utf8');
  const expected = await refresh(html, root);
  if (check && expected !== html) {
    throw Error('Reader asset tokens are stale in index.html. Run npm run build:reader-ui');
  }
  if (!check && expected !== html) await writeFile(path, expected);
}
