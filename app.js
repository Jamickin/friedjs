import { mount, state, action, ui, uid } from "./fried.js";

// --- State Definitions ---
const count = state(0);
const todos = state([
  { id: uid(), text: "Explore fried.js minimal runtime", done: true },
  { id: uid(), text: "Test named actions and AST keys", done: true },
  { id: uid(), text: "Try patching with patcher.js", done: false },
]);
const filter = state("all");
const inspectKeysActive = state(false);
const activeTab = state("showcase"); // "showcase" | "tests" | "benchmark"
const testSuiteResults = state(null);

// --- Stress Test State & Telemetry ---
const stressNodes = state([]);
const tickerActive = state(false);
let lastRenderDurationMs = 0;
let totalRenderCycles = 0;
let tickerTimerId = null;
let lastFrameTimestamp = performance.now();
let currentFps = 60;
let frameCounter = 0;

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
  activeTab.value = tabName;
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
  const list = [];
  for (let i = 0; i < targetCount; i++) {
    list.push(createRichNode(i));
  }
  stressNodes.value = list;
});

const mutateRandomNodes = action("mutateRandomNodes", () => {
  const current = stressNodes.value;
  if (current.length === 0) return;

  const statuses = ["HEALTHY", "WARNING", "CRITICAL"];
  stressNodes.value = current.map((item) => {
    // Mutate 25% of nodes
    if (Math.random() < 0.25) {
      return {
        ...item,
        status: statuses[Math.floor(Math.random() * 3)],
        load: Math.floor(Math.random() * 95) + 5,
        latency: `${(Math.random() * 40 + 2).toFixed(1)}ms`,
        hash: `0x${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
      };
    }
    return item;
  });
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
    clearInterval(tickerTimerId);
    tickerTimerId = null;
    tickerActive.value = false;
  } else {
    tickerActive.value = true;
    lastFrameTimestamp = performance.now();
    frameCounter = 0;

    tickerTimerId = setInterval(() => {
      frameCounter++;
      const now = performance.now();
      const elapsed = now - lastFrameTimestamp;
      if (elapsed >= 500) {
        currentFps = Math.round((frameCounter * 1000) / elapsed);
        frameCounter = 0;
        lastFrameTimestamp = now;
      }
      mutateRandomNodes();
    }, 33); // ~30 updates/sec
  }
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

function renderHeader() {
  return ui("header", { key: "app-header" }, [
    ui("div", { key: "brand-bar", class: "brand" }, [
      ui("span", { key: "brand-logo", class: "logo-badge" }, ["Fried.js"]),
      ui("h1", { key: "app-title" }, ["Framework Tester & Playground"]),
    ]),
    ui("p", { key: "app-tagline", class: "tagline" }, [
      "Zero-build ES module runtime with dumb reactivity and AST-patchable keys."
    ]),
    ui("div", { key: "nav-controls", class: "button-row" }, [
      ui(
        "button",
        {
          key: "tab-showcase-btn",
          class: activeTab.value === "showcase" ? "btn btn-primary" : "btn",
          onclick: () => setTab("showcase"),
        },
        ["🚀 Interactive Showcase"]
      ),
      ui(
        "button",
        {
          key: "tab-bench-btn",
          class: activeTab.value === "benchmark" ? "btn btn-primary" : "btn",
          onclick: () => setTab("benchmark"),
        },
        ["⚡ Stress Test & Benchmark"]
      ),
      ui(
        "button",
        {
          key: "tab-tests-btn",
          class: activeTab.value === "tests" ? "btn btn-primary" : "btn",
          onclick: () => {
            setTab("tests");
            if (!testSuiteResults.value) {
              runBrowserTests();
            }
          },
        },
        ["🧪 In-Browser Test Suite"]
      ),
      ui(
        "button",
        {
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
      "Tests state box updates and named action triggers with automatic re-rendering:"
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
          ui("strong", {}, ["Dumb Full Re-render: "]),
          "Any state change or action execution clears root and re-runs the render tree. No virtual-DOM diffing bugs."
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

function renderBenchmarkCard() {
  const nodes = stressNodes.value;
  const nodeCount = nodes.length;
  const totalElements = nodeCount * 7 + 45; // Compound DOM nodes

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

    // Telemetry Metric Grid
    ui("div", { key: "bench-metrics-grid", class: "grid grid-4", style: "margin-bottom: 1.5rem;" }, [
      ui("div", { key: "metric-count", class: "metric-card" }, [
        ui("div", { key: "val-count", class: "metric-val" }, [nodeCount.toLocaleString()]),
        ui("div", { key: "lbl-count", class: "metric-label" }, ["Data Cards"]),
      ]),
      ui("div", { key: "metric-elements", class: "metric-card" }, [
        ui("div", { key: "val-elements", class: "metric-val" }, [totalElements.toLocaleString()]),
        ui("div", { key: "lbl-elements", class: "metric-label" }, ["DOM Elements"]),
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
    ]),

    // Rich Node Grid View
    nodeCount === 0
      ? ui("div", { key: "bench-empty", class: "info-box", style: "margin-top: 1.5rem;" }, [
          "💡 Click one of the buttons above (e.g. ",
          ui("strong", {}, ["+ 1,000 Nodes"]),
          ") to populate the stress grid with rich data cards."
        ])
      : ui(
          "div",
          { key: "stress-nodes-grid", class: "stress-grid" },
          nodes.map((n) => {
            const statusBadgeClass =
              n.status === "HEALTHY" ? "badge badge-green" : n.status === "WARNING" ? "badge" : "badge badge-red";

            return ui("div", { key: `stress-card-${n.id}`, class: "rich-node" }, [
              ui("div", { key: `node-top-${n.id}`, class: "rich-node-header" }, [
                ui("span", { key: `node-title-${n.id}`, class: "rich-node-title" }, [n.title]),
                ui("span", { key: `node-status-${n.id}`, class: statusBadgeClass }, [n.status]),
              ]),
              ui("div", { key: `node-body-${n.id}`, class: "rich-node-body" }, [
                ui("span", { key: `node-hash-${n.id}` }, [`Hash: ${n.hash}`]),
                ui("span", { key: `node-metrics-${n.id}` }, [`Latency: ${n.latency} • Mem: ${n.memory}`]),
                ui("span", { key: `node-time-${n.id}` }, [`Updated: ${n.timeStr}`]),
                ui("div", { key: `node-track-${n.id}`, class: "meter-track" }, [
                  ui("div", {
                    key: `node-bar-${n.id}`,
                    class: n.load > 75 ? "meter-bar high" : "meter-bar",
                    style: `width: ${n.load}%;`,
                  }),
                ]),
              ]),
              ui(
                "button",
                {
                  key: `node-mutate-btn-${n.id}`,
                  class: "btn btn-sm",
                  style: "margin-top: 0.3rem; align-self: flex-end;",
                  onclick: () => mutateSingleNode(n.id),
                },
                ["Mutate Single"]
              ),
            ]);
          })
        ),
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

function renderApp() {
  const t0 = performance.now();
  totalRenderCycles++;

  let mainContent;
  if (activeTab.value === "showcase") {
    mainContent = ui("div", { key: "showcase-view" }, [
      ui("div", { key: "showcase-grid", class: "grid grid-2" }, [
        renderCounterCard(),
        renderTodoCard(),
      ]),
      renderArchitectureCard(),
    ]);
  } else if (activeTab.value === "benchmark") {
    mainContent = ui("div", { key: "bench-view" }, [renderBenchmarkCard()]);
  } else {
    mainContent = ui("div", { key: "tests-view" }, [renderTestSuiteCard()]);
  }

  const appEl = ui("div", { key: "main-app-container", class: "container" }, [
    renderHeader(),
    mainContent,
    ui("footer", { key: "app-footer" }, [
      ui("p", { key: "footer-text" }, [
        "Fried.js Library Tester • Pure Vanilla ES Modules • No Bundler Required"
      ]),
    ]),
  ]);

  lastRenderDurationMs = performance.now() - t0;
  return appEl;
}

// Mount the app into #app container
const mountTarget = document.getElementById("app");
if (mountTarget) {
  mount(renderApp, mountTarget);
} else {
  console.error("No #app mount element found!");
}
