import fs from 'fs';
import { globSync } from 'glob';
import path from 'path';

export function buildMap(dir) {
  const files = globSync('**/*.liquid', { cwd: dir, absolute: true, ignore: ['node_modules/**'] });
  const map = {};

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relative = path.relative(dir, file);
    
    // Find all injected keys
    const regex = /data-ai-key="([^"]+)"/g;
    let match;
    const keys = [];
    while ((match = regex.exec(content)) !== null) {
      keys.push(match[1]);
    }

    if (keys.length > 0) {
      map[relative] = keys;
    }
  }

  return map;
}

export function formatMap(map) {
  let out = "Shopify Theme AI Map:\n";
  for (const [file, keys] of Object.entries(map)) {
    out += `\n[${file}]\n`;
    out += `Keys: ${keys.join(' ')}\n`;
  }
  return out;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const targetDir = process.argv[2] || process.cwd();
  console.log(formatMap(buildMap(targetDir)));
}
