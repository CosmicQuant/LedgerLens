export function uid() {
    // crypto.randomUUID() is collision-resistant (122 bits of entropy)
    // Supported in all modern browsers (Chrome 92+, Safari 15.4+, Firefox 95+)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback for very old browsers
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

export function sanitizeInput(str) {
    return str.replace(/[^a-zA-Z0-9 \-_]/g, '').trim();
}

/** Escape HTML entities to prevent XSS when inserting into innerHTML */
export function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
