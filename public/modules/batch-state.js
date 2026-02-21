/**
 * BatchStateManager — Single Source of Truth for batch counters.
 *
 * Instead of scattering snapCounter++ across handlers, this module
 * provides real counts from IDB + Firestore, a pub-sub for UI,
 * and usage-meter color zone logic.
 */

import { getIDB, getBatchCounts } from './db.js';
import { state } from './state.js';

const BATCH_LIMIT = 100;
const ZONE_WARNING = 90;  // Orange at 90+

class BatchStateManager {
    constructor() {
        this._batchId = '';
        this._firestore = null;
        this.localCount = 0;
        this.cloudCount = 0;
        this.pendingCount = 0;
        this.totalCount = 0;
        this.ghostCount = 0; // Tracks items in memory before IDB save

        this.subscribers = new Set();
        this._recalculating = false;
    }

    /** Bind to the current batch + Firestore instance */
    init(batchId, firestoreDb) {
        this._batchId = batchId;
        this._firestore = firestoreDb;
        this.localCount = 0;
        this.cloudCount = 0;
        this.totalCount = 0;
        this.pendingCount = 0;
        this.ghostCount = 0;
    }

    /** Register a callback: fn({ totalCount, localCount, cloudCount, pendingCount, limit, zone }) */
    subscribe(fn) {
        this.subscribers.add(fn);
        return () => {
            this.subscribers.delete(fn);
        };
    }

    /** Derive the color zone */
    get zone() {
        if (this.totalCount >= BATCH_LIMIT) return 'limit';     // Red
        if (this.totalCount >= ZONE_WARNING) return 'warning';   // Orange
        return 'normal';                                          // Default
    }

    get limit() { return BATCH_LIMIT; }

    get isAtLimit() { return this.totalCount >= BATCH_LIMIT; }

    get canAdd() { return this.totalCount < BATCH_LIMIT; }

    /** How many more can be added */
    get remaining() { return Math.max(0, BATCH_LIMIT - this.totalCount); }

    /**
     * Recalculate counts from real sources (IDB + Firestore).
     * This is the ONLY place counters are set.
     */
    async recalculate() {
        if (this._recalculating || !this._batchId) return;
        this._recalculating = true;

        try {
            // 1. Get counts from IDB (Pending/Local)
            const stats = await getBatchCounts(this._batchId);
            this.localCount = stats.localCount; // Keep localCount for now, though pendingCount is more detailed

            // 2. Get authoritative cloud count from Firestore
            if (this._firestore && state.currentUser) {
                try {
                    const snap = await this._firestore
                        .collection('batches').doc(this._batchId).get();
                    if (snap.exists) {
                        const data = snap.data();
                        // Use uploadedCount as the authoritative synced number
                        this.cloudCount = data.uploadedCount || data.receiptCount || 0;
                    }
                } catch (e) {
                    console.warn('[BatchState] Firestore count failed:', e.message);
                }
            }

            // STABLE TOTAL LOGIC
            // Total = (Synced to Cloud) + (Still only in Local IDB) + (Ghosts in memory)
            // 'stats' from getBatchCounts only contains localCount and pendingCount
            this.pendingCount = stats.pendingCount + this.ghostCount;
            const newTotal = this.cloudCount + this.pendingCount;

            // Update totalCount directly. We previously had a guard here that caused
            // "upward drift" (permanent doubling) during rapid uploads.
            this.totalCount = newTotal;
            // We "hold" the totalCount if it's within a small margin of error (2 items)
            // or if it's an increase (new items added).
            // This logic is now redundant with the direct assignment above, but kept for historical context if needed.
            // The direct assignment `this.totalCount = newTotal;` is the primary update.
            // if (newTotal >= this.totalCount || (this.totalCount - newTotal) > 2) {
            //     this.totalCount = newTotal;
            // }

            this._notify();
        } finally {
            this._recalculating = false;
        }
    }

    /**
     * Notify that a large batch of files was added (Gallery Bulk)
     */
    notifyBulkAdd(count) {
        if (!this._batchId) return;
        this.ghostCount += count;
        this.recalculate();
    }

    notifyGhostMaterialized(count = 1) {
        if (!this._batchId) return;
        this.ghostCount = Math.max(0, this.ghostCount - count);
        this.recalculate();
    }

    notifyChange() {
        this.totalCount++;
        this.localCount++;
        this.pendingCount++;
        this._notify();
        this.recalculate();
    }

    notifyDelete() {
        this.totalCount = Math.max(0, this.totalCount - 1);
        this.localCount = Math.max(0, this.localCount - 1);
        this.pendingCount = Math.max(0, this.pendingCount - 1);
        this._notify();
        this.recalculate();
    }

    notifyUploadComplete() {
        // Just move the internal markers
        this.pendingCount = Math.max(0, this.pendingCount - 1);
        this.cloudCount++;
        // Keep totalCount stable
        this._notify();
    }

    /** Broadcast current state to all subscribers */
    _notify() {
        const payload = {
            totalCount: this.totalCount,
            localCount: this.localCount,
            cloudCount: this.cloudCount,
            pendingCount: this.pendingCount,
            syncedCount: this.cloudCount,
            limit: BATCH_LIMIT,
            remaining: Math.max(0, BATCH_LIMIT - this.totalCount),
            zone: this.zone,
            isAtLimit: this.isAtLimit,
            canAdd: this.canAdd,
        };
        console.log('[BatchState] Notify:', payload.syncedCount, '/', payload.totalCount);
        for (const fn of this.subscribers) {
            try { fn(payload); } catch (e) { console.error('[BatchState] subscriber error:', e); }
        }
    }

    reset() {
        this.localCount = 0;
        this.cloudCount = 0;
        this.pendingCount = 0;
        this.totalCount = 0;
        this.ghostCount = 0;
        this._batchId = '';
        this._notify();
    }
}

// Singleton export
export const batchState = new BatchStateManager();
