// `npm test` entry point: runs tests/test.js plus every tests/*.test.js
// through `node --test`. Lists the files itself instead of passing a
// directory or glob, because `node --test tests/` fails on Node 22+ and
// quoted globs are not expanded on Node 20 or by Windows shells.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = ["test.js", ...readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort()]
  .map((f) => path.join(dir, f));

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
