// addons/server/fried-tools.js: declarative tool registries for Node servers.
//
// One declaration `{ name, description, input, run }` serves four surfaces:
//   1. HTTP `GET /api/tools`  (createToolHttpHandlers().handleList)
//   2. HTTP `POST /api/call`  (createToolHttpHandlers().handleCall)
//   3. stdio MCP JSON-RPC     (createMcpStdioServer, a stateless shim that
//                              forwards tools/list and tools/call over HTTP)
//   4. generated docs         (registry.toMarkdown())
//
// Tools are role-scoped (e.g. "master" / "musician"), may be wrapped per
// caller (rate limits, per-task context), and can be swapped at runtime with
// register() / unregister() / replace() without recreating the HTTP handlers
// or restarting the server. Node built-ins only, zero dependencies.
//
// Options of createToolRegistry(name, tools, options):
//   wrapForCaller(tools, role, caller)  wrap each caller's tool set (rate
//                                       limits, per-task context).
//   fallbackRole: "musician"            a role with no tools of its own (not
//                                       in the role map) gets this role's
//                                       tools in forRole/listForRole/call
//                                       instead of none. The caller keeps its
//                                       own role; wrapForCaller is given the
//                                       fallback role. It must name a role
//                                       that has tools, or createToolRegistry
//                                       (and replace()) throw. Without it,
//                                       unknown roles get only shared tools.

import { StringDecoder } from "node:string_decoder";

// ---------------------------------------------------------------------------
// JSON-schema helpers

/** @param {string} description */
export const str = (description) => ({ type: "string", description });
/** @param {string} description */
export const num = (description) => ({ type: "number", description });
/** @param {string} description */
export const bool = (description) => ({ type: "boolean", description });
/** @param {string} description @param {Record<string, any>} [items] */
export const arr = (description, items = { type: "string" }) => ({ type: "array", items, description });
/** @param {Record<string, any>} properties @param {string[]} [required] */
export const obj = (properties, required = []) => ({ type: "object", properties, required });

// ---------------------------------------------------------------------------
// Registry

/**
 * @typedef {{
 *   name?: string,
 *   description: string,
 *   input?: Record<string, any>,
 *   roles?: string[],
 *   run: (args: any, caller: any) => Promise<any> | any,
 * }} ToolDef
 */

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isToolLike = (v) => isPlainObject(v) && (typeof v.run === "function" || typeof v.description === "string");

function checkDef(registryName, toolName, def) {
  if (typeof toolName !== "string" || !toolName) {
    throw new TypeError(`fried-tools(${registryName}): tool name must be a non-empty string`);
  }
  if (!isPlainObject(def)) throw new TypeError(`fried-tools(${registryName}): tool "${toolName}" must be an object`);
  if (typeof def.run !== "function") throw new TypeError(`fried-tools(${registryName}): tool "${toolName}" needs a run(args, caller) function`);
  if (typeof def.description !== "string") throw new TypeError(`fried-tools(${registryName}): tool "${toolName}" needs a string description`);
  if (def.input !== undefined && !isPlainObject(def.input)) {
    throw new TypeError(`fried-tools(${registryName}): tool "${toolName}" input must be a JSON-schema object`);
  }
  if (def.roles !== undefined && !(Array.isArray(def.roles) && def.roles.every((r) => typeof r === "string" && r))) {
    throw new TypeError(`fried-tools(${registryName}): tool "${toolName}" roles must be an array of role names`);
  }
  const { name: _ignored, ...rest } = def;
  return { ...rest, input: def.input ?? obj({}) };
}

/**
 * Parse either accepted shape into `{ byRole, shared }`:
 *  - role map: `{ master: { tool: def }, musician: { tool: def } }`
 *  - flat map: `{ tool: { ..., roles?: [...] } }` or `[{ name, ..., roles? }]`
 * Tools in the flat shape without `roles` are shared by every role.
 */
function parseTools(registryName, tools) {
  /** @type {Map<string, Map<string, any>>} */
  const byRole = new Map();
  /** @type {Map<string, any>} */
  const shared = new Map();
  const put = (toolName, def) => {
    const d = checkDef(registryName, toolName, def);
    if (d.roles) {
      for (const r of d.roles) {
        if (!byRole.has(r)) byRole.set(r, new Map());
        byRole.get(r).set(toolName, d);
      }
    } else shared.set(toolName, d);
  };

  if (tools == null) return { byRole, shared };
  if (Array.isArray(tools)) {
    for (const def of tools) put(def?.name, def);
    return { byRole, shared };
  }
  if (!isPlainObject(tools)) throw new TypeError(`fried-tools(${registryName}): tools must be an object or an array`);

  const values = Object.values(tools);
  const roleMap = values.length > 0 && values.every((v) => isPlainObject(v) && !isToolLike(v));
  if (!roleMap) {
    for (const [toolName, def] of Object.entries(tools)) put(toolName, def);
    return { byRole, shared };
  }
  for (const [role, set] of Object.entries(tools)) {
    const m = new Map();
    for (const [toolName, def] of Object.entries(set)) m.set(toolName, checkDef(registryName, toolName, def));
    byRole.set(role, m);
  }
  return { byRole, shared };
}

/**
 * Normalise the second argument of forRole()/call(): a caller object
 * (`{ role, ... }`) is used as-is, a task-like object (has `id`, no `role`)
 * becomes `{ role, task }`, anything else becomes `{ role }`.
 */
function normaliseCaller(role, taskOrCaller) {
  if (isPlainObject(taskOrCaller)) {
    if ("role" in taskOrCaller) return taskOrCaller;
    if ("id" in taskOrCaller) return { role, task: taskOrCaller };
  }
  return { role };
}

/**
 * Create a role-scoped tool registry.
 * @param {string} name
 * @param {Record<string, ToolDef> | Record<string, Record<string, ToolDef>> | Array<ToolDef & { name: string }>} tools
 * @param {{
 *   wrapForCaller?: (tools: Record<string, ToolDef>, role: string, caller: any) => Record<string, ToolDef>,
 *   fallbackRole?: string,
 * }} [options]
 */
export function createToolRegistry(name, tools, options = {}) {
  const registryName = String(name || "tools");
  const { wrapForCaller, fallbackRole } = options;
  if (fallbackRole !== undefined && (typeof fallbackRole !== "string" || !fallbackRole)) {
    throw new TypeError(`fried-tools(${registryName}): fallbackRole must be a non-empty role name`);
  }
  const checkFallback = (parsed) => {
    if (fallbackRole !== undefined && !parsed.byRole.has(fallbackRole)) {
      const known = [...parsed.byRole.keys()].join(", ") || "none";
      throw new TypeError(`fried-tools(${registryName}): fallbackRole "${fallbackRole}" is not a role in this registry (roles: ${known})`);
    }
    return parsed;
  };
  let current = checkFallback(parseTools(registryName, tools));

  /** The role whose tools `role` gets: itself if it has its own, else fallbackRole. */
  const resolveRole = (role) => (fallbackRole !== undefined && !current.byRole.has(role) ? fallbackRole : role);

  const rawForRole = (role) => {
    const out = {};
    for (const [n, d] of current.shared) out[n] = d;
    const own = current.byRole.get(role);
    if (own) for (const [n, d] of own) out[n] = d;
    return out;
  };

  /**
   * The tools a role may use. Each returned tool's run(args, explicitCaller)
   * defaults its second argument to the caller given here.
   * @param {string} role
   * @param {any} [taskOrCaller] a caller `{ role, ... }` or a task `{ id, ... }`
   * @returns {Record<string, ToolDef>}
   */
  function forRole(role, taskOrCaller) {
    const caller = normaliseCaller(role, taskOrCaller);
    const effective = resolveRole(role);
    let set = rawForRole(effective);
    if (typeof wrapForCaller === "function") set = wrapForCaller(set, effective, caller) || set;
    const out = {};
    for (const [n, t] of Object.entries(set)) {
      if (!t || typeof t.run !== "function") continue;
      const run = t.run;
      out[n] = { ...t, run: (args, explicitCaller) => run(args, explicitCaller ?? caller) };
    }
    return out;
  }

  /** @param {string} role @param {any} [caller] */
  function listForRole(role, caller) {
    return Object.entries(forRole(role, caller)).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.input }));
  }

  /**
   * Run a tool as `role`. Throws an Error with `status: 404` if the role has no such tool.
   * @param {string} role @param {string} toolName @param {any} [args] @param {any} [caller]
   */
  async function call(role, toolName, args, caller) {
    const set = forRole(role, caller);
    const t = typeof toolName === "string" && Object.hasOwn(set, toolName) ? set[toolName] : null;
    if (!t) {
      const err = new Error(`no tool "${toolName}" for role ${role}`);
      Object.assign(err, { status: 404, code: "ENOTOOL" });
      throw err;
    }
    return await t.run(args || {}, normaliseCaller(role, caller));
  }

  /**
   * Add or update one tool in place. With `role`, it goes to that role; with
   * `def.roles`, to each listed role; otherwise an existing tool of that name
   * is updated wherever it already is, and a new one is shared by all roles.
   * @param {string} toolName @param {ToolDef} def @param {string} [role]
   */
  function register(toolName, def, role) {
    const d = checkDef(registryName, toolName, def);
    const next = { byRole: new Map([...current.byRole].map(([r, m]) => [r, new Map(m)])), shared: new Map(current.shared) };
    const into = (r) => {
      if (!next.byRole.has(r)) next.byRole.set(r, new Map());
      next.byRole.get(r).set(toolName, d);
    };
    if (role) into(role);
    else if (d.roles) d.roles.forEach(into);
    else {
      let found = next.shared.has(toolName);
      if (found) next.shared.set(toolName, d);
      for (const m of next.byRole.values()) if (m.has(toolName)) { m.set(toolName, d); found = true; }
      if (!found) next.shared.set(toolName, d);
    }
    current = next;
  }

  /**
   * Remove a tool from one role (or from everywhere). Returns true if anything was removed.
   * @param {string} toolName @param {string} [role]
   */
  function unregister(toolName, role) {
    const next = { byRole: new Map([...current.byRole].map(([r, m]) => [r, new Map(m)])), shared: new Map(current.shared) };
    let removed = false;
    if (role) removed = next.byRole.get(role)?.delete(toolName) ?? false;
    else {
      removed = next.shared.delete(toolName);
      for (const m of next.byRole.values()) removed = m.delete(toolName) || removed;
    }
    current = next;
    return removed;
  }

  /**
   * Swap every tool at once (validated before the swap). The registry object
   * itself, and everything holding it, stays the same.
   * @param {Record<string, any> | Array<ToolDef & { name: string }>} newTools
   */
  function replace(newTools) {
    current = checkFallback(parseTools(registryName, newTools));
  }

  /** Role names that have their own tools (shared-only registries have none). */
  function roles() {
    return [...current.byRole.keys()];
  }

  /** Deterministic markdown reference, one section per role. */
  function toMarkdown() {
    const lines = [`# ${registryName} tools`, ""];
    const sections = current.byRole.size ? roles().map((r) => [r, rawForRole(r)]) : [["all roles", rawForRole("")]];
    for (const [role, set] of sections) {
      lines.push(`### ${role}`, "");
      const entries = Object.entries(set);
      if (!entries.length) lines.push("_(no tools)_");
      for (const [n, t] of entries) {
        lines.push(`- \`${n}\`: ${oneLine(t.description)}`);
        const props = t.input?.properties || {};
        const required = new Set(t.input?.required || []);
        for (const [p, s] of Object.entries(props)) {
          const type = s?.type ? (s.type === "array" && s.items?.type ? `${s.items.type}[]` : String(s.type)) : "any";
          const desc = s?.description ? `: ${oneLine(s.description)}` : "";
          lines.push(`  - \`${p}\` (${type}${required.has(p) ? ", required" : ""})${desc}`);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  return { name: registryName, forRole, listForRole, call, register, unregister, replace, roles, toMarkdown };
}

const oneLine = (s) => String(s ?? "").replace(/\s*\n\s*/g, " ").trim();

// ---------------------------------------------------------------------------
// HTTP handlers

/**
 * Route handlers for `GET /api/tools` and `POST /api/call`. They read the
 * registry on every request, so register()/replace() take effect at once.
 * `ctx.send(code, data)` matches fried-serve's route context.
 * @param {ReturnType<typeof createToolRegistry>} registry
 */
export function createToolHttpHandlers(registry) {
  return {
    /** @param {{ who: any, send: (code: number, data: any) => void }} ctx */
    handleList({ who, send }) {
      if (!who) return send(401, { error: "unauthorized" });
      try {
        return send(200, { role: who.role, tools: registry.listForRole(who.role, who) });
      } catch (e) {
        return send(400, { error: e?.message || String(e) });
      }
    },
    /** @param {{ who: any, body: any, send: (code: number, data: any) => void }} ctx */
    async handleCall({ who, body, send }) {
      if (!who) return send(401, { error: "unauthorized" });
      try {
        const payload = (typeof body === "function" ? await body() : body) || {};
        const result = await registry.call(who.role, payload.tool, payload.args || {}, who);
        return send(200, { result });
      } catch (e) {
        return send(e?.code === "ENOTOOL" ? 404 : 400, { error: e?.message || String(e) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// stdio MCP server (JSON-RPC 2.0, newline-delimited)

/**
 * A stateless MCP server over stdio that asks an HTTP server which tools this
 * token may use (`tools/list` -> GET listPath) and forwards each call
 * (`tools/call` -> POST callPath). Holds no tool logic of its own.
 * @param {{
 *   url: string,
 *   token?: string | (() => string),
 *   serverInfo?: { name: string, version: string },
 *   instructions?: string,
 *   downMessage?: string,
 *   httpErrorMessage?: (status: number) => string,
 *   listPath?: string,
 *   callPath?: string,
 *   stdin?: NodeJS.ReadableStream | null,
 *   stdout?: NodeJS.WritableStream,
 *   fetchImpl?: typeof fetch,
 *   onEnd?: () => void,
 * }} options
 * @returns {{ handleMessage: (msg: any) => Promise<void>, close: () => void }}
 */
export function createMcpStdioServer(options) {
  const {
    url,
    token = "",
    serverInfo = { name: "fried-tools", version: "0.1.0" },
    instructions,
    downMessage = `The tool server is not reachable at ${url}.`,
    httpErrorMessage = (status) => `server returned ${status}`,
    listPath = "/api/tools",
    callPath = "/api/call",
    stdin = process.stdin,
    stdout = process.stdout,
    fetchImpl = globalThis.fetch,
    onEnd,
  } = options || {};
  if (typeof url !== "string" || !url) throw new TypeError("createMcpStdioServer: url is required");

  const base = url.replace(/\/+$/, "");
  const write = (msg) => { stdout.write(JSON.stringify(msg) + "\n"); };
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  async function api(path, init = {}) {
    const bearer = typeof token === "function" ? token() : token;
    let res;
    try {
      res = await fetchImpl(base + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${bearer || ""}` } });
    } catch {
      throw new Error(downMessage);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || httpErrorMessage(res.status));
    return j;
  }

  /** Handle one parsed JSON-RPC message; writes at most one response line. */
  async function handleMessage(msg) {
    if (!isPlainObject(msg)) return fail(null, -32600, "invalid request");
    const { id, method, params } = msg;
    if (id === undefined) return; // notification (initialized, cancelled, ...)
    try {
      if (method === "initialize") {
        return reply(id, {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo,
          ...(instructions !== undefined && { instructions }),
        });
      }
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") {
        try {
          const { tools } = await api(listPath);
          return reply(id, { tools: Array.isArray(tools) ? tools : [] });
        } catch (e) {
          // Still expose one tool so the agent can see why nothing works.
          return reply(id, { tools: [{ name: "composer_status", description: e.message, inputSchema: { type: "object", properties: {} } }] });
        }
      }
      if (method === "tools/call") {
        try {
          const { result } = await api(callPath, { method: "POST", body: JSON.stringify({ tool: params?.name, args: params?.arguments || {} }) });
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] });
        } catch (e) {
          return reply(id, { content: [{ type: "text", text: e.message }], isError: true });
        }
      }
      if (method === "resources/list") return reply(id, { resources: [] });
      if (method === "prompts/list") return reply(id, { prompts: [] });
      return fail(id, -32601, "method not found: " + method);
    } catch (e) {
      return fail(id, -32603, e?.message || String(e));
    }
  }

  let buf = "";
  const decoder = new StringDecoder("utf8");
  const onData = (chunk) => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(null, -32700, "parse error");
        continue;
      }
      handleMessage(msg).catch(() => {});
    }
  };
  const onStreamEnd = () => { if (typeof onEnd === "function") onEnd(); };

  if (stdin) {
    stdin.on("data", onData);
    stdin.on("end", onStreamEnd);
  }

  return {
    handleMessage,
    close() {
      if (!stdin) return;
      stdin.off("data", onData);
      stdin.off("end", onStreamEnd);
    },
  };
}
