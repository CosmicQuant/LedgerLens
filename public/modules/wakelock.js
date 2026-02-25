/**
 * wakelock.js — Centralized Wake Lock Manager
 * 
 * Prevents dual wake lock conflicts between camera.js and uploader.js.
 * Uses a reference counter: lock is held as long as at least one consumer needs it.
 */

let wakeLock = null;
let holders = new Set();

export async function acquireWakeLock(holder) {
    holders.add(holder);
    if (wakeLock) return; // Already held

    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
            console.log('[WakeLock] Released by OS');
        });
        console.log(`[WakeLock] Acquired (holders: ${[...holders].join(', ')})`);
    } catch (e) {
        console.warn('[WakeLock] Failed:', e.message);
    }
}

export function releaseWakeLock(holder) {
    holders.delete(holder);
    if (holders.size === 0 && wakeLock) {
        wakeLock.release();
        wakeLock = null;
        console.log('[WakeLock] Released (no holders)');
    }
}

/** Re-acquire if OS released it while we still have holders */
export async function reacquireIfNeeded() {
    if (holders.size > 0 && !wakeLock) {
        await acquireWakeLock([...holders][0]);
    }
}
