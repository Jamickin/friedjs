export class PatchError extends Error {}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Finds the start and end indices of the opening tag containing data-ai-key="key"
function findOpeningTag(source, key) {
  const marker = `data-ai-key="${key}"`;
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) throw new PatchError(`Key "${key}" not found.`);

  const startIdx = source.lastIndexOf('<', markerIdx);
  if (startIdx === -1) throw new PatchError(`Malformed tag for key "${key}".`);

  let endIdx = source.indexOf('>', markerIdx);
  if (endIdx === -1) throw new PatchError(`Malformed tag for key "${key}".`);

  // Extract tag name
  const match = source.slice(startIdx, endIdx + 1).match(/^<([a-zA-Z0-9\-]+)/);
  if (!match) throw new PatchError(`Could not determine tag name for key "${key}".`);
  const tagName = match[1].toLowerCase();

  return { start: startIdx, end: endIdx + 1, tagName, isVoid: VOID_TAGS.has(tagName) || source[endIdx - 1] === '/' };
}

// Finds the closing tag for a given opening tag
function findClosingTag(source, openingTagInfo) {
  if (openingTagInfo.isVoid) return { start: openingTagInfo.end, end: openingTagInfo.end };

  const tag = openingTagInfo.tagName;
  let depth = 1;
  let cursor = openingTagInfo.end;
  
  const tagRegex = new RegExp(`<(\\/)?${tag}\\b[^>]*>`, 'gi');
  tagRegex.lastIndex = cursor;

  let match;
  while ((match = tagRegex.exec(source)) !== null) {
    if (match[1] === '/') {
      depth--;
    } else {
      // Check if it's a self-closing tag
      if (!match[0].endsWith('/>')) {
        depth++;
      }
    }

    if (depth === 0) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }

  throw new PatchError(`Could not find closing tag for <${tag}>.`);
}

export function setAttr(source, key, attrName, attrValue) {
  const op = findOpeningTag(source, key);
  const tagContent = source.slice(op.start, op.end);
  
  // If attribute exists, replace it
  const attrRegex = new RegExp(`\\b${attrName}="([^"]*)"`);
  if (attrRegex.test(tagContent)) {
    const newTag = tagContent.replace(attrRegex, `${attrName}="${attrValue}"`);
    return source.slice(0, op.start) + newTag + source.slice(op.end);
  } else {
    // Inject before closing bracket
    const insertPos = tagContent.endsWith('/>') ? tagContent.length - 2 : tagContent.length - 1;
    const newTag = tagContent.slice(0, insertPos) + ` ${attrName}="${attrValue}"` + tagContent.slice(insertPos);
    return source.slice(0, op.start) + newTag + source.slice(op.end);
  }
}

export function setChildText(source, key, newText) {
  const op = findOpeningTag(source, key);
  const cl = findClosingTag(source, op);
  return source.slice(0, op.end) + newText + source.slice(cl.start);
}

export function addChild(source, key, html) {
  const op = findOpeningTag(source, key);
  const cl = findClosingTag(source, op);
  return source.slice(0, cl.start) + "\n  " + html + "\n" + source.slice(cl.start);
}
