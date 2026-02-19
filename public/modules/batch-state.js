/**
 * BatchStateManager — Single Source of Truth for batch counters.
 *
 * Instead of scattering snapCounter++ across handlers, this module
 * provides real counts from IDB + Firestore, a pub-sub for UI,
 * and usage-meter color zone logic.
 */

import { getIDB } from './db.js';

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
        if (this._recalculating) return;
        this._recalculating = true;

        try {
            // 1. Count IDB items for this batch
            const database = await getIDB();
            const localReceipts = await database.getAllFromIndex('receipts', 'batchId', this._batchId);
            this.localCount = localReceipts.length;

            // Count pending
            this.pendingCount = localReceipts.filter(
                r => r.status === 'pending_upload' || r.status === 'uploading'
            ).length;

            // 2. Count Firestore items for this batch (authoritative)
            if (this._firestore && this._batchId) {
                try {
                    const snap = await this._firestore
                        .collection('batches').doc(this._batchId)
                        .collection('receipts').get();
                    // Cloud count = Firestore docs NOT already in IDB
                    const localIds = new Set(localReceipts.map(r => r.id));
                    this.cloudCount = 0;
                    snap.forEach(doc => {
                        if (!localIds.has(doc.id)) this.cloudCount++;
                    });
                } catch (e) {
                    // Offline — use last known cloud count
                    console.warn('[BatchState] Firestore count failed (offline?):', e.message);
                }
            }

            this.totalCount = this.localCount + this.cloudCount;
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
