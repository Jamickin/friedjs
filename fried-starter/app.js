import { mount, state, action, ui, css } from "./fried.js";
import { createDatabase } from "./fried-db.js";

// 1. Initialize Local Reactive Database (IndexedDB Backed)
const db = createDatabase("MyAwesomeApp", ["notes"]);
db.init();

// 2. Component Styles (Scoping via CSS-in-JS Engine)
const S = css({
  card: "background: var(--surface); padding: 1.5rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid var(--border);",
  title: "margin-top: 0; color: #38bdf8; font-weight: 600;",
  input: "padding: 0.6rem; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); margin-right: 0.5rem; width: 60%;",
  btn: "padding: 0.6rem 1rem; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;",
  btnDelete: "margin-left: 1rem; background: transparent; color: var(--danger); border: 1px solid var(--danger); cursor: pointer; border-radius: 4px; padding: 2px 8px;",
  listItem: "margin-bottom: 0.8rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;"
});

// 3. Local UI State
const newNoteText = state("");

// 4. Actions
const addNote = action("addNote", (e) => {
  e.preventDefault();
  if (!newNoteText.value.trim()) return;
  
  // Instantly writes to memory, triggers render, and flushes to IndexedDB in background
  db.collections.notes.insert({ 
    text: newNoteText.value, 
    date: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) 
  });
  
  newNoteText.value = ""; // clear input
});

// 5. Render Component
function renderApp() {
  const notes = db.collections.notes.value || [];

  return ui("div", { class: "app-wrapper" }, [
    ui("h1", {}, ["🍟 Fried.js Starter"]),
    ui("p", { style: "color: var(--text-muted); margin-bottom: 2rem;" }, [
      "A lightning-fast, zero-build framework for local-first apps."
    ]),

    ui("div", { class: S.card }, [
      ui("h2", { class: S.title }, ["My Notes"]),
      
      ui("form", { onsubmit: addNote, style: "margin-bottom: 1.5rem; display: flex;" }, [
        ui("input", { 
          class: S.input, 
          placeholder: "Write a note...", 
          value: newNoteText.value,
          oninput: (e) => newNoteText.value = e.target.value 
        }),
        ui("button", { type: "submit", class: S.btn }, ["Save Note"])
      ]),

      ui("ul", { style: "list-style: none; padding: 0; margin: 0;" }, 
        notes.length === 0 
          ? [ui("li", { style: "color: var(--text-muted); text-align: center; padding: 2rem;" }, ["No notes yet. Add one above!"])]
          : notes.map(note => ui("li", { key: note.id, class: S.listItem }, [
              ui("div", {}, [
                ui("span", { style: "color: var(--text-muted); font-size: 0.85rem; margin-right: 1rem;" }, [note.date]), 
                ui("span", {}, [note.text])
              ]),
              ui("button", { 
                class: S.btnDelete,
                onclick: () => db.collections.notes.remove(note.id) 
              }, ["Delete"])
            ]))
      )
    ])
  ]);
}

// 6. Mount to DOM
mount("app", renderApp);
