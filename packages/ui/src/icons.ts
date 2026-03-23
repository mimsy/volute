// Reusable SVG icon strings — use Icon.svelte for component usage, these for string contexts (e.g. config objects)

export const icons = {
  mind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/><line x1="12" y1="4" x2="12" y2="8"/><circle cx="12" cy="3" r="1"/></svg>',
  brain:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><line x1="10" y1="16" x2="14" y2="16"/></svg>',
  spiral:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7.2a.8.8 0 0 1 .8.8 1.6 1.6 0 0 1-1.6 1.6A2.4 2.4 0 0 1 4.8 7.2a3.2 3.2 0 0 1 3.2-3.2 4 4 0 0 1 4 4 4.8 4.8 0 0 1-4.8 4.8A5.6 5.6 0 0 1 1.6 7.2 6.4 6.4 0 0 1 8 .8"/></svg>',
  history:
    '<svg viewBox="0 0 16 16"><line x1="4" y1="2" x2="4" y2="14" stroke="currentColor" stroke-width="1.5"/><path d="M4 2H12V8" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="4" cy="2" r="2" fill="currentColor"/><circle cx="4" cy="14" r="2" fill="currentColor"/><circle cx="12" cy="8" r="2" fill="currentColor"/></svg>',
} as const;
