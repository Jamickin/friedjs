import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execSync } from "node:child_process";

const DIST_DIR = "./dist";

console.log("=========================================");
console.log("📦 BUILDING FOR PRODUCTION WITH ESBUILD");
console.log("=========================================\n");

console.log("🔍 Running strict TypeScript validation...");
try {
  execSync("npx tsc -p jsconfig.json", { stdio: "inherit" });
  console.log("✅ Static analysis passed.\n");
} catch (error) {
  console.error("❌ Build aborted due to type or syntax errors.");
  process.exit(1);
}

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// 1. Bundle and minify JS
const jsStart = performance.now();
const jsResult = await esbuild.build({
  entryPoints: ["./app.js"],
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["es2022"],
  format: "esm",
  outfile: path.join(DIST_DIR, "app.min.js"),
  metafile: true,
});
const jsTime = (performance.now() - jsStart).toFixed(2);

// 2. Minify CSS
const cssStart = performance.now();
const cssResult = await esbuild.build({
  entryPoints: ["./style.css"],
  minify: true,
  outfile: path.join(DIST_DIR, "style.min.css"),
});
const cssTime = (performance.now() - cssStart).toFixed(2);

// 3. Generate production HTML
const prodHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fried.js Production Benchmark</title>
    <link rel="stylesheet" href="./style.min.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./app.min.js"></script>
  </body>
</html>
`;
fs.writeFileSync(path.join(DIST_DIR, "index.html"), prodHtml);

// 4. Measure file sizes & gzip
const jsRaw = fs.readFileSync(path.join(DIST_DIR, "app.min.js"));
const jsGzip = zlib.gzipSync(jsRaw);

const cssRaw = fs.readFileSync(path.join(DIST_DIR, "style.min.css"));
const cssGzip = zlib.gzipSync(cssRaw);

console.log(`✅ JS Bundle (app + fried.js runtime):`);
console.log(`   • Build time:  ${jsTime} ms`);
console.log(`   • Raw size:    ${(jsRaw.length / 1024).toFixed(2)} KB`);
console.log(`   • Gzip size:   ${(jsGzip.length / 1024).toFixed(2)} KB\n`);

console.log(`✅ CSS Bundle:`);
console.log(`   • Build time:  ${cssTime} ms`);
console.log(`   • Raw size:    ${(cssRaw.length / 1024).toFixed(2)} KB`);
console.log(`   • Gzip size:   ${(cssGzip.length / 1024).toFixed(2)} KB\n`);

console.log(`✨ Total Production Payload: ${((jsGzip.length + cssGzip.length + prodHtml.length) / 1024).toFixed(2)} KB`);
console.log("=========================================");
