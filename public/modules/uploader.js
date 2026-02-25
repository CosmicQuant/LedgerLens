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
    getReceiptFromIDB,
    deleteReceiptFromIDB,
    getPendingUploads,
    saveRawFileToIDB,
    getRawFileFromIDB,
    deleteRawFileFromIDB
} from './db.js';
import {
    DOM,
    showToast,
    updateThumbnailStatus,
    updateFinishButton,
    addThumbnailToQueue
} from './ui.js';
import { batchState } from './batch-state.js';
import { uid } from './utils.js';
import { acquireWakeLock, releaseWakeLock, reacquireIfNeeded } from './wakelock.js';

// Configuration constants
const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

export class PipelineController {
    constructor() {
        // --- 1. Engine Limits (Strict Conveyor Belt Architecture) ---
        this.MAX_ACTIVE_JOBS = 3; // 3 concurrent jobs for max bandwidth utilization

        // --- 2. Live Queues & State ---
        this.jobQueue = [];
        this.activeJobs = 0;
        this.fingerprints = new Set(); // Prevent duplicate files
        this.uploadTasks = new Map(); // Track active tasks for cancellation
        this.wakeLock = null; // Prevent mobile sleep during batches

        // --- 3. Worker Pool & Global Locks ---
        this.workerPool = [];
        this.workerRR = 0;
        this.setupWorkerPool();
        this.decodeQueue = Promise.resolve(); // V36: Strict sequential GPU memory lock
        this.idbSaveLock = Promise.resolve();
        this.cancelledJobs = new Set(); // Prevent zombie resurrection if deleted before IDB save

        this.setupLifecycle(); // V36 Visibility listener

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
            for (let i = 0; i < 3; i++) {
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

        console.log(`[Pipeline] Analyzing ${files.length} files...`);

        // WAKE LOCK IMMEDIATELY
        acquireWakeLock('pipeline');

        // FAST FILTER (Pure JS, no Async)
        const validFiles = [];
        let heicSkipped = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            // Skip non-images
            if (!file.type.startsWith('image/')) continue;

            // HEIC Detection: iPhones default to HEIC format.
            // createImageBitmap() fails on HEIC in Chrome/Firefox,
            // and Storage rules reject image/heic MIME type.
            const name = (file.name || '').toLowerCase();
            if (file.type === 'image/heic' || file.type === 'image/heif' ||
                name.endsWith('.heic') || name.endsWith('.heif')) {
                heicSkipped++;
                continue;
            }

            // Check duplicates
            const fingerprint = `${file.name}-${file.size}-${file.lastModified}`;
            if (this.fingerprints.has(fingerprint)) continue;

            this.fingerprints.add(fingerprint);
            validFiles.push(file);
        }

        if (validFiles.length === 0) {
            if (heicSkipped > 0) {
                showToast(`${heicSkipped} HEIC file(s) skipped. Please use JPEG/PNG format or change iPhone camera settings (Settings → Camera → Formats → Most Compatible).`, 'warning');
            } else {
                showToast('No new files to add.', 'info');
            }
            return;
        }

        if (heicSkipped > 0) {
            showToast(`${heicSkipped} HEIC file(s) skipped (unsupported format).`, 'warning');
        }

        showToast(`Vaulting ${validFiles.length} images...`, 'info');
        batchState.notifyBulkAdd(validFiles.length);

        // 3. UI OPTIMIZATION
        const queueItems = validFiles.map(file => {
            const id = uid();
            return {
                id,
                file: file,
                receipt: {
                    id,  // FIX: Set id synchronously — NOT in requestAnimationFrame
                    batchId: state.batchId,
                    name: file.name || `gallery_${Date.now()}.jpg`,
                    size: file.size,
                    status: 'queued',
                    createdAt: Date.now(),
                    mimeType: file.type || 'image/jpeg'
                }
            };
        });

        // 4. RENDER UI IN BACKGROUND
        requestAnimationFrame(() => {
            queueItems.forEach(item => {
                addThumbnailToQueue(item.id, null, 'ghost', null, this.onDelete);
            });
        });

        // 5. PARALLEL VAULTING (The "Chunker")
        // Mobile: 2 parallel to halve peak RAM (~8MB vs ~20MB on budget Android)
        const CHUNK_SIZE = IS_MOBILE ? 2 : 5;
        for (let i = 0; i < queueItems.length; i += CHUNK_SIZE) {
            const chunk = queueItems.slice(i, i + CHUNK_SIZE);

            // Pass both the item ID, the RAW OS file, and the receipt metadata
            await Promise.all(chunk.map(item => this._saveToVault(item.id, item.file, item.receipt)));
        }

        // 6. KICKSTART CONVEYOR
        this.processConveyorBelt();
    }

    // ==========================================
    // NEW HELPER: _saveToVault
    // ==========================================
    async _saveToVault(id, file, receiptBase) {
        if (this.cancelledJobs.has(id)) {
            this.cancelledJobs.delete(id);
            return;
        }

        try {
            let receiptToSave;

            try {
                // Primary path: Convert to ArrayBuffer for maximum IDB compatibility
                const arrayBuffer = await file.arrayBuffer();
                receiptToSave = { ...receiptBase, id, buffer: arrayBuffer };
            } catch (abErr) {
                // FIX: DOMException fallback (Vivo Y03 / budget Android)
                console.warn(`[Pipeline] arrayBuffer() failed for ${id}, using Blob fallback:`, abErr.name);
                receiptToSave = { ...receiptBase, id, blob: file };
            }

            // DIRECT WRITE TO IDB
            await saveReceiptToIDB(receiptToSave);

            // Push to processing queue
            this.jobQueue.push({ id });

            // IMMEDIATE THUMBNAIL: Generate a tiny 80px preview on the main thread.
            // This gives users instant visual feedback instead of grey ghost cards
            // while waiting 20-60s for the full Worker compression pipeline.
            // The Worker will replace this with a better thumbnail later.
            this._generateQuickThumbnail(id, file);

        } catch (err) {
            console.error(`[Pipeline] Vault Save Failed ${id}`, err);
            updateThumbnailStatus(id, 'error');
        }
    }

    /**
     * Generate an 80px thumbnail on the main thread for instant UI feedback.
     * Non-blocking: failures are silent (Worker will retry later).
     */
    _generateQuickThumbnail(id, fileOrBlob) {
        // Fire-and-forget: don't block the vault pipeline
        createImageBitmap(fileOrBlob).then(bitmap => {
            const THUMB_SIZE = 80;
            let tw = bitmap.width;
            let th = bitmap.height;
            if (tw > th && tw > THUMB_SIZE) {
                th = Math.round(th * THUMB_SIZE / tw);
                tw = THUMB_SIZE;
            } else if (th > THUMB_SIZE) {
                tw = Math.round(tw * THUMB_SIZE / th);
                th = THUMB_SIZE;
            }

            const c = document.createElement('canvas');
            c.width = tw;
            c.height = th;
            const ctx = c.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, tw, th);
            bitmap.close();

            c.toBlob(thumbBlob => {
                if (!thumbBlob) return;
                const thumbUrl = URL.createObjectURL(thumbBlob);

                const card = document.getElementById(`q-${id}`);
                if (!card) return;
                const img = card.querySelector('img');
                if (img) {
                    img.src = thumbUrl;
                    card.classList.remove('is-ghost', 'is-placeholder');
                    const icon = card.querySelector('.placeholder-icon');
                    if (icon) icon.remove();
                }
            }, 'image/jpeg', 0.4);
        }).catch(() => {
            // Silent: Worker pipeline will handle thumbnail generation
        });
    }

    // ==========================================
    // STAGE 1: Lifecycle & Wake Locks (V36)
    // ==========================================
    setupLifecycle() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                console.warn(`[Pipeline] App backgrounded with ${this.activeJobs} active jobs & ${this.jobQueue.length} queued.`);
            } else if (document.visibilityState === 'visible') {
                console.log('[Pipeline] App foregrounded.');
                if (this.activeJobs > 0) {
                    reacquireIfNeeded();
                }
            }
        });
    }



    // ==========================================
    // STAGE 2: THE CONVEYOR BELT (Strict Concurrency)
    // ==========================================
    processConveyorBelt() {
        if (this.activeJobs > 0) {
            acquireWakeLock('pipeline');
        }

        while (this.activeJobs < this.MAX_ACTIVE_JOBS && this.jobQueue.length > 0) {
            if (batchState.isAtLimit) {
                showToast('Batch limit reached', 'warning');
                this.jobQueue = [];
                this.fingerprints.clear();
                return;
            }

            const job = this.jobQueue.shift();
            this.activeJobs++;

            this.processFullJobPipeline(job).finally(() => {
                this.activeJobs--;

                if (this.activeJobs === 0 && this.jobQueue.length === 0) {
                    releaseWakeLock('pipeline');

                    // V39 STRICT BATCH COMPLETION WIPE:
                    const inputBulk = document.getElementById('input-bulk');
                    if (inputBulk) inputBulk.value = '';
                } else {
                    this.processConveyorBelt();
                }
            });
        }
    }



    async processFullJobPipeline({ id }) {
        let pristineFile = null;
        let fileToUpload = null;
        let storedReceipt = null;

        try {
            // 1. ADD GHOST CARD IMMEDIATELY (Redundant safety)
            await addThumbnailToQueue(id, null, 'uploading', null, this.onDelete);

            // We are GUARANTEED that the data exists because IDB spooler pushed us here.
            storedReceipt = await getReceiptFromIDB(id);

            if (storedReceipt && storedReceipt.buffer) {
                // Reconstruct the Blob from the raw ArrayBuffer
                pristineFile = new Blob([storedReceipt.buffer], { type: storedReceipt.mimeType || 'image/jpeg' });
            } else if (storedReceipt && storedReceipt.blob) {
                // DOMException fallback path: Blob was stored directly
                pristineFile = typeof storedReceipt.blob === 'string'
                    ? await (await fetch(storedReceipt.blob)).blob()
                    : storedReceipt.blob;
            } else if (storedReceipt && storedReceipt.base64Fallback) {
                const response = await fetch(storedReceipt.base64Fallback);
                pristineFile = await response.blob();
            } else {
                throw new Error(`Missing IDB Byte stream for job ${id}.`);
            }

            fileToUpload = pristineFile;

            // 2. STRICT SEQUENTIAL DECODE & COMPRESS LOCK
            await new Promise((lockResolve) => {
                this.decodeQueue = this.decodeQueue.then(async () => {
                    try {
                        updateThumbnailStatus(id, 'compressing');
                        const safeClone = pristineFile.slice(0, pristineFile.size, pristineFile.type);
                        const workerResult = await this.compressWithTolerantFallback(safeClone);

                        if (workerResult && workerResult.blob) {
                            fileToUpload = workerResult.blob;
                            // Inject thumbnail directly from worker!
                            if (workerResult.thumbnailUrl) {
                                const imgElement = document.querySelector(`#q-${id} .thumbnail-img`) || document.querySelector(`#q-${id} img`);
                                if (imgElement) {
                                    imgElement.src = workerResult.thumbnailUrl;
                                    const card = document.getElementById(`q-${id}`);
                                    if (card) {
                                        card.classList.remove('is-placeholder', 'is-ghost');
                                        imgElement.parentElement.classList.remove('is-placeholder');
                                        const icon = imgElement.parentElement.querySelector('.placeholder-icon');
                                        if (icon) icon.remove();
                                    }
                                }
                            }
                        } else {
                            fileToUpload = workerResult; // Fallback if worker array was empty
                        }

                    } catch (compressionError) {
                        console.warn(`[Pipeline] Compression/Decode failed for ${id}, using raw file:`, compressionError);
                        fileToUpload = pristineFile;
                    }

                    lockResolve();
                }).catch(err => {
                    console.error('[Pipeline] Global decoder lock error:', err);
                    lockResolve();
                });
            });

            // 3. Persistence Update (IDB)
            storedReceipt.status = 'uploading';
            storedReceipt.size = fileToUpload.size;
            await saveReceiptToIDB(storedReceipt);
            batchState.notifyGhostMaterialized(1);

            // 4. FIREBASE UPLOAD
            await this.uploadWithResumable(id, fileToUpload, pristineFile);

        } catch (fatalError) {
            console.error(`[Pipeline] Fatal error processing ${id}:`, fatalError ? fatalError.message : 'Unknown', fatalError ? fatalError.stack : '');
            updateThumbnailStatus(id, 'error');
            batchState.notifyGhostMaterialized(1);
        } finally {
            // IRONCLAD GARBAGE COLLECTION
            if (storedReceipt && storedReceipt.pinUrl) {
                URL.revokeObjectURL(storedReceipt.pinUrl);
            }

            state.activeObjectURLs.delete(id);
            this.uploadTasks.delete(id);

            console.log(`[Pipeline] Slot Freed for job: ${id}`);
        }
    }

    cancelJob(id) {
        this.cancelledJobs.add(id);
        const task = this.uploadTasks.get(id);
        if (task) {
            console.log(`[Pipeline] Cancelling active upload task: ${id}`);
            task.cancel();
            this.uploadTasks.delete(id);
        } else {
            const idx = this.jobQueue.findIndex(job => job.id === id);
            if (idx > -1) {
                console.log(`[Pipeline] Removing job ${id} from queue before start`);
                this.jobQueue.splice(idx, 1);
            }
        }
    }

    async compressWithTolerantFallback(blob) {
        // If Worker pool exists (OffscreenCanvas supported), use it
        if (this.workerPool.length > 0) {
            const currentIdx = this.workerRR;
            this.workerRR = (this.workerRR + 1) % this.workerPool.length;
            return await this.runWorkerTask(currentIdx, blob);
        }

        // FALLBACK: Main-thread canvas compression for browsers without OffscreenCanvas
        // (Safari < 16.4, some Firefox Android builds)
        // Without this, raw 4-8MB photos upload uncompressed, burning Storage quota 4×.
        console.warn('[Pipeline] No OffscreenCanvas — using main-thread compression fallback');
        return await this._compressOnMainThread(blob);
    }

    /**
     * Main-thread canvas compression fallback.
     * Used when OffscreenCanvas is unavailable (Safari < 16.4, Firefox Android).
     * Resizes to 1500px wide + generates a base64 thumbnail.
     */
    async _compressOnMainThread(blob) {
        const MAX_W = 1500;
        const THUMB_MAX = 100;

        const bitmap = await createImageBitmap(blob);
        let targetW = bitmap.width;
        let targetH = bitmap.height;
        if (targetW > MAX_W) {
            const scale = MAX_W / targetW;
            targetW = MAX_W;
            targetH = Math.round(bitmap.height * scale);
        }

        // Compress
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);

        const compressedBlob = await new Promise(resolve => {
            canvas.toBlob(b => resolve(b), 'image/jpeg', 0.8);
        });

        // Thumbnail
        let tw = bitmap.width;
        let th = bitmap.height;
        if (tw > th && tw > THUMB_MAX) {
            th = Math.round(th * THUMB_MAX / tw);
            tw = THUMB_MAX;
        } else if (th > THUMB_MAX) {
            tw = Math.round(tw * THUMB_MAX / th);
            th = THUMB_MAX;
        }

        const tCanvas = document.createElement('canvas');
        tCanvas.width = tw;
        tCanvas.height = th;
        tCanvas.getContext('2d').drawImage(bitmap, 0, 0, tw, th);
        bitmap.close();

        const tBlob = await new Promise(resolve => {
            tCanvas.toBlob(b => resolve(b), 'image/jpeg', 0.4);
        });

        const thumbnailUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(tBlob);
        });

        return { blob: compressedBlob, thumbnailUrl };
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
                        resolve({ blob: e.data.blob, thumbnailUrl: e.data.thumbnailUrl });
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
    async uploadWithResumable(id, blob, originalFile) {
        let ext = 'webp';
        let mimeType = 'image/webp';

        if (blob.type) {
            mimeType = blob.type;
            if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
            else if (mimeType.includes('png')) ext = 'png';
            else if (mimeType.includes('webp')) ext = 'webp';
        } else if (originalFile && originalFile.name) {
            ext = originalFile.name.split('.').pop().toLowerCase();
            if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
            else if (ext === 'png') mimeType = 'image/png';
        }

        // Security: Include user UID in storage path to enforce ownership in rules
        const userId = state.currentUser ? state.currentUser.uid : 'anonymous';
        const storagePath = `receipts/${userId}/${state.batchId}/${id}.${ext}`;
        const sRef = storage.ref(storagePath);

        // PRE-FLIGHT CHECK
        try {
            await blob.slice(0, 1).arrayBuffer();
        } catch (e) {
            console.error(`[Pipeline] Dead OS File descriptor for ${id}.`);
            updateThumbnailStatus(id, 'error');
            throw new Error('File descriptor closed by mobile OS. Tap to retry.');
        }

        const task = sRef.put(blob, { contentType: mimeType });
        this.uploadTasks.set(id, task);

        // PROGRESS-BASED TIMEOUT: Kill only if no progress for 30s (not total elapsed)
        // On African 3G networks, a 4MB upload can take 160s total but still be progressing.
        let lastProgressTime = Date.now();
        let killSwitchTimer = setInterval(() => {
            if (Date.now() - lastProgressTime > 30000) {
                console.error(`[Pipeline] No-progress timeout triggered for ${id}.`);
                clearInterval(killSwitchTimer);
                if (this.uploadTasks.has(id)) {
                    task.cancel();
                }
                updateThumbnailStatus(id, 'error');
            }
        }, 5000);

        return new Promise((resolve, reject) => {
            task.on('state_changed',
                (snapshot) => {
                    lastProgressTime = Date.now(); // Reset timeout on any progress
                    const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                    updateThumbnailStatus(id, 'uploading', null, progress);
                },
                (error) => {
                    clearInterval(killSwitchTimer);
                    console.error(`[Pipeline] Upload task failed for ${id}:`, error ? error.message : '', error);
                    updateThumbnailStatus(id, 'error');
                    reject(error);
                },
                async () => {
                    clearInterval(killSwitchTimer);
                    if (task.snapshot.state === 'canceled') {
                        return reject(new Error('Task Canceled'));
                    }

                    try {
                        const downloadUrl = await task.snapshot.ref.getDownloadURL();

                        if (!downloadUrl) {
                            throw new Error("Upload failed: No URL returned");
                        }

                        await firestore.collection('batches').doc(state.batchId).collection('receipts').doc(id).set({
                            storageUrl: downloadUrl, storagePath, file_path: storagePath, file_extension: ext,
                            status: 'synced', extracted: false, uploadedAt: window.firebase.firestore.FieldValue.serverTimestamp()
                        });

                        // Increment cloud count on the batch doc
                        await firestore.collection('batches').doc(state.batchId).update({
                            uploadedCount: window.firebase.firestore.FieldValue.increment(1)
                        });

                        await deleteReceiptFromIDB(id);
                        batchState.notifyUploadComplete();
                        updateThumbnailStatus(id, 'synced');
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }
}

export const uploader = new PipelineController();
