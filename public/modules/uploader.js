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
        // --- 1. Engine Limits (Strict Conveyor Belt Architecture) ---
        this.MAX_ACTIVE_JOBS = 2; // Never process more than 2 start-to-finish jobs at once

        // --- 2. Live Queues ---
        this.jobQueue = [];
        this.activeJobs = 0;

        // --- 3. Worker Pool ---
        this.workerPool = [];
        this.workerRR = 0;
        this.setupWorkerPool();

        this.onDelete = null; // Callback for UI delete buttons

        console.log(`[Pipeline] Initialized (Conveyor Slots: ${this.MAX_ACTIVE_JOBS}) 🚀`);
    }

    setDeleteCallback(fn) {
        console.log('[Pipeline] Delete callback linked ✓');
        this.onDelete = fn;
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

        console.log(`[Pipeline] Adding ${files.length} files to conveyor belt...`);
        showToast(`Adding ${files.length} items to batch…`, 'info');

        // Authoritative bulk increment to prevent flickering
        batchState.notifyBulkAdd(files.length);

        for (const file of files) {
            const id = uid();
            // RULE 1: Ghost UI (Instant Responsiveness)
            // Add a placeholder card instantly. No image yet.
            await addThumbnailToQueue(id, null, 'ghost', null, this.onDelete);

            this.jobQueue.push({ id, file });
        }

        this.processConveyorBelt();
    }

    // ==========================================
    // STAGE 2: THE CONVEYOR BELT (Strict Concurrency)
    // ==========================================
    processConveyorBelt() {
        while (this.activeJobs < this.MAX_ACTIVE_JOBS && this.jobQueue.length > 0) {
            if (batchState.isAtLimit) {
                showToast('Batch limit reached', 'warning');
                this.jobQueue = [];
                return;
            }

            const job = this.jobQueue.shift();
            this.activeJobs++;

            this.processFullJobPipeline(job).finally(() => {
                this.activeJobs--;
                this.processConveyorBelt();
            });
        }
    }

    async processFullJobPipeline({ id, file }) {
        let payloadBlob = file;
        let thumbBlob = null;

        try {
            // STEP A: Compression (Worker)
            // RULE 3: Forgiving Compressor (WhatsApp Fix)
            try {
                payloadBlob = await this.compressWithTolerantFallback(file);
            } catch (compressErr) {
                console.warn(`[Pipeline] Compression failed for ${id}, using raw file:`, compressErr);
                payloadBlob = file;
            }

            // STEP B: Thumbnail Engine
            try {
                const img = await blobToImage(payloadBlob);
                thumbBlob = await generateThumbnail(img, false);
                URL.revokeObjectURL(img.src);
            } catch (thumbErr) {
                console.warn('[Pipeline] Thumbnail failed:', thumbErr);
            }

            // STEP C: Persistence (IDB)
            const receipt = {
                id: id,
                batchId: state.batchId,
                blob: payloadBlob,
                thumbBlob: thumbBlob,
                status: 'uploading',
                createdAt: Date.now()
            };
            await saveReceiptToIDB(receipt);

            // STEP D: Transform Ghost -> Real UI
            const displayUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : URL.createObjectURL(payloadBlob);
            state.activeObjectURLs.set(id, displayUrl);
            await addThumbnailToQueue(id, displayUrl, 'uploading', null, this.onDelete);

            // STEP E: Resumable Upload (Network)
            await this.uploadWithResumable(id, payloadBlob);

        } catch (err) {
            console.error(`[Pipeline] Job ${id} failed:`, err);
            updateThumbnailStatus(id, 'quarantined');
        }
    }

    async processSingleItem(blob) {
        const id = uid();
        let payloadBlob = blob; // Default to raw original
        let thumbBlob = null;

        try {
            // 2. Attempt Compression (Worker)
            try {
                payloadBlob = await this.compressWithTolerantFallback(blob);
            } catch (compressErr) {
                console.warn(`[Pipeline] Compression failed for ${id}. Switching to BLIND upload:`, compressErr);
                payloadBlob = blob; // Explicit fallback to raw
            }

            // 3. Attempt Thumbnail (Main Thread)
            try {
                if (payloadBlob.size > 0) {
                    const img = await blobToImage(payloadBlob);
                    thumbBlob = await generateThumbnail(img, false);
                    URL.revokeObjectURL(img.src);
                }
            } catch (thumbErr) {
                console.warn('[Pipeline] Thumbnail skipped (non-critical):', thumbErr);
                // thumbBlob remains null, UI will use placeholder or raw blob
            }

            // 4. PERSISTENCE (Always succeeds if IDB is healthy)
            const receipt = {
                id: id,
                batchId: state.batchId,
                blob: payloadBlob,
                thumbBlob: thumbBlob,
                status: 'pending_upload',
                createdAt: Date.now()
            };
            await saveReceiptToIDB(receipt);

            // 5. Update UI (TURNSTILE GATE)
            // We await the render completion to ensure the GPU is not overwhelmed 
            // before we start the next Decode operation.
            const displayUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : URL.createObjectURL(payloadBlob);
            state.activeObjectURLs.set(id, displayUrl);

            await addThumbnailToQueue(id, displayUrl, 'pending_upload', null, this.onDelete);

            // 6. GPU BREATHE DELAY
            // Small pause to let the browser's hardware buffers clear and GC handle revoked URLs
            await new Promise(r => setTimeout(r, 150));

            // 7. ZERO-LAG HANDOFF
            this.processNetworkQueue();

        } catch (err) {
            console.error('[Pipeline] Critical persistence failure:', err);
            // Only quarantine if we literally can't save to IDB
            await addThumbnailToQueue(id, './img/failed-capture.png', 'quarantined', null, this.onDelete);
        }
    }

    /**
     * Heavy Decode + Compress
     * Always sends to Worker to protect Main Thread memory.
     */
    async compressWithTolerantFallback(blob) {
        if (this.workerPool.length === 0) return blob;

        const currentIdx = this.workerRR;
        this.workerRR = (this.workerRR + 1) % this.workerPool.length;

        // SKIP MAIN THREAD DECODE entirely. 
        // We send the raw blob to the worker. This solves the "InvalidStateError" 
        // on the main thread and reduces RAM pressure during bulk selection.
        return await this.runWorkerTask(currentIdx, blob);
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
    // STAGE 3: RESUMABLE UPLOADER
    // ==========================================
    async uploadWithResumable(id, blob) {
        const ext = getFileExtension();
        const storagePath = `receipts/${state.batchId}/${id}.${ext}`;
        const sRef = storage.ref(storagePath);

        return new Promise((resolve, reject) => {
            // RULE 4: uploadBytesResumable (Network Resilience)
            // Note: Using compat 'put' which is actually resumable in some Firebase versions,
            // but we'll use the clear 'put' with state observation for maximum compatibility.
            const task = sRef.put(blob, { contentType: ext === 'webp' ? 'image/webp' : 'image/jpeg' });

            task.on('state_changed',
                (snapshot) => {
                    const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                    updateThumbnailStatus(id, 'uploading', null, progress);
                },
                (error) => {
                    console.error(`[Pipeline] Upload task failed for ${id}:`, error);
                    updateThumbnailStatus(id, 'pending_upload');
                    reject(error);
                },
                async () => {
                    const downloadUrl = await task.snapshot.ref.getDownloadURL();

                    // Finalize Firestore
                    await firestore.collection('batches').doc(state.batchId).collection('receipts').doc(id).set({
                        storageUrl: downloadUrl, storagePath, file_path: storagePath, file_extension: ext,
                        status: 'synced', extracted: false, uploadedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    await deleteReceiptFromIDB(id);
                    batchState.notifyUploadComplete();
                    updateThumbnailStatus(id, 'synced');
                    resolve();
                }
            );
        });
    }
}

// Singleton Instance
export const uploader = new PipelineController();
