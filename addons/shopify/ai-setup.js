import fs from 'fs';
import path from 'path';
import { injectKeys } from './shopify-injector.js';
import { buildMap, formatMap } from './shopify-map.js';

const targetDir = process.argv[2] || process.cwd();

console.log("🤖 Initializing AI Shopify Environment...");

// 1. Inject Keys
console.log("\n[1/3] Injecting Patch Keys...");
injectKeys(targetDir);

// 2. Build Map
console.log("\n[2/3] Building AI Theme Map...");
const mapString = formatMap(buildMap(targetDir));
fs.writeFileSync(path.join(targetDir, 'THEME-MAP.md'), mapString);
console.log("✅ Wrote THEME-MAP.md");

// 3. Initialize Database
console.log("\n[3/3] Initializing Theme Database...");
const dbPath = path.join(targetDir, 'SHOPIFY-MASTER-KNOWLEDGE.md');
if (!fs.existsSync(dbPath)) {
  const templatePath = path.join(new URL(import.meta.url).pathname, '../THEME-DB-TEMPLATE.md');
  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, dbPath);
    console.log("✅ Created SHOPIFY-MASTER-KNOWLEDGE.md from template. (Agent: Please review and fill this out!)");
  } else {
    console.log("⚠️ Could not find THEME-DB-TEMPLATE.md");
  }
} else {
  console.log("ℹ️ SHOPIFY-MASTER-KNOWLEDGE.md already exists.");
}

console.log("\n🎉 Setup Complete! You can now read THEME-MAP.md and edit using shopify-patcher.js.");
