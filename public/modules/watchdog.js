/**
 * watchdog.js — Safety Net for Stalled Extractions
 * 
 * Monitors the batch for "stragglers" — receipts that uploaded successfully ('synced')
 * but haven't been extracted ('extracted') within a reasonable time (e.g., 45s).
 * This handles Cloud Function cold starts, timeouts, or transient gRPC errors.
 * 
 * Strategy:
 * 1. Poll every 10s.
 * 2. Find items in 'synced' state for > 45s.
 * 3. Flip status to 'pending_retry' (Triggering Cloud Function).
 * 4. Cap retries to 3 per item.
 */

import { db } from './firebase-init.js';
import { state } from './state.js';
import { showToast } from './ui.js';

const CHECK_INTERVAL_MS = 10000; // Check every 10s
const STALL_THRESHOLD_MS = 45000; // 45s timeout for extraction
const MAX_RETRIES = 3;

let watchdogTimer = null;

export function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(checkStragglers, CHECK_INTERVAL_MS);
    console.log('[Watchdog] Started monitoring for stalled extractions 🐕');
}

export function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
}

async function checkStragglers() {
    if (!state.batchId || !state.currentUser) return;

    try {
        const now = Date.now();
        const batchRef = db.collection('batches').doc(state.batchId).collection('receipts');

        // Query for items that might be stuck
        // Note: We scan all 'synced' items in memory or query specific ones.
        // For efficiency, we can just query 'synced' from Firestore if the list is huge,
        // but since we have a listener in main.js, we *could* check local state?
        // Actually, let's query Firestore to be the source of truth.

        const snapshot = await batchRef
            .where('status', '==', 'synced')
            .where('ownerId', '==', state.currentUser.uid)
            .get();

        if (snapshot.empty) return;

        const updates = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            const uploadedAt = data.uploadedAt?.toMillis() || 0;
            const retryCount = data.retryCount || 0;

            // If it's been 'synced' for > 45s and not yet extracted
            if (uploadedAt > 0 && (now - uploadedAt) > STALL_THRESHOLD_MS) {
                if (retryCount < MAX_RETRIES) {
                    console.warn(`[Watchdog] Found straggler: ${doc.id} (${Math.round((now - uploadedAt) / 1000)}s)`);
                    updates.push(
                        doc.ref.update({
                            status: 'pending_retry',
                            retryCount: retryCount + 1,
                            lastRetryAt: firebase.firestore.FieldValue.serverTimestamp()
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
        console.error('[Watchdog] Check failed:', err);
    }
}
