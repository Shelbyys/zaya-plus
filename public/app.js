// ===========================================
// app.js — Minimal stub
// The full voice assistant lives in index.html.
// This file only exists so Electron's inject
// script can call startZaya() without errors.
// ===========================================

window.startZaya = window.startZaya || function() {
  console.log('[app.js] startZaya() called — no-op, index.html owns the voice system.');
};

console.log('[app.js] Stub loaded (no voice loops, no SpeechRecognition).');
