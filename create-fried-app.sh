#!/bin/bash

# ==============================================================================
# 🍟 Fried.js Quick-Start Interactive Installer
# Usage: ./create-fried-app.sh [project-name]
# ==============================================================================

PROJECT_NAME=${1:-"my-fried-app"}

echo "🚀 Creating new Fried.js app in $PROJECT_NAME..."
mkdir -p "$PROJECT_NAME/addons" "$PROJECT_NAME/tooling"
cd "$PROJECT_NAME"

echo ""
echo "📦 Customize your framework:"
read -p "Include local IndexedDB Database? (y/n): " INC_DB
read -p "Include Virtual Scroller (for 100k+ lists)? (y/n): " INC_VIRTUAL
read -p "Include Hash Router? (y/n): " INC_ROUTER
read -p "Include AI Patcher tooling? (y/n): " INC_AI
echo ""

echo "📄 Generating index.html..."
cat << 'HTMLEOF' > index.html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fried.js App</title>
  <style>body { font-family: system-ui, sans-serif; padding: 2rem; background: #0f172a; color: #f8fafc; line-height: 1.6; } button { padding: 8px 16px; margin: 4px; cursor: pointer; background: #3b82f6; color: white; border: none; border-radius: 4px; } button:hover { background: #2563eb; } a { color: #60a5fa; text-decoration: none; margin-right: 12px; font-weight: bold; } a:hover { text-decoration: underline; }</style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./app.js"></script>
</body>
</html>
HTMLEOF

echo "📄 Generating app.js..."

# Start building app.js based on selections
echo 'import { mount, state, action, ui } from "./fried.js";' > app.js

if [[ "$INC_ROUTER" =~ ^[Yy]$ ]]; then
    echo 'import { router, navigate, currentRoute } from "./addons/fried-router.js";' >> app.js
fi
if [[ "$INC_DB" =~ ^[Yy]$ ]]; then
    echo 'import { createDatabase } from "./addons/fried-db.js";' >> app.js
fi

cat << 'APP_EOF' >> app.js

const count = state(0);
const increment = action("increment", () => { count.value++; });

APP_EOF

if [[ "$INC_DB" =~ ^[Yy]$ ]]; then
cat << 'APP_EOF' >> app.js
// Example DB setup
const db = createDatabase("FriedAppDB", ["users"]);
const users = db.collection("users");
const addUser = action("addUser", () => { 
  users.insert({ id: Date.now().toString(), name: "User " + Math.floor(Math.random() * 100) });
});
APP_EOF
fi

if [[ "$INC_ROUTER" =~ ^[Yy]$ ]]; then
cat << 'APP_EOF' >> app.js
// Setup Routes
const routes = {
  "/": () => ui("div", { key: "home" }, [
    ui("h2", { key: "title" }, "🏠 Home Page"),
    ui("p", { key: "desc" }, "Welcome to your new SPA!"),
    ui("button", { key: "btn", onclick: increment }, `Counter: ${count.value}`),
  ]),
  "/about": () => ui("div", { key: "about" }, [
    ui("h2", { key: "title" }, "📖 About Page"),
    ui("p", { key: "desc" }, "This page was rendered perfectly without hitting a server.")
  ]),
  "*": () => ui("div", { key: "404" }, "404 - Not Found")
};

mount(() => {
  return ui("div", { key: "root" }, [
    ui("h1", { key: "title" }, "Fried.js 🍟"),
    ui("nav", { key: "nav", style: "margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #334155;" }, [
      ui("a", { key: "link-home", href: "#/", onclick: (e) => { e.preventDefault(); navigate("/"); } }, "Home"),
      ui("a", { key: "link-about", href: "#/about", onclick: (e) => { e.preventDefault(); navigate("/about"); } }, "About")
    ]),
    router(routes)
  ]);
}, document.getElementById("app"));
APP_EOF
else
cat << 'APP_EOF' >> app.js
mount(() => {
  return ui("div", { key: "root" }, [
    ui("h1", { key: "title" }, "Welcome to Fried.js 🍟"),
    ui("button", { key: "btn", onclick: increment }, `Count: ${count.value}`)
  ]);
}, document.getElementById("app"));
APP_EOF
fi

echo "📥 Fetching core framework from GitHub..."
curl -sL "https://raw.githubusercontent.com/Jamickin/friedjs/main/fried.js" -o fried.js

if [[ "$INC_DB" =~ ^[Yy]$ ]]; then
    echo "➕ Downloading Database module..."
    curl -sL "https://raw.githubusercontent.com/Jamickin/friedjs/main/addons/fried-db.js" -o addons/fried-db.js
fi

if [[ "$INC_VIRTUAL" =~ ^[Yy]$ ]]; then
    echo "➕ Downloading Virtual Scroller module..."
    curl -sL "https://raw.githubusercontent.com/Jamickin/friedjs/main/addons/fried-virtual.js" -o addons/fried-virtual.js
fi

if [[ "$INC_ROUTER" =~ ^[Yy]$ ]]; then
    echo "➕ Downloading Hash Router module..."
    curl -sL "https://raw.githubusercontent.com/Jamickin/friedjs/main/addons/fried-router.js" -o addons/fried-router.js
fi

if [[ "$INC_AI" =~ ^[Yy]$ ]]; then
    echo "➕ Downloading AI Tooling..."
    curl -sL "https://raw.githubusercontent.com/Jamickin/friedjs/main/patcher.js" -o tooling/patcher.js
    
    echo "📄 Generating AI_INSTRUCTIONS.md..."
    cat << 'AI_EOF' > AI_INSTRUCTIONS.md
# Fried.js AI Instructions

You are working in **Fried.js**, a zero-build-step, Virtual-DOM UI framework. 

## 1. Core Architecture
- **No React/Svelte/JSX**: Use raw JS.
- **UI**: Return plain objects via `ui(tag, props, children)`.
- **State**: `const val = state(initial);` (Read/write via `val.value`).
- **Actions**: Wrap state mutations in `action("name", () => { ... })`.
- **CSS**: Co-locate using `const styles = css({ title: "color: red;" })`.

## 2. Modifying Code (CRITICAL)
- **Do NOT overwrite entire files** for UI changes.
- You MUST use `tooling/patcher.js` to modify AST safely.
- **Patcher Ops**: `setProp`, `setChildText`, `addChild`, `addStatementAfter`, `removeChild`, `replaceChild`, `removeStatement`, `renameSymbol`.
- Keys must be absolutely unique among siblings.
AI_EOF
fi

# Clean up empty directories if modules weren't included
rmdir addons 2>/dev/null
rmdir tooling 2>/dev/null

echo ""
echo "✅ Done! Your app is ready."
echo "cd $PROJECT_NAME"
echo "npx serve .  (or python3 -m http.server 8080)"
