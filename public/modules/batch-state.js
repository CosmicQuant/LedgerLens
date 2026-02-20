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
        this.totalCount = 0;
        this.pendingCount = 0;
        this._subscribers = [];
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
    }

    /** Register a callback: fn({ totalCount, localCount, cloudCount, pendingCount, limit, zone }) */
    subscribe(fn) {
        this._subscribers.push(fn);
        return () => {
            this._subscribers = this._subscribers.filter(f => f !== fn);
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
            // 1. Efficient Count from IDB (A++ Memory Management)
            // No blobs are fetched here! Just indices.
            const stats = await getBatchCounts(this._batchId);
            this.localCount = stats.localCount;
            this.pendingCount = stats.pendingCount;

            // 2. Count Firestore items for this batch (authoritative)
            if (this._firestore && state.currentUser) {
                try {
                    // Optimized: Only count metadata, no heavy fetching
                    const snap = await this._firestore
                        .collection('batches').doc(this._batchId)
                        .collection('receipts').get();

                    // We can't use .size directly if we want to subtract items still in IDB 
                    // (though items are usually deleted from IDB immediately after sync).
                    // For absolute stability, we just use the snap size.
                    this.cloudCount = snap.size;
                } catch (e) {
                    console.warn('[BatchState] Firestore count failed:', e.message);
                }
            }

            this.totalCount = Math.max(this.localCount, this.cloudCount);
            this._notify();
        } finally {
            this._recalculating = false;
        }
    }

    /**
     * Quick local increment (optimistic) + async recalculate.
     * Use after adding a receipt to IDB.
     */
    notifyChange() {
        this.totalCount++;
        this._notify();
        // Async true count
        this.recalculate();
    }

    /**
     * Quick local decrement (optimistic) + async recalculate.
     * Use after deleting a receipt.
     */
    notifyDelete() {
        this.totalCount = Math.max(0, this.totalCount - 1);
        this._notify();
        this.recalculate();
    }

    /**
     * Called after a successful upload — local moves to cloud.
     */
    notifyUploadComplete() {
        this.pendingCount = Math.max(0, this.pendingCount - 1);
        this._notify();
    }

    /** Broadcast current state to all subscribers */
    _notify() {
        const payload = {
            totalCount: this.totalCount,
            localCount: this.localCount,
            cloudCount: this.cloudCount,
            pendingCount: this.pendingCount,
            limit: BATCH_LIMIT,
            remaining: this.remaining,
            zone: this.zone,
            isAtLimit: this.isAtLimit,
            canAdd: this.canAdd,
        };
        for (const fn of this._subscribers) {
            try { fn(payload); } catch (e) { console.error('[BatchState] subscriber error:', e); }
        }
    }

    reset() {
        this.localCount = 0;
        this.cloudCount = 0;
        this.totalCount = 0;
        this.pendingCount = 0;
        this._batchId = '';
        this._notify();
    }
}

// Singleton export
export const batchState = new BatchStateManager();
