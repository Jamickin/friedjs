import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
        data.timestamp = new Date().toISOString();
        const auditDir = path.join(__dirname, "audit-logs");
        if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
        
        const jsonlPath = path.join(auditDir, "history.jsonl");
        fs.appendFileSync(jsonlPath, JSON.stringify(data) + "\n");
        
        fs.writeFileSync(path.join(auditDir, "latest.json"), JSON.stringify(data, null, 2));

        try {
          let mdContent = "| Time | Label | FPS | JS Heap (MB) | Render (ms) |\n|---|---|---|---|---|\n";
          const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
          const recent = lines.slice(-20).reverse();
          for (const line of recent) {
            if (!line) continue;
            const entry = JSON.parse(line);
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const label = entry.label || "auto";
            const fps = entry.fps || "-";
            const heap = entry.memory?.usedJsHeapMb || "-";
            const render = entry.renderLatencyMs || "-";
            mdContent += `| ${time} | ${label} | ${fps} | ${heap} | ${render} |\n`;
          }
          fs.writeFileSync(path.join(auditDir, "README.md"), "# Performance Audit History\n\n" + mdContent);
        } catch(e) { console.error("md gen error", e); }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, filename: `audit-logs/${filename}` }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  const filePath = path.join(__dirname, reqPath);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "text/plain";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Fried.js tester server running at http://localhost:${PORT}/\n`);
});
