# Shopify AI Patcher Instructions

You are working in a Shopify theme that has been enhanced with the **Shopify AI Patching System**.
Do NOT attempt to rewrite entire `.liquid` files to make edits. Full rewrites break JSON schemas and Liquid formatting.

Instead, use the included `shopify-patcher.js` to make surgical edits.

## How it works

1. This theme has been "unfolded". Every major HTML element has a static `data-ai-key` attribute injected into it.
2. Run `node shopify-map.js` in the project root to get a tiny map of all files and their patchable keys.
3. Target those keys using the patcher.

## Patcher API (`shopify-patcher.js`)

- `setAttr(source, key, attrName, attrValue)`: Updates or adds an HTML attribute.
- `setChildText(source, key, newText)`: Replaces the inner content of the target node with plain text.
- `addChild(source, key, html)`: Appends an HTML string as a child inside the target node.

### Example

To add a new class to the header:
```javascript
import fs from 'fs';
import { setAttr } from './shopify-patcher.js';

let code = fs.readFileSync('sections/header.liquid', 'utf8');
code = setAttr(code, 'header-1', 'class', 'site-header active');
fs.writeFileSync('sections/header.liquid', code);
```

Always use `shopify-map.js` before making edits so you know exactly which keys exist!

## The Enrichment & Learning Phase

Every Shopify theme is different. Before making broad edits, you must understand the theme's specific conventions (CSS classes, snippet structures, JS state).

1. **Initialize the Database**: Copy `THEME-DB-TEMPLATE.md` to `SHOPIFY-MASTER-KNOWLEDGE.md` if it doesn't exist.
2. **Explore & Document**: Search the `assets/` directory (e.g., `base.css` or `theme.css`) and `snippets/` directory to learn how the theme does layouts, typography, and grids. Document these utility classes in `SHOPIFY-MASTER-KNOWLEDGE.md`.
3. **Continuous Learning**: As you patch files and run tests, if you encounter a "gotcha" (e.g., a specific tag breaks the theme's flexbox, or a section requires a specific wrapper), write it down in `SHOPIFY-MASTER-KNOWLEDGE.md` under "Agent Learnings & Gotchas".

Treat `SHOPIFY-MASTER-KNOWLEDGE.md` as your permanent brain for this theme. Read it at the start of every session to write better, more native code.
