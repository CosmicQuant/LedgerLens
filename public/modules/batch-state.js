/**
 * BatchStateManager — Single Source of Truth for batch counters.
 *
 * Architecture: ALWAYS RECALCULATE from real sources (IDB + Firestore).
 * No manual increments/decrements. No optimistic math. No ghost counts.
 * Every notify method just triggers a debounced recalculate.
 */

import { getBatchCounts } from './db.js';
import { state } from './state.js';

const BATCH_LIMIT = 100;
const ZONE_WARNING = 90;
const RECALC_DEBOUNCE_MS = 150; // Batch rapid events into one IDB query

class BatchStateManager {
    constructor() {
        this._batchId = '';
        this._firestore = null;
        this.localCount = 0;   // Items in IDB (all statuses)
        this.cloudCount = 0;   // Items in Firestore (uploaded)
        this.pendingCount = 0; // Items in IDB still processing
        this.totalCount = 0;   // localCount + cloudCount

        this.subscribers = new Set();
        this._recalculating = false;
        this._debounceTimer = null;
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

    /** Register a callback */
    subscribe(fn) {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }

    /** Derive the color zone */
    get zone() {
        if (this.totalCount >= BATCH_LIMIT) return 'limit';
        if (this.totalCount >= ZONE_WARNING) return 'warning';
        return 'normal';
    }

    get limit() { return BATCH_LIMIT; }
    get isAtLimit() { return this.totalCount >= BATCH_LIMIT; }
    get canAdd() { return this.totalCount < BATCH_LIMIT; }
    get remaining() { return Math.max(0, BATCH_LIMIT - this.totalCount); }

    /**
     * Recalculate counts from the ONLY two real sources:
     *   1. IDB — items waiting to upload
     *   2. Firestore batch doc — uploadedCount (items already in cloud)
     * This is the ONLY place counters are set. No manual math anywhere.
     */
    async recalculate() {
        if (this._recalculating || !this._batchId) return;
        this._recalculating = true;

        try {
            // 1. IDB: Count all items for this batch
            const stats = await getBatchCounts(this._batchId);
            this.localCount = stats.totalInIDB;
            this.pendingCount = stats.pendingCount;

            // 2. Firestore: Get authoritative cloud count
            if (this._firestore && state.currentUser) {
                try {
                    const snap = await this._firestore
                        .collection('batches').doc(this._batchId).get();
                    if (snap.exists) {
                        const data = snap.data();
                        this.cloudCount = data.uploadedCount || 0;
                    }
                } catch (e) {
                    console.warn('[BatchState] Firestore count failed:', e.message);
                }
            }

            // TOTAL = items in IDB + items in cloud
            this.totalCount = this.localCount + this.cloudCount;

            this._notify();
        } finally {
            this._recalculating = false;
        }
    }

    /**
     * Debounced recalculate — batches rapid events (e.g., 10 vault saves
     * in 100ms) into a single IDB + Firestore query.
     */
    _debouncedRecalculate() {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this.recalculate();
        }, RECALC_DEBOUNCE_MS);
    }

    // ═══════════════════════════════════════════
    // Event Notifications: All just trigger recalculate
    // ═══════════════════════════════════════════

    /** Gallery/camera bulk add — just recalculate */
    notifyBulkAdd(count) {
        if (!this._batchId) return;
        this._debouncedRecalculate();
    }

    /** A ghost item saved to IDB — just recalculate */
    notifyGhostMaterialized(count = 1) {
        if (!this._batchId) return;
        this._debouncedRecalculate();
    }

    /** Legacy: single item change */
    notifyChange() {
        this._debouncedRecalculate();
    }

    /** Item deleted — recalculate */
    notifyDelete() {
        this._debouncedRecalculate();
    }

    /** Upload completed — recalculate to sync with Firestore */
    notifyUploadComplete() {
        this._debouncedRecalculate();
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
        this._batchId = '';
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._notify();
    }
}

// Singleton export
export const batchState = new BatchStateManager();
