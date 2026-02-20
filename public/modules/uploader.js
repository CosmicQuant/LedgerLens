/**
 * uploader.js — Unified Enterprise Pipeline Controller
 * 
 * The single source of truth for the A++ Pipeline Architecture.
 * Manages Gatekeeping, Compression (CPU), Persistence (IDB), and Uploading (Network).
 */

import { state } from './state.js';
import { db as firestore, storage } from './firebase-init.js';
import {
    saveReceiptToIDB,
    deleteReceiptFromIDB,
    getPendingUploads
} from './db.js';
import {
    DOM,
    showToast,
    updateThumbnailStatus,
    updateFinishButton,
    addThumbnailToQueue
} from './ui.js';
import { batchState } from './batch-state.js';
import { getFileExtension, blobToImage, generateThumbnail } from './camera.js';
import { uid } from './utils.js';

// Configuration constants
const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

export class PipelineController {
    constructor() {
        // --- 1. Engine Limits (Adaptive) ---
        this.MAX_COMPRESSIONS = IS_MOBILE ? 1 : 2; // CPU Slot Limit
        this.MAX_UPLOADS = IS_MOBILE ? 2 : 3;      // Network Slot Limit (Modem Guard)

        // --- 2. Live Queues ---
        this.compressQueue = [];
        this.activeCompressions = 0;
        this.activeUploads = 0;

        // --- 3. Worker Pool ---
        this.workerPool = [];
        this.workerRR = 0;
        this.setupWorkerPool();

        console.log(`[Pipeline] Initialized (CPU Slots: ${this.MAX_COMPRESSIONS}, Network Slots: ${this.MAX_UPLOADS}) 🚀`);
    }

    // ==========================================
    // STAGE 0: Worker Pool Management
    // ==========================================
    setupWorkerPool() {
        if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
            for (let i = 0; i < 2; i++) {
                this.workerPool.push(this.createWorker(i));
            }
        }
    }

    createWorker(index) {
        const w = new Worker('/workers/compression.worker.js');
        w.onerror = (err) => console.error(`[Pipeline] Worker ${index} Error:`, err);
        return w;
    }

    respawnWorker(index) {
        if (this.workerPool[index]) this.workerPool[index].terminate();
        this.workerPool[index] = this.createWorker(index);
    }

    async handleFiles(files) {
        if (!files || files.length === 0) return;

        showToast(`Processing ${files.length} items…`, 'info');

        this.compressQueue.push(...files);
        this.processCompressionQueue();
    }

    // ==========================================
    // STAGE 2: Compression Engine (CPU)
    // ==========================================
    processCompressionQueue() {
        while (this.activeCompressions < this.MAX_COMPRESSIONS && this.compressQueue.length > 0) {
            if (batchState.isAtLimit) {
                showToast('Batch limit reached', 'warning');
                this.compressQueue = [];
                return;
            }

            const file = this.compressQueue.shift();
            this.activeCompressions++;

            this.processSingleItem(file).finally(() => {
                this.activeCompressions--;
                // Brief yield for GC before next file
                setTimeout(() => this.processCompressionQueue(), 50);
            });
        }
    }

    async processSingleItem(file) {
        try {
            const id = uid();
            state.pendingCount++;

            // 1. Refresh Blob (Android Handle Fix)
            const freshBlob = file.slice(0, file.size, file.type);

            // 2. Compress (Worker + Tolerant Decoder)
            const compressedBlob = await this.compressWithTolerantFallback(freshBlob);

            // 3. Generate Thumbnail (Main Thread)
            let thumbBlob = null;
            try {
                const img = await blobToImage(compressedBlob);
                thumbBlob = await generateThumbnail(img, false);
                URL.revokeObjectURL(img.src);
            } catch (e) {
                console.warn('[Pipeline] Thumbnail failed:', e);
            }

            // 4. PERSISTENCE (Crucial for Resilience)
            const receipt = {
                id: id,
                batchId: state.batchId,
                blob: compressedBlob,
                thumbBlob: thumbBlob,
                status: 'pending_upload',
                createdAt: Date.now()
            };
            await saveReceiptToIDB(receipt);

            // 5. Update UI
            const displayUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : URL.createObjectURL(compressedBlob);
            state.activeObjectURLs.set(id, displayUrl);
            addThumbnailToQueue(id, displayUrl, 'pending_upload', null, null); // Delete logic handled in main.js

            // 6. ZERO-LAG HANDOFF
            this.processNetworkQueue();

        } catch (err) {
            console.error('[Pipeline] Item failed stage 2:', err);
            state.pendingCount = Math.max(0, state.pendingCount - 1);
        }
    }

    async compressWithTolerantFallback(blob) {
        if (this.workerPool.length === 0) return blob;

        const currentIdx = this.workerRR;
        this.workerRR = (this.workerRR + 1) % this.workerPool.length;

        try {
            // Stage A: High Performance
            const bitmap = await createImageBitmap(blob);
            return await this.runWorkerTask(currentIdx, bitmap);
        } catch (e) {
            console.warn('[Pipeline] Primary bitmap decode failed, trying Tolerant Decoder:', e);
            try {
                // Stage B: Robust Fallback
                const img = await blobToImage(blob);
                const bitmap = await createImageBitmap(img);
                URL.revokeObjectURL(img.src);
                return await this.runWorkerTask(currentIdx, bitmap);
            } catch (err2) {
                console.warn('[Pipeline] Tolerant Decoder failed, trying direct blob:', err2);
                // Stage C: Worker direct
                return this.runWorkerTask(currentIdx, blob);
            }
        }
    }

    runWorkerTask(workerIdx, data) {
        return new Promise((resolve, reject) => {
            const worker = this.workerPool[workerIdx];
            const id = Math.random().toString(36).substr(2, 9);

            const timeout = setTimeout(() => {
                worker.removeEventListener('message', handler);
                console.error(`[Pipeline] Worker ${workerIdx} HUNG. Respawning...`);
                this.respawnWorker(workerIdx);
                reject(new Error('Worker Timeout'));
            }, 30000);

            const handler = (e) => {
                if (e.data.id === id) {
                    clearTimeout(timeout);
                    worker.removeEventListener('message', handler);
                    if (e.data.success) {
                        resolve(e.data.blob);
                    } else reject(new Error(e.data.error));
                }
            };

            worker.addEventListener('message', handler);
            const transfer = (data instanceof ImageBitmap) ? [data] : [];
            worker.postMessage({ file: data, id, maxWidth: 1500, quality: 0.8 }, transfer);
        });
    }

    // ==========================================
    // STAGE 3: Network Engine (Modem Guard)
    // ==========================================
    async processNetworkQueue() {
        if (this.activeUploads >= this.MAX_UPLOADS) return;

        const pending = await getPendingUploads(state.batchId, this.MAX_UPLOADS - this.activeUploads);

        if (pending.length === 0) {
            if (this.activeUploads === 0) {
                state.isUploading = false;
                DOM.syncInd.classList.remove('uploading');
                updateFinishButton(batchState.totalCount, batchState.pendingCount);

                // Show completion summary
                if (batchState.totalCount > 0 && batchState.pendingCount === 0) {
                    showToast(`Success: All ${batchState.totalCount} receipts are synced.`, 'success');
                }
            }
            return;
        }

        if (!state.isUploading) {
            state.isUploading = true;
            DOM.syncInd.classList.add('uploading');
        }

        for (const receipt of pending) {
            if (this.activeUploads >= this.MAX_UPLOADS) break;
            this.activeUploads++;
            this.uploadSingleItem(receipt).finally(() => {
                this.activeUploads--;
                this.processNetworkQueue();
            });
        }
    }

    async uploadSingleItem(receipt) {
        const id = receipt.id;
        const retry = async (fn, n = 2) => {
            try { return await fn(); }
            catch (err) { if (n <= 0) throw err; await new Promise(r => setTimeout(r, 2000)); return retry(fn, n - 1); }
        };

        try {
            receipt.status = 'uploading';
            await saveReceiptToIDB(receipt);
            updateThumbnailStatus(id, 'uploading');

            const ext = getFileExtension();
            const storagePath = `receipts/${state.batchId}/${id}.${ext}`;
            const ref = storage.ref(storagePath);

            const downloadUrl = await retry(async () => {
                const task = ref.put(receipt.blob, { contentType: ext === 'webp' ? 'image/webp' : 'image/jpeg' });
                await new Promise((res, rej) => {
                    task.on('state_changed', (s) => {
                        updateThumbnailStatus(id, 'uploading', null, (s.bytesTransferred / s.totalBytes) * 100);
                    }, rej, res);
                });
                return await task.snapshot.ref.getDownloadURL();
            });

            await retry(async () => {
                await firestore.collection('batches').doc(state.batchId).collection('receipts').doc(id).set({
                    storageUrl: downloadUrl, storagePath, file_path: storagePath, file_extension: ext,
                    status: 'synced', extracted: false, uploadedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                await firestore.collection('batches').doc(state.batchId).update({
                    uploadedCount: firebase.firestore.FieldValue.increment(1)
                });
            });

            await deleteReceiptFromIDB(id);
            state.pendingCount = Math.max(0, state.pendingCount - 1);
            batchState.notifyUploadComplete();
            updateThumbnailStatus(id, 'synced');

        } catch (err) {
            console.error('[Pipeline] Upload failed:', err);
            receipt.status = 'pending_upload';
            await saveReceiptToIDB(receipt).catch(() => { });
            updateThumbnailStatus(id, 'pending_upload');
        }
    }
}

// Singleton Instance
export const uploader = new PipelineController();
