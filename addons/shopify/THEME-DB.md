# Theme AI Database

> **Instructions for the AI Agent:** 
> Shopify themes vary wildly. Before patching, use your tools to explore the theme and fill out this database. Treat this file as your permanent memory for this specific theme. When you learn how a layout works, note it here so you or other agents don't have to relearn it later.

## 1. Theme Architecture
- **Theme Name/Lineage:** (e.g., Dawn, Turbo, Custom)
- **Primary CSS Framework:** (e.g., Tailwind, custom utility classes, BEM)
- **Global CSS File(s):** (e.g., `assets/base.css`, `assets/theme.css`)

## 2. CSS Conventions & Utility Classes
*Note down the commonly used utility classes for this theme so you can use them in your patches.*
- **Margins/Padding:** (e.g., `page-width`, `margin-top-1rem`)
- **Grid/Flexbox:** (e.g., `grid grid--1-col grid--2-col-tablet`)
- **Typography:** (e.g., `h1`, `h2`, `body`, `caption-with-letter-spacing`)
- **Hidden/Mobile:** (e.g., `small-hide`, `medium-hide`, `large-up-hide`)

## 3. Important Snippets
*List the commonly reused snippets and their purpose (e.g., price rendering, icons, product cards).*
- `{% render 'icon-cart' %}`: Renders the standard SVG cart icon.
- `[Add snippet...]`: [Description]

## 4. JS & State Management
*How does this theme handle cart state or interactions?*
- (e.g., Web Components, Alpine.js, Vanilla JS with global `theme` object)

## 5. Agent Learnings & Gotchas
*Add any mistakes you made during testing here so you don't repeat them. What breaks the schema? What tags behave unexpectedly?*
- 
