/**
 * sync.js — Concurrent Upload Pipeline
 *
 * Uses a concurrency-limited Promise pool (industry-standard pattern)
 * to upload multiple receipts in parallel while respecting bandwidth
 * and per-item error isolation.
 *
 * Architecture:
 *   getPendingUploads() → pool of MAX_CONCURRENT workers
 *   Each worker: mark uploading → Storage.put() → Firestore write → IDB cleanup
 *   Failures are isolated per-item (one failure doesn't break others)
 *   Failed items are retried on the next scheduled run
 */

import { state } from './state.js';
import { db as firestore, storage } from './firebase-init.js';
import { getPendingUploads, saveReceiptToIDB, deleteReceiptFromIDB } from './db.js';
import { DOM, showToast, updateThumbnailStatus, updateFinishButton } from './ui.js';
import { batchState } from './batch-state.js';
import { getFileExtension } from './camera.js';

// ── Configuration ────────────────────────────────────────
const MAX_CONCURRENT = 3;         // Parallel upload slots (optimal for mobile)
const IDLE_POLL_MS = 15000;     // Check for new items when idle
const FAST_POLL_MS = 1000;      // Re-check quickly after a batch finishes
const MAX_BACKOFF_MS = 300000;    // Cap retry delay at 5 min

// ── Core Upload Pipeline ─────────────────────────────────

export async function uploadPending() {
    if (state.isUploading) return;
    state.isUploading = true;
    DOM.syncInd.classList.add('uploading');

    try {
        const pending = await getPendingUploads(state.batchId);

        if (pending.length === 0) {
            state.isUploading = false;
            DOM.syncInd.classList.remove('uploading');
            scheduleUpload(IDLE_POLL_MS);
            return;
        }

        console.log(`[Sync] ${pending.length} items queued — uploading ${MAX_CONCURRENT} at a time`);

        // ── Concurrency-limited Promise Pool ─────────────
        // Same pattern used by AWS SDK, GCS client, p-queue, etc.
        // Creates a sliding window of MAX_CONCURRENT active uploads.
        const results = await runPool(pending, uploadSingleReceipt, MAX_CONCURRENT);

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`[Sync] Batch complete: ${succeeded} succeeded, ${failed} failed`);

        // Adjust retry timing based on results
        if (failed > 0) {
            state.uploadRetryDelay = Math.min(state.uploadRetryDelay * 1.5, MAX_BACKOFF_MS);
        } else {
            state.uploadRetryDelay = IDLE_POLL_MS; // Reset on full success
        }

    } catch (err) {
        console.error('[Sync] Pipeline error:', err);
    } finally {
        state.isUploading = false;
        DOM.syncInd.classList.remove('uploading');
        updateFinishButton(batchState.totalCount, state.pendingCount);

        // Schedule next run
        const hasMore = await getPendingUploads(state.batchId).then(p => p.length > 0).catch(() => false);
        scheduleUpload(hasMore ? FAST_POLL_MS : state.uploadRetryDelay);
    }
}

// ── Promise Pool (Concurrency Limiter) ───────────────────
// Processes items with at most `limit` concurrent workers.
// Returns Promise.allSettled-style results for error isolation.

async function runPool(items, worker, limit) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runNext() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            try {
                await worker(items[i]);
                results[i] = { status: 'fulfilled' };
            } catch (err) {
                results[i] = { status: 'rejected', reason: err };
            }
        }
    }

    // Spawn `limit` workers that pull from the shared queue
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
    await Promise.all(workers);

    return results;
}

// ── Single Receipt Upload ────────────────────────────────
// Fully self-contained: one receipt in, one upload out.
// Failures are isolated — doesn't affect other uploads.

async function uploadSingleReceipt(receipt) {
    const id = receipt.id;

    try {
        // 1. Mark uploading in IDB
        receipt.status = 'uploading';
        await saveReceiptToIDB(receipt);
        updateThumbnailStatus(id, 'uploading');

        // 2. Upload blob to Firebase Storage with progress tracking
        const ext = getFileExtension();
        const mimeType = ext === 'webp' ? 'image/webp' : 'image/jpeg';
        const storagePath = `receipts/${state.batchId}/${id}.${ext}`;
        const ref = storage.ref(storagePath);
        const task = ref.put(receipt.blob, { contentType: mimeType });

        await new Promise((resolve, reject) => {
            task.on('state_changed',
                (snapshot) => {
                    const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                    updateThumbnailStatus(id, 'uploading', null, progress);
                },
                (error) => reject(error),
                () => resolve()
            );
        });

        // 3. Get download URL
        const downloadUrl = await task.snapshot.ref.getDownloadURL();

        // 4. Write metadata to Firestore (triggers Cloud Function)
        await firestore.collection('batches').doc(state.batchId)
            .collection('receipts').doc(id).set({
                storageUrl: downloadUrl,
                storagePath: storagePath,
                file_path: storagePath,
                file_extension: ext,
                status: 'synced',
                extracted: false,
                uploadedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

        // Increment upload count (for accurate history)
        await firestore.collection('batches').doc(state.batchId).update({
            uploadedCount: firebase.firestore.FieldValue.increment(1)
        });

        // 5. Purge blob from IDB (confirmed in cloud)
        await deleteReceiptFromIDB(id);

        // 6. Update UI card with remote data
        const card = document.getElementById(`q-${id}`);
        if (card) {
            card._firestoreData = {
                storageUrl: downloadUrl,
                storagePath: storagePath,
                status: 'synced'
            };
        }

        // 7. Update counters
        state.pendingCount = Math.max(0, state.pendingCount - 1);
        batchState.notifyUploadComplete();
        updateThumbnailStatus(id, 'synced');

        console.log(`[Sync] ✓ ${id} uploaded`);

    } catch (err) {
        console.error(`[Sync] ✗ ${id} failed:`, err);

        // Mark as pending for retry on next cycle (don't block others)
        receipt.status = 'pending_upload';
        await saveReceiptToIDB(receipt).catch(() => { });
        updateThumbnailStatus(id, 'pending_upload');

        throw err; // Propagate so pool records it as rejected
    }
}

// ── Scheduler ────────────────────────────────────────────

export function scheduleUpload(delay) {
    if (state.uploadTimer) clearTimeout(state.uploadTimer);
    state.uploadTimer = setTimeout(() => uploadPending(), delay);
}
