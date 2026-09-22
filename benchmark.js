import { performance } from "node:perf_hooks";
import { state, action, uid, ui } from "./fried.js";
import { setProp, setChildText, addChild, addStatementAfter, validate } from "./patcher.js";

// Mock minimal DOM for Node.js environment to stress test ui()
globalThis.document = {
  createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      dataset: {},
      attributes: {},
      childNodes: [],
      children: [],
      className: "",
      checked: false,
      style: {},
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
      addEventListener() {},
      appendChild(child) {
        this.childNodes.push(child);
        if (typeof child === "object" && child !== null) {
          this.children.push(child);
        }
      },
    };
    return el;
  },
  createTextNode(text) {
    return { text: String(text) };
  },
};

console.log("=================================================");
console.log("🔥 FRIED.JS FRAMEWORK STRESS TEST & BENCHMARK 🔥");
console.log("=================================================\n");

// --- TEST 1: Element Generation Throughput ---
console.log("▶ TEST 1: ui() Element Creation Throughput");
const nodeCounts = [1000, 5000, 20000, 50000];

for (const count of nodeCounts) {
  const start = performance.now();
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(
      ui("div", { key: `item-${i}`, class: "stress-item", "data-index": i }, [
        ui("span", { key: `title-${i}` }, [`Item #${i}`]),
        ui("p", { key: `desc-${i}` }, [`Random hash: ${uid()}`]),
        ui("button", { key: `btn-${i}`, onclick: () => {} }, ["Click me"]),
      ])
    );
  }
  const duration = performance.now() - start;
  const totalElements = count * 4; // parent + 3 children
  console.log(
    `  • ${count.toLocaleString()} compound cards (${totalElements.toLocaleString()} DOM elements): ` +
    `${duration.toFixed(2)} ms (${Math.round((totalElements / duration) * 1000).toLocaleString()} elements/sec)`
  );
}

// --- TEST 2: High-Frequency Reactive State Churn ---
console.log("\n▶ TEST 2: Reactive State Churn & Action Overhead");
const testState = state(0);
const inc = action("stressInc", () => {
  testState.value += 1;
});

const iterations = 100000;
const churnStart = performance.now();
for (let i = 0; i < iterations; i++) {
  inc();
}
const churnDuration = performance.now() - churnStart;
console.log(
  `  • ${iterations.toLocaleString()} state updates + action dispatches: ` +
  `${churnDuration.toFixed(2)} ms (${Math.round((iterations / churnDuration) * 1000).toLocaleString()} ops/sec)`
);

// --- TEST 3: AST Patcher Throughput (Acorn + MagicString) ---
console.log("\n▶ TEST 3: patcher.js AST Parsing & Rewriting Benchmark");
let sampleCode = `const app = ui("div", { key: "root" }, [
  ui("h1", { key: "title" }, ["Initial Title"]),
  ui("button", { key: "action-btn" }, ["Submit"])
]);`;

const patchIterations = 200;
const patchStart = performance.now();

for (let i = 0; i < patchIterations; i++) {
  // 1. setChildText
  sampleCode = setChildText(sampleCode, "title", i === 0 ? "Initial Title" : `Title ${i - 1}`, `Title ${i}`);
  // 2. setProp
  sampleCode = setProp(sampleCode, "action-btn", "count", `"${i}"`);
  // 3. addChild
  sampleCode = addChild(sampleCode, "root", `ui("span", { key: "badge-${i}" }, ["${i}"])`);
}

const patchDuration = performance.now() - patchStart;
const totalOperations = patchIterations * 3;
const validation = validate(sampleCode);

console.log(
  `  • ${totalOperations.toLocaleString()} AST patch cycles (Parse + Walk + Rewrite): ` +
  `${patchDuration.toFixed(2)} ms (${(patchDuration / totalOperations).toFixed(2)} ms/op, ` +
  `${Math.round((totalOperations / patchDuration) * 1000).toLocaleString()} ops/sec)`
);
console.log(`  • Patched source length: ${sampleCode.length.toLocaleString()} characters`);
console.log(`  • Final AST Syntax Validity: ${validation.ok ? "✅ VALID" : "❌ INVALID: " + validation.error}`);

// --- MEMORY USAGE ---
const mem = process.memoryUsage();
console.log("\n▶ Process Memory Snapshot:");
console.log(`  • Heap Used:  ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`  • Heap Total: ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`);
console.log(`  • RSS:        ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);
console.log("\n=================================================");
