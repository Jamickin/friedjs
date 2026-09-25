import fs from 'fs';
import { setAttr, addChild } from './shopify-patcher.js';

let code = fs.readFileSync('sections/header.liquid', 'utf8');

// Test 1: Add a class to the nav
code = setAttr(code, 'header-3', 'class', 'navigation mobile-hidden');

// Test 2: Add a new child to the ul
code = addChild(code, 'header-4', '<li><a href="/sale">Sale</a></li>');

fs.writeFileSync('sections/header-patched.liquid', code);
console.log('Patched file written to sections/header-patched.liquid');

// Test 3: Replace logo div content
let code2 = fs.readFileSync('sections/header-patched.liquid', 'utf8');
import { setChildText } from './shopify-patcher.js';
code2 = setChildText(code2, 'header-2', '\n    <h1>STORE NAME</h1>\n  ');
fs.writeFileSync('sections/header-patched.liquid', code2);
