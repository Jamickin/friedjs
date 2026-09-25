import fs from 'fs';
import { globSync } from 'glob';
import path from 'path';

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const IGNORE_TAGS = new Set(['html', 'head', 'body', 'script', 'style', 'title']);

export function injectKeys(dir) {
  const files = globSync('**/*.liquid', { cwd: dir, absolute: true, ignore: ['node_modules/**'] });
  let totalInjected = 0;

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    const baseName = path.basename(file, '.liquid').replace(/[^a-zA-Z0-9-]/g, '-');
    let counter = 1;
    let modified = false;

    // A rough regex to match opening HTML tags.
    // It captures: 1: tag name, 2: existing attributes
    // It ignores tags that already have data-ai-key
    const tagRegex = /<([a-zA-Z0-9\-]+)([^>]*?)(\/?)>/g;

    const newContent = content.replace(tagRegex, (match, tag, attrs, selfClosing) => {
      const lowerTag = tag.toLowerCase();
      if (VOID_TAGS.has(lowerTag) || IGNORE_TAGS.has(lowerTag)) return match;
      if (attrs.includes('data-ai-key')) return match; // Already injected
      
      // Don't inject if it's somehow inside a liquid tag (very basic check)
      // We rely on standard formatting where tags are outside liquid logic.
      
      const key = `${baseName}-${counter++}`;
      modified = true;
      totalInjected++;
      
      return `<${tag} data-ai-key="${key}"${attrs}${selfClosing}>`;
    });

    if (modified) {
      fs.writeFileSync(file, newContent, 'utf8');
      console.log(`Injected ${counter - 1} keys into ${path.relative(dir, file)}`);
    }
  }
  
  console.log(`\n✅ Injection complete. Injected ${totalInjected} keys across ${files.length} files.`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const targetDir = process.argv[2] || process.cwd();
  injectKeys(targetDir);
}
