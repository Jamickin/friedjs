# 🍟 Fried.js Starter Template

Welcome to **Fried.js**, the 13KB, zero-build, POES fast web framework.

This template contains everything you need to start building local-first, lightning-fast web applications.

## Included Files
- `fried.js` - The core framework (VDOM, reactive state, CSS-in-JS). Exactly 200 lines of code.
- `fried-db.js` - A synchronous, in-memory reactive database backed by IndexedDB.
- `app.js` - Your main application logic. Open this file to start building!
- `index.html` - The minimal entry point.
- `server.js` - A tiny local server to serve your files.

## How to Run

1. Open your terminal in this folder.
2. Run the server:
   ```bash
   npm start
   ```
3. Open `http://localhost:3000` in your browser.

## Features

* **No Build Step**: It uses native ES modules. Just edit `app.js` and refresh your browser.
* **Instant Reactivity**: Use `state()` and `action()` to manage your data. 
* **Zero-Latency Database**: `fried-db.js` reads instantly from RAM and saves to disk in the background. No `await`, no loading spinners.
* **CSS-in-JS**: Use `css()` to generate scoped classes directly in your components.

---

*Built with speed, simplicity, and AI-readability in mind.*
