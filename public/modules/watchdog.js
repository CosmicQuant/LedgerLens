/**
 * watchdog.js — Safety Net for Stalled Extractions
 * 
 * Monitors the batch for "stragglers" — receipts that uploaded successfully ('synced')
 * but haven't been extracted within a reasonable time (45s).
 * This handles Cloud Function cold starts, timeouts, or transient gRPC errors.
 * 
 * Strategy:
 * 1. Poll every 15s (not too aggressive on mobile battery).
 * 2. Find items in 'synced' state for > 45s.
 * 3. Flip status to 'pending_retry' → triggers Cloud Function.
 * 4. Cap retries to 3 per item.
 */

import { db } from './firebase-init.js';
import { state } from './state.js';
import { showToast } from './ui.js';

const CHECK_INTERVAL_MS = 15000; // Check every 15s
const STALL_THRESHOLD_MS = 45000; // 45s timeout for extraction
const MAX_RETRIES = 3;

let watchdogTimer = null;

export function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(checkStragglers, CHECK_INTERVAL_MS);
    console.log('[Watchdog] Started monitoring for stalled extractions 🐕');
}

export function stopWatchdog() {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

async function checkStragglers() {
    if (!state.batchId || !state.currentUser) return;

    try {
        const now = Date.now();
        const batchRef = db.collection('batches').doc(state.batchId).collection('receipts');

        // Query ONLY by status (ownerId lives on the batch parent, not on receipts)
        const snapshot = await batchRef
            .where('status', '==', 'synced')
            .get();

        if (snapshot.empty) return;

        const updates = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            const uploadedAt = data.uploadedAt?.toMillis?.() || 0;
            const retryCount = data.retryCount || 0;

            // If it's been 'synced' for > 45s and not yet extracted
            if (uploadedAt > 0 && (now - uploadedAt) > STALL_THRESHOLD_MS) {
                if (retryCount < MAX_RETRIES) {
                    console.warn(`[Watchdog] Found straggler: ${doc.id} (${Math.round((now - uploadedAt) / 1000)}s)`);
                    updates.push(
                        doc.ref.update({
                            status: 'pending_retry',
                            retryCount: retryCount + 1,
                            lastRetryAt: new Date().toISOString()
                        })
                    );
                } else {
                    console.warn(`[Watchdog] Giving up on ${doc.id} after ${MAX_RETRIES} retries.`);
                    updates.push(
                        doc.ref.update({
                            status: 'error',
                            error_message: 'Extraction timed out after multiple retries.'
                        })
                    );
                }
            }
        });

        if (updates.length > 0) {
            await Promise.all(updates);
            showToast(`Retrying ${updates.length} stalled items...`, 'info');
        }

    } catch (err) {
        // Silently ignore — watchdog is non-critical, must never crash the app
        console.warn('[Watchdog] Check failed:', err.message);
    }
}
