import { mount, state, action, ui, uid, onRender, css, cssVar } from "./fried.js";
import { createDatabase } from "./fried-db.js";

// -- Initialize Local Database --
const db = createDatabase("FriedAppDB", ["users"]);
if (typeof window !== "undefined") {
  db.init().then(() => console.log("💾 POES fast local DB initialized"));
}

// -- App-level styles defined in JS, injected once as a <style> tag via css()
// These live alongside component logic — no separate CSS file needed for component styles.
const S = css({
  badge:        "display:inline-block;padding:2px 7px;border-radius:4px;font-size:0.72rem;font-weight:700;letter-spacing:.04em",
  badgeGreen:   "background:#22c55e20;color:#22c55e",
  badgeYellow:  "background:#f59e0b20;color:#d97706",
  badgeRed:     "background:#ef444420;color:#ef4444",
  nodeHeader:   "display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem",
  nodeTitle:    "font-size:.78rem;font-weight:600;font-family:var(--font-mono);color:var(--text-muted)",
  nodeBody:     "font-size:.72rem;color:var(--text-muted);display:flex;flex-direction:column;gap:.2rem",
  meterTrack:   "height:5px;border-radius:3px;background:var(--border);margin-top:.4rem;overflow:hidden",
  meterBar:     "height:100%;background:var(--accent);border-radius:3px;transition:width .15s",
  meterBarHigh: "height:100%;background:#ef4444;border-radius:3px;transition:width .15s",
  vContainer:   "height:65vh;overflow-y:auto;position:relative;border:1px solid var(--border);border-radius:8px;background:#0f172a50;padding:16px;box-sizing:border-box",
  vSpanner:     "position:absolute;top:0;left:0;width:1px;",
  vCard:        "position:absolute;width:280px;box-sizing:border-box", // Virtualized card wrapper
});

const count = state(0);
const todos = state([
  { id: uid(), text: "Explore fried.js minimal runtime", done: true },
  { id: uid(), text: "Check out the AST source patcher", done: false },
]);
const filter = state("all");
const inspectKeysActive = state(false);
const activeTab = state("showcase"); // "showcase" | "benchmark" | "tests"
const testSuiteResults = state(null);

// --- Stress Test State & Telemetry ---
const stressNodes = state([]);
const tickerActive = state(false);
const viewport = state({ scrollTop: 0, width: typeof window !== "undefined" ? window.innerWidth : 1200 }); 
const auditToast = state(null);

const auditLabel = state("baseline"); // { type: 'success' | 'error', text: '' }

// Advanced Profiling State
const cpuLoadPct = state(0);

const browserOverheadMs = state(0);


onRender(() => {
  const start = performance.now();
  setTimeout(() => {
    const overhead = performance.now() - start;
    // Cap to 0 if it's too small, sometimes timers are fuzzy
    browserOverheadMs.value = Math.max(0, overhead - 1).toFixed(1);
  }, 0);
});

const memoryChurnMb = state(0);
const trueDomCount = state(0);

// CPU/Memory tracking variables
let secondStartTime = typeof performance !== "undefined" ? performance.now() : 0;
let timeSpentInFramework = 0;
let previousMemoryTotal = 0;
let accumulatedChurn = 0;

// Track window resizes to reflow the virtual grid
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    viewport.value = { ...viewport.value, width: window.innerWidth };
  });
}

let lastRenderDurationMs = 0;
let totalRenderCycles = 0;
let tickerTimerId = null;
let lastFrameTimestamp = performance.now();
let currentFps = 60;
let frameCounter = 0;

// Render sample buffer for telemetry percentiles
const renderSamples = [];
const MAX_SAMPLES = 120;
let longTaskCount = 0;
let maxLongTaskDurationMs = 0;

// Listen for browser main thread long tasks (>50ms stalls)
if (typeof PerformanceObserver !== "undefined") {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount++;
        if (entry.duration > maxLongTaskDurationMs) {
          maxLongTaskDurationMs = entry.duration;
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch (_) {}
}

// Hook into fried.js runtime to profile each render cycle
onRender(({ tTree, tHydrate, tTotal }) => {
  renderSamples.push({ tTree, tHydrate, tTotal });
  if (renderSamples.length > MAX_SAMPLES) {
    renderSamples.shift();
  }
  lastRenderDurationMs = tTotal;
  totalRenderCycles++;

  // Advanced Metrics Tracking
  timeSpentInFramework += tTotal;
  // 3. Memory Churn tracking
  if (typeof performance !== "undefined" && performance.memory) {
    const currentMemory = performance.memory.usedJSHeapSize;
    if (previousMemoryTotal > 0) {
      if (currentMemory > previousMemoryTotal) {
        accumulatedChurn += (currentMemory - previousMemoryTotal);
      }
    }
    previousMemoryTotal = currentMemory;
  }

  const now = performance.now();
  if (now - secondStartTime >= 1000) {
    // 1. Calculate CPU Load (%)
    cpuLoadPct.value = ((timeSpentInFramework / (now - secondStartTime)) * 100).toFixed(2);
    timeSpentInFramework = 0;
    
    // 2. Memory Churn (MB/s)
    memoryChurnMb.value = (accumulatedChurn / 1024 / 1024).toFixed(2);
    accumulatedChurn = 0;

    secondStartTime = now;
    
    // 3. True DOM node count
    if (typeof document !== "undefined") {
      trueDomCount.value = document.body.querySelectorAll('*').length;
    }
  }
});

function computeTelemetryStats() {
  if (renderSamples.length === 0) {
    return {
      sampleCount: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      avgTree: 0,
      avgHydrate: 0,
    };
  }
  const totals = renderSamples.map((s) => s.tTotal).sort((a, b) => a - b);
  const trees = renderSamples.map((s) => s.tTree);
  const hydrates = renderSamples.map((s) => s.tHydrate);

  const min = totals[0];
  const max = totals[totals.length - 1];
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  const p50 = totals[Math.floor(totals.length * 0.5)] || 0;
  const p95 = totals[Math.floor(totals.length * 0.95)] || 0;
  const p99 = totals[Math.floor(totals.length * 0.99)] || 0;
  const avgTree = trees.reduce((a, b) => a + b, 0) / trees.length;
  const avgHydrate = hydrates.reduce((a, b) => a + b, 0) / hydrates.length;

  return {
    sampleCount: renderSamples.length,
    min,
    max,
    avg,
    p50,
    p95,
    p99,
    avgTree,
    avgHydrate,
  };
}

function buildAuditPayload() {
  const label = typeof auditLabel !== "undefined" ? auditLabel.value : "baseline";
  const stats = computeTelemetryStats();
  const mem = (typeof performance !== "undefined" && performance.memory)
    ? {
        usedJsHeapMb: Number((performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(2)),
        totalJsHeapMb: Number((performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(2)),
        jsHeapLimitMb: Number((performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(2)),
      }
    : null;

  return {
    timestamp: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      cores: navigator.hardwareConcurrency || "unknown",
      deviceMemoryGb: navigator.deviceMemory || "unknown",
      url: window.location.href,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
    },
    framework: {
      name: "fried.js",
      mode: "in-place-dom-hydration",
      totalRenderCycles,
    },
    domMetrics: {
      activeDataCards: stressNodes.value.length,
      trueDomElements: trueDomCount.value,
      tickerActive: tickerActive.value,
      currentFps,
    },
    renderLatencyMs: {
      samplesAnalyzed: stats.sampleCount,
      medianP50: Number(stats.p50.toFixed(2)),
      percentileP95: Number(stats.p95.toFixed(2)),
      percentileP99: Number(stats.p99.toFixed(2)),
      min: Number(stats.min.toFixed(2)),
      max: Number(stats.max.toFixed(2)),
      average: Number(stats.avg.toFixed(2)),
      treeConstructionAvgMs: Number(stats.avgTree.toFixed(2)),
      domHydrationAvgMs: Number(stats.avgHydrate.toFixed(2)),
    },
    profiling: {
      mainThreadCpuLoadPct: Number(cpuLoadPct.value),
      memoryChurnMb: Number(memoryChurnMb.value),
      longTaskStallsCount: longTaskCount,
      maxLongTaskDurationMs: Number(maxLongTaskDurationMs.toFixed(2)),
      memory: mem,
    },
  };
}

// --- Named Actions ---
const increment = action("increment", () => {
  count.value += 1;
});

const decrement = action("decrement", () => {
  count.value -= 1;
});

const resetCount = action("resetCount", () => {
  count.value = 0;
});

const setTab = action("setTab", (tabName) => {
  if (activeTab.value !== tabName) {
    if (tickerActive.value && typeof toggleChaosTicker === "function") toggleChaosTicker();
    if (typeof svgTickerActive !== "undefined" && svgTickerActive.value && typeof toggleSvgTicker === "function") toggleSvgTicker();
    activeTab.value = tabName;
  }
});

const toggleInspectKeys = action("toggleInspectKeys", () => {
  inspectKeysActive.value = !inspectKeysActive.value;
  if (inspectKeysActive.value) {
    document.body.classList.add("inspect-keys");
  } else {
    document.body.classList.remove("inspect-keys");
  }
});

const toggleTodo = action("toggleTodo", (id) => {
  todos.value = todos.value.map((item) =>
    item.id === id ? { ...item, done: !item.done } : item
  );
});

const removeTodo = action("removeTodo", (id) => {
  todos.value = todos.value.filter((item) => item.id !== id);
});

const clearCompletedTodos = action("clearCompletedTodos", () => {
  todos.value = todos.value.filter((item) => !item.done);
});

const setTodoFilter = action("setTodoFilter", (f) => {
  filter.value = f;
});

const addTodoFromForm = action("addTodoFromForm", (text) => {
  if (!text) return;
  todos.value = [
    ...todos.value,
    { id: uid(), text, done: false }
  ];
});

// --- Stress Test Actions ---
function createRichNode(idx) {
  const statuses = ["HEALTHY", "WARNING", "CRITICAL"];
  const status = statuses[idx % 3];
  const load = Math.floor(Math.random() * 95) + 5;
  const latency = (Math.random() * 40 + 2).toFixed(1);
  const memory = (Math.random() * 128 + 16).toFixed(1);
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}.${Math.floor(now.getMilliseconds() / 100)}`;

  return {
    id: uid(),
    index: idx + 1,
    title: `Worker Node #${idx + 1}`,
    status,
    load,
    latency: `${latency}ms`,
    memory: `${memory}MB`,
    hash: `0x${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
    timeStr,
  };
}

const generateStressNodes = action("generateStressNodes", (targetCount) => {
  // Synchronous, immediate array allocation.
  // With virtualization, rendering 5000 nodes takes 0 ms because we only mount ~20!
  const list = new Array(targetCount);
  for (let i = 0; i < targetCount; i++) {
    list[i] = createRichNode(i);
  }
  stressNodes.value = list;
});

const mutateRandomNodes = action("mutateRandomNodes", () => {
  const current = stressNodes.value;
  const n = current.length;
  if (n === 0) return;

  const statuses = ["HEALTHY", "WARNING", "CRITICAL"];
  // Targeted O(k) mutation: pick exactly k indices via partial Fisher-Yates shuffle.
  // Avoids scanning all n items with Math.random() — instead only touches the
  // ~25% that will actually change. Zero work done on the 75% that stay the same.
  const k = Math.max(1, Math.round(n * 0.25));
  const indices = new Int32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;

  // Partial shuffle: swap k random positions to the front
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
  }

  // Clone array (keep all references), then overwrite only the k selected slots
  const next = current.slice(); // O(n) but no object allocation — just pointer copy
  for (let i = 0; i < k; i++) {
    const idx = indices[i];
    const item = current[idx];
    next[idx] = {
      ...item,
      status: statuses[Math.floor(Math.random() * 3)],
      load: Math.floor(Math.random() * 95) + 5,
      latency: `${(Math.random() * 40 + 2).toFixed(1)}ms`,
      hash: `0x${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
    };
  }
  stressNodes.value = next;
});

const mutateSingleNode = action("mutateSingleNode", (id) => {
  const statuses = ["HEALTHY", "WARNING", "CRITICAL"];
  stressNodes.value = stressNodes.value.map((item) => {
    if (item.id === id) {
      return {
        ...item,
        status: statuses[(statuses.indexOf(item.status) + 1) % 3],
        load: Math.floor(Math.random() * 95) + 5,
        hash: `0x${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
      };
    }
    return item;
  });
});

const clearStressNodes = action("clearStressNodes", () => {
  if (tickerActive.value) {
    toggleChaosTicker();
  }
  stressNodes.value = [];
});

const toggleChaosTicker = action("toggleChaosTicker", () => {
  if (tickerActive.value) {
    // Cancel the rAF loop
    if (tickerTimerId) cancelAnimationFrame(tickerTimerId);
    tickerTimerId = null;
    tickerActive.value = false;
  } else {
    tickerActive.value = true;
    lastFrameTimestamp = performance.now();
    frameCounter = 0;
    let lastTickTime = performance.now();

    // rAF-based loop: self-throttles to display refresh rate,
    // skips frames when the previous render is still running (back-pressure),
    // and stops automatically when the tab is backgrounded.
    function rafTick(now) {
      if (!tickerActive.value) return;

      // FPS counter
      frameCounter++;
      const elapsed = now - lastFrameTimestamp;
      if (elapsed >= 500) {
        currentFps = Math.round((frameCounter * 1000) / elapsed);
        frameCounter = 0;
        lastFrameTimestamp = now;
      }

      // Back-pressure: only fire if at least 33ms have passed since last tick
      // This prevents stacking work when renders are slow
      if (now - lastTickTime >= 33) {
        lastTickTime = now;
        mutateRandomNodes();
      }

      tickerTimerId = requestAnimationFrame(rafTick);
    }

    tickerTimerId = requestAnimationFrame(rafTick);
  }
});


const toggleMassCss = action("toggleMassCss", () => {
  if (typeof document !== "undefined") {
    document.body.classList.toggle("mass-css-stress");
  }
});



const toggleMountThrashing = action("toggleMountThrashing", () => {
  if (tickerActive.value) {
    if (tickerTimerId) cancelAnimationFrame(tickerTimerId);
    tickerTimerId = null;
    tickerActive.value = false;
  } else {
    tickerActive.value = true;
    lastFrameTimestamp = performance.now();
    frameCounter = 0;
    function rafTick(now) {
      if (!tickerActive.value) return;
      frameCounter++;
      if (now - lastFrameTimestamp >= 500) {
        currentFps = Math.round((frameCounter * 1000) / (now - lastFrameTimestamp));
        frameCounter = 0; lastFrameTimestamp = now;
      }
      const n = stressNodes.value.length;
      if (n > 0) {
        const arr = new Array(n);
        for (let i = 0; i < n; i++) arr[i] = createRichNode(i);
        stressNodes.value = arr;
      }
      tickerTimerId = requestAnimationFrame(rafTick);
    }
    tickerTimerId = requestAnimationFrame(rafTick);
  }
});


// --- Audit & Diagnostics Actions ---
const sendAuditToServer = action("sendAuditToServer", async () => {
  const payload = buildAuditPayload();
  try {
    const res = await fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload, null, 2),
    });
    const result = await res.json();
    if (result.ok) {
      auditToast.value = {
        type: "success",
        text: `✅ Saved report to ${result.filename}! Tell your agent: "Please audit ${result.filename}".`,
      };
    } else {
      auditToast.value = { type: "error", text: `Failed to save: ${result.error}` };
    }
  } catch (err) {
    auditToast.value = { type: "error", text: `Server error: ${err.message}` };
  }
});

const copyAuditMarkdown = action("copyAuditMarkdown", () => {
  const p = buildAuditPayload();
  const r = p.renderLatencyMs;
  const env = p.environment;
  const dom = p.domMetrics;
  const prof = p.profiling;

  const markdown = [
    `### 📊 Fried.js Performance Audit Report`,
    `- **Timestamp**: \`${p.timestamp}\``,
    `- **Host URL**: \`${env.url}\``,
    `- **Hardware**: ${env.cores} CPU Cores | ~${env.deviceMemoryGb} GB RAM | Screen: ${env.screenResolution}`,
    `- **DOM Workload**: ${dom.activeDataCards.toLocaleString()} virtual cards (🔥 **${dom.trueDomElements.toLocaleString()} true DOM elements**)`,
    `- **Live Frame Rate**: ${dom.currentFps} FPS (Ticker: ${dom.tickerActive ? "Active" : "Off"})`,
    `\n**Latency Distribution (over ${r.samplesAnalyzed} samples)**:`,
    `- **Median (p50)**: \`${r.medianP50} ms\``,
    `- **95th percentile (p95)**: \`${r.percentileP95} ms\``,
    `- **99th percentile (p99)**: \`${r.percentileP99} ms\``,
    `- **Min / Max**: \`${r.min} ms\` / \`${r.max} ms\``,
    `- **Average**: \`${r.average} ms\` (Tree: \`${r.treeConstructionAvgMs} ms\` | Hydration: \`${r.domHydrationAvgMs} ms\`)`,
    `\n**Advanced Hardware Diagnostics**:`,
    `- **Main Thread CPU Load**: \`${prof.mainThreadCpuLoadPct}% CPU\` spent in framework`,
    `- **Garbage Collection / Churn**: \`${prof.memoryChurnMb} MB/sec\` memory allocation rate`,
    `- **Main Thread Stalls (>50ms)**: ${prof.longTaskStallsCount} long tasks (Peak stall: \`${prof.maxLongTaskDurationMs} ms\`)`,
    prof.memory ? `- **JS Heap Used**: \`${prof.memory.usedJsHeapMb} MB\` / \`${prof.memory.totalJsHeapMb} MB\`` : `- **JS Heap**: N/A`,
  ].join("\n");

  navigator.clipboard.writeText(markdown).then(() => {
    auditToast.value = {
      type: "success",
      text: "📋 Copied Markdown audit report to clipboard! You can paste it directly into chat.",
    };
  });
});

const downloadAuditJson = action("downloadAuditJson", () => {
  const payload = buildAuditPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `friedjs-telemetry-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  auditToast.value = { type: "success", text: "💾 Downloaded telemetry JSON file." };
});

const resetAuditSamples = action("resetAuditSamples", () => {
  renderSamples.length = 0;
  longTaskCount = 0;
  maxLongTaskDurationMs = 0;
  auditToast.value = { type: "success", text: "🔄 Telemetry samples buffer reset." };
});

const dismissToast = action("dismissToast", () => {
  auditToast.value = null;
});

// --- In-Browser Diagnostic Test Suite ---
const runBrowserTests = action("runBrowserTests", () => {
  const results = [];

  // Test 1: state box
  try {
    const s = state(42);
    const initialOk = s.value === 42;
    s.value = 99;
    const updateOk = s.value === 99;
    results.push({
      name: "state(initial) creates reactive getter/setter box",
      passed: initialOk && updateOk,
      detail: `Initial: 42 (got ${initialOk}), Updated: 99 (got ${updateOk})`,
    });
  } catch (err) {
    results.push({ name: "state() box test", passed: false, detail: err.message });
  }

  // Test 2: action wrapping
  try {
    let triggered = false;
    const testAct = action("customAction", (arg) => {
      triggered = true;
      return arg * 2;
    });
    const nameOk = testAct.friedActionName === "customAction";
    const ret = testAct(5);
    const execOk = triggered && ret === 10;
    results.push({
      name: "action(name, fn) preserves actionName and runs wrapped logic",
      passed: nameOk && execOk,
      detail: `Name: ${testAct.friedActionName}, Result: ${ret}`,
    });
  } catch (err) {
    results.push({ name: "action() wrapping test", passed: false, detail: err.message });
  }

  // Test 3: ui key attribute
  try {
    const el = ui("div", { key: "test-node", id: "my-node" }, ["Content"]);
    const hasDataset = el.dataset.friedKey === "test-node";
    const hasAttr = el.id === "my-node";
    const hasText = el.textContent === "Content";
    results.push({
      name: "ui() attaches dataset.friedKey for AST addressing and standard attributes",
      passed: hasDataset && hasAttr && hasText,
      detail: `data-fried-key: "${el.dataset.friedKey}", id: "${el.id}", text: "${el.textContent}"`,
    });
  } catch (err) {
    results.push({ name: "ui() key and props test", passed: false, detail: err.message });
  }

  // Test 4: ui event listeners
  try {
    let clicked = false;
    const btn = ui("button", { key: "btn", onclick: () => { clicked = true; } }, ["Click"]);
    btn.click();
    results.push({
      name: "ui() binds event handlers (e.g. onclick -> addEventListener('click'))",
      passed: clicked === true,
      detail: `Button simulated click triggered: ${clicked}`,
    });
  } catch (err) {
    results.push({ name: "ui() event handler test", passed: false, detail: err.message });
  }

  // Test 5: ui class and checked props
  try {
    const checkbox = ui("input", { key: "chk", type: "checkbox", class: "custom-chk", checked: true });
    const classOk = checkbox.className === "custom-chk";
    const checkedOk = checkbox.checked === true;
    results.push({
      name: "ui() correctly sets class and checked boolean properties",
      passed: classOk && checkedOk,
      detail: `className: "${checkbox.className}", checked: ${checkbox.checked}`,
    });
  } catch (err) {
    results.push({ name: "ui() class and checked test", passed: false, detail: err.message });
  }

  // Test 6: ui nested and flattened children
  try {
    const parent = ui("div", { key: "parent" }, [
      ui("span", { key: "child-1" }, ["A"]),
      [ui("span", { key: "child-2" }, ["B"]), ui("span", { key: "child-3" }, ["C"])],
      "D",
    ]);
    const textOk = parent.textContent === "ABCD";
    const childCountOk = parent.children.length === 3;
    results.push({
      name: "ui() handles flat and nested array children and strings",
      passed: textOk && childCountOk,
      detail: `Children count: ${parent.children.length}, textContent: "${parent.textContent}"`,
    });
  } catch (err) {
    results.push({ name: "ui() nested children test", passed: false, detail: err.message });
  }

  // Test 7: uid() generation
  try {
    const ids = new Set(Array.from({ length: 20 }, () => uid()));
    const allUnique = ids.size === 20;
    const formatOk = Array.from(ids).every((id) => typeof id === "string" && id.length >= 6);
    results.push({
      name: "uid() generates unique random string identifiers",
      passed: allUnique && formatOk,
      detail: `20 generated: ${ids.size} unique, sample: "${Array.from(ids)[0]}"`,
    });
  } catch (err) {
    results.push({ name: "uid() test", passed: false, detail: err.message });
  }

  testSuiteResults.value = results;
});

// --- Component Render Functions ---


function renderGlobalTelemetry() {
  const nodeCount = stressNodes.value.length;
  const latencyClass = lastRenderDurationMs > 8 ? "bad" : lastRenderDurationMs > 3 ? "warn" : "good";
  const fpsClass = currentFps < 30 ? "bad" : currentFps < 50 ? "warn" : "good";
  
  return ui("div", { key: "global-telemetry", style: "margin-bottom: 1rem;" }, [
ui("div", { key: "bench-metrics-grid", class: "grid grid-4", style: "margin-bottom: 1.5rem;" }, [
      ui("div", { key: "metric-count", class: "metric-card" }, [
        ui("div", { key: "val-count", class: "metric-val" }, [nodeCount.toLocaleString()]),
        ui("div", { key: "lbl-count", class: "metric-label" }, ["Virtual Data Cards"]),
      ]),
      ui("div", { key: "metric-elements", class: "metric-card" }, [
        ui("div", { key: "val-elements", class: "metric-val" }, [trueDomCount.value.toLocaleString()]),
        ui("div", { key: "lbl-elements", class: "metric-label" }, ["True DOM Elements"]),
      ]),
      ui("div", { key: "metric-latency", class: "metric-card" }, [
        ui("div", { key: "val-latency", class: `metric-val ${latencyClass}` }, [
          `${lastRenderDurationMs.toFixed(1)} ms`
        ]),
        ui("div", { key: "lbl-latency", class: "metric-label" }, ["Re-Render Latency"]),
      ]),
      ui("div", { key: "metric-fps", class: "metric-card" }, [
        ui("div", { key: "val-fps", class: `metric-val ${fpsClass}` }, [
          tickerActive.value ? `${currentFps} FPS` : "--"
        ]),
        ui("div", { key: "lbl-fps", class: "metric-label" }, ["Live Ticker Rate"]),
      ]),
    ]),
    
    // Advanced Hardware Telemetry Grid
    ui("div", { key: "hw-metrics-grid", class: "grid grid-4", style: "margin-bottom: 1.5rem;", "class": "grid grid-5" }, [
      ui("div", { key: "hw-cpu", class: "metric-card" }, [
        ui("div", { key: "hw-val-cpu", class: "metric-val", style: "color: #3b82f6" }, [`${cpuLoadPct.value}%`]),
        ui("div", { key: "hw-lbl-cpu", class: "metric-label" }, ["Main Thread CPU Load"]),
      ]),
      ui("div", { key: "hw-mem", class: "metric-card" }, [
        ui("div", { key: "hw-val-mem", class: "metric-val", style: "color: #a855f7" }, [`${memoryChurnMb.value} MB/s`]),
        ui("div", { key: "hw-lbl-mem", class: "metric-label" }, ["Memory Churn / GC Rate"]),
      ]),
      ui("div", { key: "hw-stalls", class: "metric-card" }, [
        ui("div", { key: "hw-val-stalls", class: longTaskCount > 0 ? "metric-val bad" : "metric-val good" }, [longTaskCount.toLocaleString()]),
        ui("div", { key: "hw-lbl-stalls", class: "metric-label" }, ["Long Task Stalls (>50ms)"]),
      ]),
      ui("div", { key: "hw-heap", class: "metric-card" }, [
        ui("div", { key: "hw-val-heap", class: "metric-val" }, [
          typeof performance !== "undefined" && performance.memory ? `${(performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(0)} MB` : "N/A"
        ]),
        ui("div", { key: "hw-lbl-heap", class: "metric-label" }, ["Active JS Heap Size"]),
      ]),
      
ui("div", { key: "hw-overhead", class: "metric-card" }, [
  ui("div", { key: "hw-val-overhead", class: "metric-val", style: "color: #f59e0b" }, [`${browserOverheadMs.value} ms`]),
  ui("div", { key: "hw-lbl-overhead", class: "metric-label" }, ["Paint / Layout Overhead"])
])
,
    ]),
  ]);
}

function renderHeader() {
  return ui("header", { key: "app-header" }, [
    ui("div", { key: "brand-bar", class: "brand" }, [
      ui("span", { key: "brand-logo", class: "logo-badge" }, ["Fried.js"]),
      ui("h1", { key: "app-title" }, ["Framework Tester & Playground"]),
    ]),
    ui("p", { key: "app-tagline", class: "tagline" }, [
      "Zero-build ES module runtime with in-place DOM hydration and AST-patchable keys."
    ]),
    ui("div", { key: "nav-controls", class: "button-row" }, [
      ui("button", {
          key: "tab-bench-btn",
          class: activeTab.value === "benchmark" ? "btn btn-primary" : "btn",
          onclick: () => setTab("benchmark"),
        },
        ["⚡ Synthetic Benchmark"]
      ),
      ui("button", {
          key: "tab-db-btn",
          class: activeTab.value === "database" ? "btn btn-primary" : "btn",
          onclick: () => setTab("database"),
        },
        ["💾 DB Admin Dashboard"]
      ),
      ui("button", {
          key: "tab-svg-btn",
          class: activeTab.value === "svg" ? "btn btn-primary" : "btn",
          onclick: () => setTab("svg"),
        },
        ["📈 Interactive SVG Chart"]
      ),
      ui("button", {
          key: "tab-krausest-btn",
          class: activeTab.value === "krausest" ? "btn btn-primary" : "btn",
          onclick: () => setTab("krausest"),
        },
        ["🔬 JS Framework Bench"]
      ),
      ui("button", {
          key: "toggle-keys-btn",
          class: inspectKeysActive.value ? "btn btn-danger" : "btn",
          onclick: toggleInspectKeys,
        },
        [inspectKeysActive.value ? "👁️ Hide Fried Keys" : "🔍 Highlight Fried Keys"]
      ),
    ]),
  ]);
}

function renderCounterCard() {
  return ui("div", { key: "counter-card", class: "card" }, [
    ui("div", { key: "counter-header", class: "card-header" }, [
      ui("span", { key: "counter-title", class: "card-title" }, ["⚡ Reactive Counter"]),
      ui("span", { key: "counter-badge", class: "badge badge-blue" }, ["state() & action()"]),
    ]),
    ui("p", { key: "counter-desc", style: "color: var(--text-muted); font-size: 0.9rem;" }, [
      "Tests state box updates and named action triggers with in-place DOM reconciliation:"
    ]),
    ui("div", { key: "counter-number", class: "counter-display" }, [count.value]),
    ui("div", { key: "counter-buttons", class: "button-row", style: "justify-content: center;" }, [
      ui("button", { key: "btn-dec", class: "btn", onclick: decrement }, ["- Decrement"]),
      ui("button", { key: "btn-reset", class: "btn btn-danger", onclick: resetCount }, ["Reset"]),
      ui("button", { key: "btn-inc", class: "btn btn-primary", onclick: increment }, ["+ Increment"]),
    ]),
  ]);
}

function renderTodoCard() {
  const currentTodos = todos.value;
  const filtered = currentTodos.filter((item) => {
    if (filter.value === "active") return !item.done;
    if (filter.value === "completed") return item.done;
    return true;
  });

  const remainingCount = currentTodos.filter((t) => !t.done).length;

  return ui("div", { key: "todo-card", class: "card" }, [
    ui("div", { key: "todo-header", class: "card-header" }, [
      ui("span", { key: "todo-title", class: "card-title" }, ["📋 Todo & List Manager"]),
      ui("span", { key: "todo-badge", class: "badge badge-green" }, [
        `${remainingCount} remaining`,
      ]),
    ]),
    ui("form", {
      key: "todo-form",
      class: "todo-form",
      onsubmit: (e) => {
        e.preventDefault();
        const input = e.target.querySelector("input");
        if (input && input.value.trim()) {
          addTodoFromForm(input.value.trim());
          input.value = "";
        }
      },
    }, [
      ui("input", {
        key: "todo-input-field",
        class: "input-text",
        type: "text",
        placeholder: "Type a task and press Enter or Add...",
        autocomplete: "off",
        "aria-label": "Add a new task",
      }),
      ui("button", { key: "todo-submit-btn", class: "btn btn-primary", type: "submit" }, ["Add Task"]),
    ]),
    ui("div", { key: "todo-filters", class: "button-row", style: "margin-bottom: 1rem;" }, [
      ui(
        "button",
        {
          key: "filter-all",
          class: filter.value === "all" ? "btn btn-sm btn-primary" : "btn btn-sm",
          onclick: () => setTodoFilter("all"),
        },
        [`All (${currentTodos.length})`]
      ),
      ui(
        "button",
        {
          key: "filter-active",
          class: filter.value === "active" ? "btn btn-sm btn-primary" : "btn btn-sm",
          onclick: () => setTodoFilter("active"),
        },
        ["Active"]
      ),
      ui(
        "button",
        {
          key: "filter-completed",
          class: filter.value === "completed" ? "btn btn-sm btn-primary" : "btn btn-sm",
          onclick: () => setTodoFilter("completed"),
        },
        ["Completed"]
      ),
      ui(
        "button",
        {
          key: "clear-completed-btn",
          class: "btn btn-sm btn-danger",
          style: "margin-left: auto;",
          onclick: clearCompletedTodos,
        },
        ["Clear Completed"]
      ),
    ]),
    ui("ul", { key: "todo-list-container", class: "todo-list" }, [
      filtered.length === 0
        ? ui("li", { key: "todo-empty", style: "color: var(--text-muted); text-align: center; padding: 1rem;" }, [
            "No tasks found for this filter.",
          ])
        : filtered.map((item) =>
            ui(
              "li",
              {
                key: `todo-item-${item.id}`,
                class: item.done ? "todo-item completed" : "todo-item",
              },
              [
                ui("div", { key: `todo-item-left-${item.id}`, class: "todo-item-left" }, [
                  ui("input", {
                    key: `chk-${item.id}`,
                    type: "checkbox",
                    checked: item.done,
                    onchange: () => toggleTodo(item.id),
                  }),
                  ui("span", { key: `todo-text-${item.id}` }, [item.text]),
                ]),
                ui("div", { key: `todo-item-right-${item.id}`, style: "display: flex; align-items: center; gap: 0.5rem;" }, [
                  ui("span", { key: `todo-uid-${item.id}`, class: "todo-item-id" }, [`#${item.id}`]),
                  ui(
                    "button",
                    {
                      key: `del-btn-${item.id}`,
                      class: "btn btn-danger btn-sm",
                      onclick: () => removeTodo(item.id),
                    },
                    ["✕"]
                  ),
                ]),
              ]
            )
          ),
    ]),
  ]);
}

function renderArchitectureCard() {
  return ui("div", { key: "arch-card", class: "card" }, [
    ui("div", { key: "arch-header", class: "card-header" }, [
      ui("span", { key: "arch-title", class: "card-title" }, ["📖 Fried.js Architecture & Patching"]),
      ui("span", { key: "arch-badge", class: "badge badge-blue" }, ["Design Philosophy"]),
    ]),
    ui("div", { key: "arch-content" }, [
      ui("p", { key: "arch-p1", style: "margin-bottom: 0.75rem;" }, [
        "Fried.js is engineered specifically for AI code agents to read and modify reliably without breaking formatting or complex AST transforms:"
      ]),
      ui("ul", { key: "arch-list", style: "padding-left: 1.25rem; margin-bottom: 0.75rem; color: var(--text-muted);" }, [
        ui("li", { key: "arch-item-1" }, [
          ui("strong", {}, ["Zero Build Step: "]),
          "Standard ES module loaded directly in the browser."
        ]),
        ui("li", { key: "arch-item-2" }, [
          ui("strong", {}, ["In-Place Hydration: "]),
          "Preserves existing DOM nodes and synchronizes attributes/text in place using dataset.friedKey."
        ]),
        ui("li", { key: "arch-item-3" }, [
          ui("strong", {}, ["Named Actions: "]),
          "action('name', fn) marks functions so patcher.js can find and edit them by string literal."
        ]),
        ui("li", { key: "arch-item-4" }, [
          ui("strong", {}, ["Addressable Keys: "]),
          "ui(tag, { key: '...' }) attaches data-fried-key to the DOM and gives patcher.js exact source call sites."
        ]),
      ]),
      ui("div", { key: "arch-tip", class: "info-box" }, [
        "💡 Click ",
        ui("code", {}, ["🔍 Highlight Fried Keys"]),
        " above to visually reveal the ",
        ui("code", {}, ["data-fried-key"]),
        " labels generated on every single node of this page!"
      ]),
    ]),
  ]);
}

function renderAuditPanel() {
  const stats = computeTelemetryStats();
  const mem = (typeof performance !== "undefined" && performance.memory)
    ? {
        used: (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1),
        total: (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(1),
      }
    : null;

  return ui("div", { key: "audit-panel-card", class: "audit-card" }, [
    ui("div", { key: "audit-card-hdr", class: "card-header", style: "margin-bottom: 0.5rem;" }, [
      ui("span", { key: "audit-card-title", class: "card-title" }, ["📊 Real-Time Telemetry & Agent Audit"]),
      ui("span", { key: "audit-samples-count", class: "badge badge-blue" }, [`${stats.sampleCount} Samples`]),
    ]),
    ui("p", { key: "audit-card-desc", style: "color: var(--text-muted); font-size: 0.85rem;" }, [
      "Hardware profiles, percentile latency distributions, and frame stall metrics ready to audit or send to your AI assistant:"
    ]),

    // Metric Pills Row
    ui("div", { key: "audit-pills-row", class: "audit-metrics-row" }, [
      ui("div", { key: "pill-p50", class: "audit-pill" }, [
        ui("div", { key: "val-p50", class: "audit-pill-val" }, [`${stats.p50.toFixed(1)}ms`]),
        ui("div", { key: "lbl-p50", class: "audit-pill-lbl" }, ["Median (p50)"]),
      ]),
      ui("div", { key: "pill-p95", class: "audit-pill" }, [
        ui("div", { key: "val-p95", class: `audit-pill-val ${stats.p95 > 50 ? "bad" : stats.p95 > 25 ? "warn" : "good"}` }, [
          `${stats.p95.toFixed(1)}ms`
        ]),
        ui("div", { key: "lbl-p95", class: "audit-pill-lbl" }, ["p95 Spike"]),
      ]),
      ui("div", { key: "pill-p99", class: "audit-pill" }, [
        ui("div", { key: "val-p99", class: "audit-pill-val" }, [`${stats.p99.toFixed(1)}ms`]),
        ui("div", { key: "lbl-p99", class: "audit-pill-lbl" }, ["p99 Peak"]),
      ]),
      ui("div", { key: "pill-split", class: "audit-pill" }, [
        ui("div", { key: "val-split", class: "audit-pill-val", style: "font-size: 0.9rem;" }, [
          `${stats.avgTree.toFixed(0)}ms / ${stats.avgHydrate.toFixed(0)}ms`
        ]),
        ui("div", { key: "lbl-split", class: "audit-pill-lbl" }, ["Tree / Hydrate"]),
      ]),
      ui("div", { key: "pill-stalls", class: "audit-pill" }, [
        ui("div", { key: "val-stalls", class: `audit-pill-val ${longTaskCount > 0 ? "warn" : "good"}` }, [
          `${longTaskCount}`
        ]),
        ui("div", { key: "lbl-stalls", class: "audit-pill-lbl" }, ["Stalls (>50ms)"]),
      ]),
      ui("div", { key: "pill-mem", class: "audit-pill" }, [
        ui("div", { key: "val-mem", class: "audit-pill-val", style: "font-size: 0.95rem;" }, [
          mem ? `${mem.used} MB` : "N/A"
        ]),
        ui("div", { key: "lbl-mem", class: "audit-pill-lbl" }, ["JS Heap"]),
      ]),
    ]),

    // Action Buttons
    ui("div", { key: "audit-btns-row", class: "button-row", style: "align-items: center;" }, [
      ui("input", { key: "audit-label", type: "text", value: auditLabel.value, oninput: (e) => auditLabel.value = e.target.value, placeholder: "Audit Label (e.g. baseline)", class: "input" }),

      ui("button", { key: "btn-send-server", class: "btn btn-primary", onclick: sendAuditToServer }, [
        "📤 Save Audit to Workspace (for Agent)"
      ]),
      ui("button", { key: "btn-copy-md", class: "btn", onclick: copyAuditMarkdown }, [
        "📋 Copy Markdown for Chat"
      ]),
      ui("button", { key: "btn-dl-json", class: "btn", onclick: downloadAuditJson }, [
        "💾 Download JSON"
      ]),
      ui("button", { key: "btn-reset-samples", class: "btn btn-danger", onclick: resetAuditSamples }, [
        "🗑 Reset Samples"
      ]),
    ]),
  ]);
}

function renderBenchmarkCard() {
  const nodes = stressNodes.value;
  const nodeCount = nodes.length;

  const latencyClass =
    lastRenderDurationMs < 16 ? "good" : lastRenderDurationMs < 45 ? "warn" : "bad";
  const fpsClass = currentFps >= 45 ? "good" : currentFps >= 20 ? "warn" : "bad";

  return ui("div", { key: "bench-card", class: "card" }, [
    ui("div", { key: "bench-header", class: "card-header" }, [
      ui("span", { key: "bench-title", class: "card-title" }, ["⚡ In-Place DOM Hydration Stress Test"]),
      ui(
        "span",
        {
          key: "bench-status-badge",
          class: tickerActive.value ? "badge badge-red" : "badge badge-green",
        },
        [tickerActive.value ? "⚡ CHAOS TICKER ACTIVE" : "IDLE"]
      ),
    ]),
    ui("p", { key: "bench-desc", style: "color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.25rem;" }, [
      "Now upgraded with ",
      ui("strong", {}, ["Vue/Svelte-style in-place DOM hydration & microtask batching"]),
      ". Instead of wiping ",
      ui("code", {}, ["root.innerHTML = ''"]),
      ", existing nodes are reconciled and patched in place using ",
      ui("code", {}, ["data-fried-key"]),
      ":"
    ]),

    // Action Buttons
    ui("div", { key: "bench-actions", class: "button-row" }, [
      ui("button", { key: "btn-gen-250", class: "btn btn-primary", onclick: () => generateStressNodes(250) }, ["+ 250 Nodes"]),
      ui("button", { key: "btn-gen-1000", class: "btn btn-primary", onclick: () => generateStressNodes(1000) }, ["+ 1,000 Nodes"]),
      ui("button", { key: "btn-gen-2500", class: "btn btn-primary", onclick: () => generateStressNodes(2500) }, ["+ 2,500 Nodes"]),
      ui("button", { key: "btn-gen-5000", class: "btn btn-primary", onclick: () => generateStressNodes(5000) }, ["+ 5,000 Nodes (Heavy)"]),
      ui("button", { key: "btn-mutate", class: "btn", onclick: mutateRandomNodes, disabled: nodeCount === 0 }, ["🎲 Mutate 25% Randomly"]),
      ui(
        "button",
        {
          key: "btn-chaos-ticker",
          class: tickerActive.value ? "btn btn-danger" : "btn",
          onclick: toggleChaosTicker,
          disabled: nodeCount === 0,
        },
        [tickerActive.value ? "⏹ Stop Chaos Ticker" : "⚡ Start Chaos Ticker (30Hz)"]
      ),
      ui("button", { key: "btn-clear-nodes", class: "btn btn-danger", onclick: clearStressNodes, disabled: nodeCount === 0 }, ["Clear All"]),
      ui("button", { key: "btn-thrash", class: tickerActive.value ? "btn btn-danger" : "btn btn-primary", onclick: toggleMountThrashing, disabled: nodeCount === 0 }, [tickerActive.value ? "⏹ Stop Thrashing" : "⚡ Mount/Unmount Thrashing"]),
      ui("button", { key: "btn-mass-css", class: "btn", onclick: toggleMassCss }, ["🎨 Toggle Mass CSS Reflow"]),
    ]),

    // Audit Panel
    renderAuditPanel(),

    // Rich Node Grid View (Virtualized)
    nodeCount === 0
      ? ui("div", { key: "bench-empty", class: "info-box", style: "margin-top: 1.5rem;" }, [
          "💡 Click one of the buttons above (e.g. ",
          ui("strong", {}, ["+ 5,000 Nodes"]),
          ") to populate the stress grid with rich data cards."
        ])
      : (() => {
          // Virtualization Math
          const colWidth = 280;
          const gap = 16;
          // Calculate columns based on current viewport state (minus container padding roughly)
          const availableWidth = Math.min(viewport.value.width - 64, 1200 - 32); 
          const cols = Math.max(1, Math.floor((availableWidth + gap) / (colWidth + gap)));
          const itemHeight = 140; // Fixed card height
          const rowHeight = itemHeight + gap;
          const totalRows = Math.ceil(nodes.length / cols);
          const totalHeight = totalRows * rowHeight;
          const vh = window.innerHeight * 0.65; // Matches vContainer height

          // Determine visible rows with a small buffer for smooth scrolling
          const startRow = Math.max(0, Math.floor(viewport.value.scrollTop / rowHeight) - 1);
          const endRow = Math.min(totalRows - 1, Math.ceil((viewport.value.scrollTop + vh) / rowHeight) + 1);

          const visibleNodes = [];
          
          for (let r = startRow; r <= endRow; r++) {
            for (let c = 0; c < cols; c++) {
              const idx = r * cols + c;
              if (idx >= nodes.length) break;
              const n = nodes[idx];

              const badgeCls = `${S.badge} ${n.status === "HEALTHY" ? S.badgeGreen : n.status === "WARNING" ? S.badgeYellow : S.badgeRed}`;
              cssVar(`--load-${n.id}`, `${n.load}%`);

              // Absolute position math per card
              const left = c * (colWidth + gap);
              const top = r * rowHeight;

              visibleNodes.push(
                ui("div", { 
                  key: `stress-card-${n.id}`, 
                  class: `${S.vCard} rich-node`, 
                  style: `transform: translate(${left}px, ${top}px); height: ${itemHeight}px;` 
                }, [
                  ui("div", { key: `node-top-${n.id}`, class: S.nodeHeader }, [
                    ui("span", { key: `node-title-${n.id}`, class: S.nodeTitle }, [n.title]),
                    ui("span", { key: `node-status-${n.id}`, class: badgeCls }, [n.status]),
                  ]),
                  ui("div", { key: `node-body-${n.id}`, class: S.nodeBody }, [
                    ui("span", { key: `node-hash-${n.id}` }, [`Hash: ${n.hash}`]),
                    ui("span", { key: `node-metrics-${n.id}` }, [`Latency: ${n.latency} • Mem: ${n.memory}`]),
                    ui("span", { key: `node-time-${n.id}` }, [`Updated: ${n.timeStr}`]),
                    ui("div", { key: `node-track-${n.id}`, class: S.meterTrack }, [
                      ui("div", {
                        key: `node-bar-${n.id}`,
                        class: n.load > 75 ? S.meterBarHigh : S.meterBar,
                        style: `width:var(--load-${n.id},0%)`,
                      }),
                    ]),
                  ]),
                  ui("button", {
                    key: `node-mutate-btn-${n.id}`,
                    class: "btn btn-sm",
                    style: "margin-top:0.3rem;align-self:flex-end",
                    onclick: () => mutateSingleNode(n.id),
                  }, ["Mutate Single"])
                ])
              );
            }
          }

          return ui("div", { key: "v-wrapper", style: "margin-top: 1.5rem;" }, [
            ui("div", { 
              key: "v-container", 
              class: S.vContainer, 
              // onscroll triggers an instant global re-render, but since we only 
              // render ~20 visible DOM nodes, it takes ~2ms and hits 60fps easily.
              onscroll: action("onVirtualScroll", (e) => {
                viewport.value = { ...viewport.value, scrollTop: e.target.scrollTop };
              })
            }, [
              // This invisble spanner forces the scrollbar to the correct full size
              ui("div", { key: "v-spanner", class: S.vSpanner, style: `height: ${totalHeight}px;` }),
              ...visibleNodes
            ])
          ]);
        })()
  ]);
}

function renderTestSuiteCard() {
  const results = testSuiteResults.value || [];
  const passedCount = results.filter((r) => r.passed).length;
  const allPassed = results.length > 0 && passedCount === results.length;

  return ui("div", { key: "test-suite-card", class: "card" }, [
    ui("div", { key: "test-suite-header", class: "card-header" }, [
      ui("span", { key: "test-suite-title", class: "card-title" }, ["🧪 In-Browser Test Suite"]),
      ui(
        "span",
        {
          key: "test-summary-badge",
          class: results.length === 0 ? "badge" : allPassed ? "badge badge-green" : "badge badge-red",
        },
        [results.length === 0 ? "Not Run Yet" : `${passedCount}/${results.length} Passed`]
      ),
    ]),
    ui("div", { key: "test-actions-row", class: "button-row", style: "margin-bottom: 1rem;" }, [
      ui("button", { key: "run-tests-btn", class: "btn btn-primary", onclick: runBrowserTests }, [
        "▶ Run All Browser Tests"
      ]),
    ]),
    ui(
      "div",
      { key: "test-items-container", class: "test-suite" },
      results.length === 0
        ? [
            ui(
              "div",
              { key: "tests-placeholder", style: "text-align: center; color: var(--text-muted); padding: 1.5rem;" },
              ["Click 'Run All Browser Tests' to execute automated assertions directly against fried.js APIs."]
            )
          ]
        : results.map((r, i) =>
            ui("div", { key: `test-row-${i}`, class: "test-row" }, [
              ui("div", { key: `test-col-${i}` }, [
                ui("div", { key: `test-name-${i}`, class: "test-name" }, [r.name]),
                ui("div", { key: `test-detail-${i}`, style: "color: var(--text-muted); font-size: 0.75rem; margin-top: 0.2rem;" }, [
                  r.detail
                ]),
              ]),
              ui(
                "span",
                {
                  key: `test-status-${i}`,
                  class: r.passed ? "badge badge-green" : "badge badge-red",
                },
                [r.passed ? "PASS" : "FAIL"]
              ),
            ])
          )
    ),
    ui("div", { key: "test-cli-tip", class: "info-box" }, [
      "You can also run headless Node.js tests for both ",
      ui("code", {}, ["fried.js"]),
      " and ",
      ui("code", {}, ["patcher.js"]),
      " in terminal using: ",
      ui("code", {}, ["npm test"])
    ]),
  ]);
}

function generateDbUsers(count) {
  const users = [];
  const roles = ["Admin", "Editor", "Viewer"];
  for(let i=0; i<count; i++) {
    users.push({
      name: `User ${Math.floor(Math.random() * 100000)}`,
      role: roles[Math.floor(Math.random() * roles.length)],
      age: Math.floor(Math.random() * 50) + 18
    });
  }
  db.collections.users.bulkInsert(users);
}

const dbSearchQuery = state("");
const dbSortCol = state("id");
const dbSortAsc = state(true);
const dbViewport = state({ scrollTop: 0, height: 400 });

const toggleDbSort = action("toggleDbSort", (col) => {
  if (dbSortCol.value === col) {
    dbSortAsc.value = !dbSortAsc.value;
  } else {
    dbSortCol.value = col;
    dbSortAsc.value = true;
  }
});

function renderDatabaseCard() {
  const allUsers = db.collections.users.value || [];
  
  // 1. Filter
  const query = dbSearchQuery.value.toLowerCase();
  let processed = query ? allUsers.filter(u => 
    u.name.toLowerCase().includes(query) || 
    u.role.toLowerCase().includes(query)
  ) : allUsers.slice();

  // 2. Sort
  const col = dbSortCol.value;
  const asc = dbSortAsc.value ? 1 : -1;
  processed.sort((a, b) => {
    if (a[col] < b[col]) return -1 * asc;
    if (a[col] > b[col]) return 1 * asc;
    return 0;
  });

  // 3. Virtualization Math
  const rowHeight = 35; // px per row
  const totalRows = processed.length;
  const totalHeight = totalRows * rowHeight;
  const visibleRows = Math.ceil(dbViewport.value.height / rowHeight) + 2;
  const startRow = Math.max(0, Math.floor(dbViewport.value.scrollTop / rowHeight) - 1);
  const endRow = Math.min(totalRows, startRow + visibleRows);
  
  const visibleUsers = [];
  for (let i = startRow; i < endRow; i++) {
    const u = processed[i];
    const top = i * rowHeight;
    visibleUsers.push(
      ui("div", { key: `user-${u.id}`, class: "db-row", style: `position: absolute; top: ${top}px; left: 0; right: 0; height: ${rowHeight}px; display: flex; align-items: center; border-bottom: 1px solid var(--border); padding: 0 8px; font-size: 0.85rem;` }, [
        ui("div", { style: "width: 15%; font-family: var(--font-mono); color: var(--text-muted);" }, [String(u.id).slice(0,6)]),
        ui("div", { style: "width: 35%; font-weight: 500;" }, [u.name]),
        ui("div", { style: "width: 20%;" }, [u.role]),
        ui("div", { style: "width: 15%;" }, [u.age]),
        ui("div", { style: "width: 15%;" }, [
          ui("button", { class: "btn btn-sm btn-danger", onclick: () => db.collections.users.remove(u.id) }, ["Delete"])
        ])
      ])
    );
  }

  const sortIcon = (c) => dbSortCol.value === c ? (dbSortAsc.value ? " ↑" : " ↓") : "";

  return ui("div", { key: "db-card", class: "card" }, [
    ui("div", { key: "db-header", class: "card-header" }, [
      ui("span", { key: "db-title", class: "card-title" }, ["💾 10k Data Grid Dashboard"]),
      ui("span", { key: "db-badge", class: "badge badge-blue" }, [`${processed.length} Records`]),
    ]),
    ui("p", { key: "db-desc", style: "color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.25rem;" }, [
      "Tests live array filtering, multi-column sorting, and absolute DOM virtualization on 10,000 JSON records."
    ]),
    
    ui("div", { key: "db-actions", class: "button-row", style: "margin-bottom: 1rem;" }, [
      ui("button", { key: "btn-db-add-1", class: "btn btn-primary", onclick: () => generateDbUsers(1) }, ["+ Add 1 User"]),
      ui("button", { key: "btn-db-add-10k", class: "btn btn-primary", onclick: () => generateDbUsers(10000) }, ["+ Bulk Insert 10,000"]),
      ui("button", { key: "btn-db-clear", class: "btn btn-danger", onclick: () => db.collections.users.clear() }, ["🗑 Clear DB"]),
      ui("input", { 
        key: "db-search", 
        type: "text", 
        class: "input-text", 
        placeholder: "Live Search Name/Role...", 
        value: dbSearchQuery.value,
        style: "flex: 1;",
        oninput: action("dbSearch", (e) => { dbSearchQuery.value = e.target.value; })
      })
    ]),

    ui("div", { key: "db-table-wrap", style: "position: relative; border: 1px solid var(--border); border-radius: 4px;" }, [
      // Table Header (Sticky mock)
      ui("div", { key: "db-th", style: "display: flex; background: var(--surface); padding: 8px; font-weight: bold; font-size: 0.85rem; border-bottom: 2px solid var(--border);" }, [
        ui("div", { style: "width: 15%; cursor: pointer;", onclick: () => toggleDbSort("id") }, ["ID" + sortIcon("id")]),
        ui("div", { style: "width: 35%; cursor: pointer;", onclick: () => toggleDbSort("name") }, ["Name" + sortIcon("name")]),
        ui("div", { style: "width: 20%; cursor: pointer;", onclick: () => toggleDbSort("role") }, ["Role" + sortIcon("role")]),
        ui("div", { style: "width: 15%; cursor: pointer;", onclick: () => toggleDbSort("age") }, ["Age" + sortIcon("age")]),
        ui("div", { style: "width: 15%;" }, ["Action"]),
      ]),
      // Virtualized Body
      ui("div", { 
        key: "db-tbody", 
        style: `height: 400px; overflow-y: auto; position: relative;`,
        onscroll: action("onDbScroll", (e) => {
          dbViewport.value = { ...dbViewport.value, scrollTop: e.target.scrollTop };
        })
      }, [
        ui("div", { key: "db-spanner", style: `position: absolute; top: 0; left: 0; width: 1px; height: ${totalHeight}px;` }),
        ...visibleUsers
      ])
    ])
  ]);
}

function renderApp() {
  totalRenderCycles++;

  let mainContent;
  if (activeTab.value === "benchmark") {
    mainContent = ui("div", { key: "bench-view" }, [renderBenchmarkCard()]);
  } else if (activeTab.value === "database") {
    mainContent = ui("div", { key: "db-view" }, [renderDatabaseCard()]);
  } else if (activeTab.value === "svg") {
    mainContent = ui("div", { key: "svg-view" }, [renderSvgChartCard()]);
  } else if (activeTab.value === "krausest") {
    mainContent = ui("div", { key: "krausest-view" }, [renderJsFrameworkBenchCard()]);
  }

  return ui("div", { key: "main-app-container", class: "container" }, [
    renderHeader(),
    renderGlobalTelemetry(),
    mainContent,
    auditToast.value
      ? ui("div", { key: "audit-toast", class: `toast-banner toast-${auditToast.value.type === "success" ? "success" : "error"}`, style: "position: fixed; bottom: 20px; right: 20px; z-index: 9999;" }, [
          ui("span", { key: "toast-msg" }, [auditToast.value.text]),
          ui("button", { key: "toast-close", class: "btn btn-sm", onclick: dismissToast, style: "padding: 0.1rem 0.4rem; margin-left: 1rem;", "aria-label": "Close notification" }, ["✕"]),
        ])
      : null,
    ui("footer", { key: "app-footer" }, [
      ui("p", { key: "footer-text" }, [
        "Fried.js Library Tester • Pure Vanilla ES Modules • No Bundler Required"
      ]),
    ]),
  ]);
}

// Mount the app into #app container
const mountTarget = document.getElementById("app");
if (mountTarget) {
  mount(renderApp, mountTarget);
} else {
  console.error("No #app mount element found!");
}

// ==========================================
// NEW BENCHMARK: SVG Interactive Chart
// ==========================================
const svgData = state([]);
const svgTickerActive = state(false);
let svgTickerId = null;

let svgTick = 0;
const toggleSvgTicker = action("toggleSvgTicker", () => {
  if (svgTickerActive.value) {
    if (svgTickerId) clearInterval(svgTickerId);
    svgTickerId = null;
    svgTickerActive.value = false;
  } else {
    svgTickerActive.value = true;
    let data = [];
    svgTick = 0;
    for (let i = 0; i < 200; i++) {
      const t = (svgTick + i) * 0.05;
      data.push(150 + Math.sin(t) * 40 + Math.cos(t * 0.5) * 20 + Math.sin(t * 0.2) * 30 + (Math.sin(i * 47) * 4)); // deterministic "jitter"
    }
    svgData.value = data;
    
    svgTickerId = setInterval(() => {
      svgTick++;
      const arr = svgData.value.slice(1);
      const t = (svgTick + 200) * 0.05;
      const nextVal = 150 + Math.sin(t) * 40 + Math.cos(t * 0.5) * 20 + Math.sin(t * 0.2) * 30 + (Math.sin((svgTick + 200) * 47) * 4);
      arr.push(nextVal);
      svgData.value = arr;
    }, 16); // 60fps data updates
  }
});

function renderSvgChartCard() {
  const points = svgData.value;
  let pathD = "";
  if (points.length > 0) {
    pathD = `M 0 ${points[0]}`;
    for (let i = 1; i < points.length; i++) {
      pathD += ` L ${i * 5} ${points[i]}`;
    }
  }

  return ui("div", { key: "svg-card", class: "card" }, [
    ui("div", { key: "svg-header", class: "card-header" }, [
      ui("span", { key: "svg-title", class: "card-title" }, ["📈 Interactive SVG Stock Chart"]),
      ui("span", { key: "svg-badge", class: "badge badge-blue" }, [`${points.length} Points`]),
    ]),
    ui("p", { key: "svg-desc", style: "color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.25rem;" }, [
      "This test constructs a complex SVG graph. If a framework has namespace issues, SVG elements fail to render or update correctly. The path data updates 60 times a second."
    ]),
    ui("div", { key: "svg-actions", class: "button-row", style: "margin-bottom: 1rem;" }, [
      ui("button", { key: "btn-svg-ticker", class: svgTickerActive.value ? "btn btn-danger" : "btn btn-primary", onclick: toggleSvgTicker }, [svgTickerActive.value ? "⏹ Stop Ticker" : "▶ Start Ticker"]),
      ui("button", { key: "btn-svg-audit", class: "btn btn-primary", onclick: sendAuditToServer }, ["📤 Save Audit Log"])
    ]),
    ui("svg", { key: "svg-chart", width: "100%", height: "300", style: "background: var(--surface); border: 1px solid var(--border); border-radius: 4px;" }, [
      ui("path", { key: "svg-path", d: pathD, fill: "none", stroke: "#3b82f6", "stroke-width": "2" }),
      ...points.map((p, i) => ui("circle", { key: `pt-${i}`, cx: i * 5, cy: p, r: 2, fill: "#a855f7" }))
    ])
  ]);
}

// ==========================================
// NEW BENCHMARK: JS Framework Benchmark (Krausest)
// ==========================================
const krausestRows = state([]);
const krausestSelected = state(null);
let nextKrausestId = 1;

function buildKrausestData(count) {
  const adjectives = ["pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain", "quaint", "clean", "elegant", "easy", "angry", "crazy", "helpful", "mushy", "odd", "unsightly", "adorable", "important", "inexpensive", "cheap", "expensive", "fancy"];
  const colours = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"];
  const nouns = ["table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger", "pizza", "mouse", "keyboard"];
  
  const data = [];
  for (let i = 0; i < count; i++) {
    data.push({
      id: nextKrausestId++,
      label: adjectives[Math.random()*adjectives.length|0] + " " + colours[Math.random()*colours.length|0] + " " + nouns[Math.random()*nouns.length|0]
    });
  }
  return data;
}

const krausestRun = action("krausestRun", () => { krausestRows.value = buildKrausestData(1000); krausestSelected.value = null; });
const krausestRunLots = action("krausestRunLots", () => { krausestRows.value = buildKrausestData(10000); krausestSelected.value = null; });
const krausestAdd = action("krausestAdd", () => { krausestRows.value = krausestRows.value.concat(buildKrausestData(1000)); });
const krausestUpdate = action("krausestUpdate", () => {
  const current = krausestRows.value.slice();
  for (let i = 0; i < current.length; i += 10) {
    current[i] = Object.assign({}, current[i], { label: current[i].label + ' !!!' });
  }
  krausestRows.value = current;
});
const krausestClear = action("krausestClear", () => { krausestRows.value = []; krausestSelected.value = null; });
const krausestSwapRows = action("krausestSwapRows", () => {
  const current = krausestRows.value.slice();
  if (current.length > 998) {
    let tmp = current[1];
    current[1] = current[998];
    current[998] = tmp;
    krausestRows.value = current;
  }
});

function renderJsFrameworkBenchCard() {
  const rows = krausestRows.value;
  return ui("div", { key: "krausest-card", class: "card" }, [
    ui("div", { key: "k-header", class: "card-header" }, [
      ui("span", { key: "k-title", class: "card-title" }, ["🔬 JS Framework Benchmark"]),
    ]),
    ui("p", { key: "k-desc", style: "color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.25rem;" }, [
      "The official standard test for UI frameworks (krausest). No virtualization, just raw DOM node manipulation."
    ]),
    ui("div", { key: "k-actions", class: "button-row", style: "margin-bottom: 1rem; flex-wrap: wrap;" }, [
      ui("button", { key: "btn-run", class: "btn btn-primary", onclick: krausestRun }, ["Create 1,000 rows"]),
      ui("button", { key: "btn-runlots", class: "btn btn-primary", onclick: krausestRunLots }, ["Create 10,000 rows"]),
      ui("button", { key: "btn-add", class: "btn btn-primary", onclick: krausestAdd }, ["Append 1,000 rows"]),
      ui("button", { key: "btn-update", class: "btn btn-primary", onclick: krausestUpdate }, ["Update every 10th row"]),
      ui("button", { key: "btn-clear", class: "btn btn-primary", onclick: krausestClear }, ["Clear"]),
      ui("button", { key: "btn-swap", class: "btn btn-primary", onclick: krausestSwapRows }, ["Swap Rows"]),
    ]),
    ui("table", { key: "k-table", class: "table table-hover table-striped test-data", style: "width: 100%; text-align: left; border-collapse: collapse; font-size: 0.9rem;" }, [
      ui("tbody", { key: "k-tbody" }, 
        rows.map(r => 
          ui("tr", { key: `r-${r.id}`, class: r.id === krausestSelected.value ? "danger" : "", style: r.id === krausestSelected.value ? "background: #ef444450;" : "" }, [
            ui("td", { class: "col-md-1", style: "padding: 8px; border-bottom: 1px solid var(--border);" }, [r.id]),
            ui("td", { class: "col-md-4", style: "padding: 8px; border-bottom: 1px solid var(--border);" }, [
              ui("a", { onclick: () => { krausestSelected.value = r.id; }, style: "cursor:pointer; color: #3b82f6;" }, [r.label])
            ]),
            ui("td", { class: "col-md-1", style: "padding: 8px; border-bottom: 1px solid var(--border);" }, [
              ui("a", { onclick: () => { 
                const current = krausestRows.value.slice();
                const idx = current.findIndex(x => x.id === r.id);
                if (idx > -1) { current.splice(idx, 1); krausestRows.value = current; }
              }, style: "cursor:pointer;" }, [
                ui("span", { class: "glyphicon glyphicon-remove", "aria-hidden": "true" }, ["❌"])
              ])
            ]),
            ui("td", { class: "col-md-6", style: "padding: 8px; border-bottom: 1px solid var(--border);" })
          ])
        )
      )
    ])
  ]);
}
