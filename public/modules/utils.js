export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

export function sanitizeInput(str) {
    return str.replace(/[^a-zA-Z0-9 \-_]/g, '').trim();
}
