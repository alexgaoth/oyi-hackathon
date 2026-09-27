// Inline stroke icons (24x24 viewBox, currentColor). Static, trusted markup only.
const P = {
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  vault: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2"/>',
  ledger: '<path d="M3 10h18L12 4z"/><path d="M5.5 10v8M10 10v8M14 10v8M18.5 10v8M3 20.5h18"/>',
  brain:
    '<path d="M10.5 4.5a3 3 0 0 0-5 2 3 3 0 0 0-1.5 5 3 3 0 0 0 1.5 5 3 3 0 0 0 5 2.5z"/>' +
    '<path d="M13.5 4.5a3 3 0 0 1 5 2 3 3 0 0 1 1.5 5 3 3 0 0 1-1.5 5 3 3 0 0 1-5 2.5z"/>',
  contacts:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/>' +
    '<path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.8 3.2 8 7.5 9.5 4.3-1.5 7.5-4.7 7.5-9.5V6z"/><path d="m8.8 12 2.3 2.3 4.2-4.6"/>',
  alert: '<path d="M12 3.5 2.5 20.5h19z"/><path d="M12 10v5M12 17.6v.4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  bolt: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>',
};

export function icon(name, cls = 'icon') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
}
