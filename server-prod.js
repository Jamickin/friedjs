import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PROD_PORT || 8080;
const DIST_DIR = path.join(__dirname, "dist");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split("?")[0];
  if (reqPath === "/") reqPath = "/index.html";

  if (req.method === "POST" && reqPath === "/api/telemetry") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const auditDir = path.join(__dirname, "audit-logs");
        if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
        const filename = `audit-${Date.now()}.json`;
        fs.writeFileSync(path.join(auditDir, filename), JSON.stringify(data, null, 2));
        fs.writeFileSync(path.join(auditDir, "latest.json"), JSON.stringify(data, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, filename: `audit-logs/${filename}` }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  const filePath = path.join(DIST_DIR, reqPath);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "text/plain";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
      res.end(err.code === "ENOENT" ? "404 Not Found" : "500 Internal Error");
      return;
    }

    const acceptEncoding = req.headers["accept-encoding"] || "";
    if (acceptEncoding.includes("gzip")) {
      zlib.gzip(content, (gzipErr, gzipped) => {
        if (!gzipErr) {
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Encoding": "gzip",
            "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
          });
          res.end(gzipped);
          return;
        }
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      });
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 PRODUCTION PREVIEW SERVER: http://localhost:${PORT}/\n   Serving optimized, gzipped dist/ assets.\n`);
});
