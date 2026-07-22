// Minimal, consistent line-icon set (24x24 viewBox, currentColor stroke)
// used everywhere instead of emoji. Usage: Icon.svg('heart', 20)
const Icon = {
  paths: {
    home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/>',
    chat: '<path d="M4 5h16v11H8l-4 4V5Z"/>',
    plusCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    heart: '<path d="M12 20.5s-7.5-4.6-9.6-9.4C.9 7.4 3 4 6.6 4c2 0 3.5 1.1 4.4 2.6C11.9 5.1 13.4 4 15.4 4 19 4 21.1 7.4 19.6 11.1 17.5 15.9 12 20.5 12 20.5Z"/>',
    heartFilled: '<path d="M12 20.5s-7.5-4.6-9.6-9.4C.9 7.4 3 4 6.6 4c2 0 3.5 1.1 4.4 2.6C11.9 5.1 13.4 4 15.4 4 19 4 21.1 7.4 19.6 11.1 17.5 15.9 12 20.5 12 20.5Z" fill="currentColor"/>',
    comment: '<path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12h5" stroke-width="1.6"/>',
    share: '<path d="M6 12 20 5 14 19l-2.5-6L6 12Z"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 19h16"/>',
    plusUser: '<circle cx="10" cy="8" r="3.5"/><path d="M3 20a6.5 6.5 0 0 1 12.6-2.3"/><path d="M18 11v6M15 14h6"/>',
    bell: '<path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.3-4.3"/>',
    group: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2.5 19c.7-3 3-5 5.5-5s4.8 2 5.5 5"/><path d="M11 19c.7-2.6 2.7-4.4 5-4.4S20.3 16.4 21 19"/>',
    paperclip: '<path d="M17 8.5 9.5 16a3 3 0 1 1-4.2-4.2L14 3.1a2 2 0 1 1 2.8 2.8L8.6 14"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
    send: '<path d="m4 12 16-8-6 16-2.5-6.5L4 12Z"/>',
    doc: '<path d="M7 3h7l4 4v14H7Z"/><path d="M14 3v4h4"/>',
    play: '<path d="M8 5.5v13l11-6.5-11-6.5Z"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    back: '<path d="m14.5 5-7 7 7 7"/>',
    camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7 9.5 4h5L16 7"/><circle cx="12" cy="13.5" r="3.5"/>',
    flip: '<path d="M17 2.1 21 6l-4 3.9M3 12a9 9 0 0 1 15-6.7L21 6M7 21.9 3 18l4-3.9M21 12a9 9 0 0 1-15 6.7L3 18"/>',
    text: '<path d="M5 5h14M12 5v14"/>',
    emoji: '<circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01M15.5 10h.01"/><path d="M8 15c1 1.3 2.4 2 4 2s3-.7 4-2"/>',
    install: '<path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 19h16"/>',
    edit: '<path d="m15 4 5 5-11 11H4v-5Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" stroke-width="1.6"/><circle cx="12" cy="12" r="2.5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
  },
  svg(name, size = 22, strokeWidth = 1.8) {
    const inner = this.paths[name] || this.paths.x;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  },
};
