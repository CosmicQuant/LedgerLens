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
        this.MAX_ACTIVE_JOBS = 3; // Upgrade to 3 concurrent jobs for max bandwidth utilization

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

        // PILLAR 8: Pre-batch Auth Token Refresh
        try {
            if (state.currentUser) await state.currentUser.getIdToken(true);
        } catch (err) {
            console.warn('[Pipeline] Token refresh failed. Continuing anyway.', err);
        }

        let validFiles = [];

        for (const file of files) {
            // PILLAR 7: Fingerprinting (Silent Duplicate Drop)
            const fingerprint = `${file.name}-${file.size}-${file.lastModified}`;
            if (this.fingerprints.has(fingerprint)) {
                console.log(`[Pipeline] Skiping exact duplicate: ${file.name}`);
                continue;
            }
            this.fingerprints.add(fingerprint);
            validFiles.push(file);
        }

        if (validFiles.length === 0) {
            showToast('All selected files were duplicates.', 'info');
            return;
        }

        // Let UI know we are grabbing files to IDB
        showToast(`Importing ${validFiles.length} items to local storage…`, 'info');

        // Authoritative bulk increment to prevent flickering
        batchState.notifyBulkAdd(validFiles.length);

        // V43 FLAWLESS ARCHITECTURE: DECOUPLED BACKGROUND SPOOLER
        // 1. The UI instantly updates (no freezing for 100 items).
        // 2. We do NOT push to the upload queue immediately to avoid race conditions.
        // 3. We stream the massive Blobs to disk via a 1-by-1 lock (`idbSaveLock`),
        //    completely avoiding the Android `DataError` / `QuotaExceeded` loop crash.

        for (const file of validFiles) {
            const id = uid();

            // RULE 1: Ghost UI (Instant Responsiveness)
            // Add a placeholder card instantly. No image yet.
            await addThumbnailToQueue(id, null, 'ghost', null, this.onDelete);

            // Create metadata receipt
            const receipt = {
                id: id,
                batchId: state.batchId,
                name: file.name || `gallery_${Date.now()}.jpg`,
                size: file.size,
                status: 'queued',
                blob: null,
                createdAt: Date.now()
            };

            // Send the heavy lifting to the background IDB pump.
            // It will push to `this.jobQueue` only AFTER the file is safely secured.
            this._queueIDBSaveAndStartJob(id, receipt, file);

            // A microscopic pause to keep the DOM extremely fluid during massive gallery injections
            await new Promise(r => setTimeout(r, 10));
        }
    }

    // ==========================================
    // STAGE 1.5: Non-Blocking SECURE IDB Spooler (V43)
    // ==========================================
    async _queueIDBSaveAndStartJob(id, receipt, volatileFile) {
        // Enforce a strict 1-by-1 transaction lock for IndexedDB to prevent QuotaExceeded
        if (!this.idbSaveLock) this.idbSaveLock = Promise.resolve();

        this.idbSaveLock = this.idbSaveLock.then(async () => {
            // Anti-Zombie Protection: Did user click "delete" on the ghost card before we got here?
            if (this.cancelledJobs.has(id)) {
                this.cancelledJobs.delete(id);
                console.log(`[Pipeline] Skiping IDB save for cancelled zombie job: ${id}`);
                return;
            }

            // --- V44: INSTANT CLIENT-SIDE THUMBNAILS (Pro Architecture) ---
            // Gen a 100x100 thumbnail in the background lock BEFORE saving to IDB.
            // 1-by-1 sequencing implicitly protects RAM from crashing.
            try {
                const tempUrl = URL.createObjectURL(volatileFile);
                const microThumb = await this.generateMicroThumbnail(tempUrl);
                URL.revokeObjectURL(tempUrl);

                if (microThumb) {
                    const imgElement = document.querySelector(`#q-${id} .thumbnail-img`) || document.querySelector(`#q-${id} img`);
                    if (imgElement) {
                        imgElement.src = microThumb;
                        const card = document.getElementById(`q-${id}`);
                        if (card) {
                            card.classList.remove('is-placeholder', 'is-ghost');
                            imgElement.parentElement.classList.remove('is-placeholder');
                            const icon = imgElement.parentElement.querySelector('.placeholder-icon');
                            if (icon) icon.remove(); // Remove the ghost spinner/icon
                        }
                    }
                }
            } catch (thumbErr) {
                console.warn(`[Pipeline] Early silent thumbnail generation failed for ${id}`, thumbErr);
            }

            try {
                // Instantly clone the OS bytes into memory
                const pristineFile = new Blob([volatileFile], { type: volatileFile.type });
                receipt.size = pristineFile.size;
                receipt.blob = pristineFile;

                // Write to the physical permanent disk partition
                await saveReceiptToIDB(receipt);
            } catch (idbErr) {
                console.warn(`[Pipeline] IDB DataError saving blob for ${id}:`, idbErr, "Falling back to memory pin.");
                // If the Android device's storage quota explicitly rejects the massive blob loop,
                // fallback to saving just the metadata, and explicitly pin the OS pointer in memory.
                receipt.blob = null;
                receipt.pinUrl = URL.createObjectURL(volatileFile);
                await saveReceiptToIDB(receipt);
            }

            // ONLY push to the active job queue when we GUARANTEE it's on disk or pinned.
            // This permanently eliminates the TypeError null crashes where the queue outran the disk.
            if (!this.cancelledJobs.has(id)) {
                this.jobQueue.push({ id });
                this.processConveyorBelt();
            } else {
                this.cancelledJobs.delete(id);
            }
        }).catch(e => console.error("[Pipeline] Critical IDB Queue Failure", e));
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
                if (this.wakeLock === null && this.activeJobs > 0) {
                    this.requestWakeLock();
                }
            }
        });
    }

    async requestWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            if (!this.wakeLock) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                console.log('[Pipeline] Wake Lock acquired 🕯️');
            }
        } catch (err) {
            console.warn('[Pipeline] Wake Lock failed:', err);
        }
    }

    releaseWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release().then(() => {
                this.wakeLock = null;
                console.log('[Pipeline] Wake Lock released 💤');
            });
        }
    }

    // ==========================================
    // STAGE 2: THE CONVEYOR BELT (Strict Concurrency)
    // ==========================================
    processConveyorBelt() {
        if (this.activeJobs > 0) {
            this.requestWakeLock(); // PILLAR 5: Wake Lock integration
        }

        while (this.activeJobs < this.MAX_ACTIVE_JOBS && this.jobQueue.length > 0) {
            if (batchState.isAtLimit) {
                showToast('Batch limit reached', 'warning');
                this.jobQueue = [];
                this.fingerprints.clear(); // Free memory
                return;
            }

            const job = this.jobQueue.shift();
            this.activeJobs++;

            this.processFullJobPipeline(job).finally(() => {
                this.activeJobs--;

                if (this.activeJobs === 0 && this.jobQueue.length === 0) {
                    this.releaseWakeLock(); // Release lock when completely idle

                    // V39 STRICT BATCH COMPLETION WIPE:
                    // Only now is it safe to clear the DOM input and release the OS file descriptors.
                    const inputBulk = document.getElementById('input-bulk');
                    if (inputBulk) inputBulk.value = '';
                } else {
                    this.processConveyorBelt();
                }
            });
        }
    }

    async generateMicroThumbnail(originalBlobUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // Force a tiny 100x100 thumbnail size
                const MAX_SIZE = 100;
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_SIZE) {
                        height *= MAX_SIZE / width;
                        width = MAX_SIZE;
                    }
                } else {
                    if (height > MAX_SIZE) {
                        width *= MAX_SIZE / height;
                        height = MAX_SIZE;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                // Export as a highly compressed JPEG (quality 0.3)
                const microBase64 = canvas.toDataURL('image/jpeg', 0.3);
                resolve(microBase64);
            };
            img.onerror = () => resolve(null);
            img.src = originalBlobUrl;
        });
    }

    processFullJobPipeline({ id }) {
        return new Promise(async (resolve) => {
            let displayUrl = null;
            let pristineFile = null;
            let fileToUpload = null;
            let storedReceipt = null;

            try {
                // 1. ADD GHOST CARD IMMEDIATELY (Redundant safety, mostly handled by spooler now)
                await addThumbnailToQueue(id, null, 'uploading', null, this.onDelete);

                // V43 FIX: WE ARE GUARANTEED DATA NOW
                // We are GUARANTEED that the data exists because IDB spooler pushed us here.
                storedReceipt = await getReceiptFromIDB(id);

                if (storedReceipt && storedReceipt.blob) {
                    pristineFile = storedReceipt.blob;
                } else if (storedReceipt && storedReceipt.pinUrl) {
                    // We hit a DataError quota limit during spooling, using explicitly pinned memory
                    // We MUST fetch the `content://` blob securely via fetch
                    try {
                        const response = await fetch(storedReceipt.pinUrl);
                        pristineFile = await response.blob();
                    } catch (fetchErr) {
                        throw new Error(`Failed to read pinned ObjectURL for ${id} - OS may have destroyed it.`);
                    }
                } else {
                    throw new Error(`Missing IDB Byte stream and no fallback pin for job ${id}.`);
                }

                fileToUpload = pristineFile;

                // 2. STRICT SEQUENTIAL DECODE & COMPRESS LOCK
                // This prevents Android GPU QuotaExceededError by processing exactly 1 image at a time
                await new Promise((lockResolve) => {
                    this.decodeQueue = this.decodeQueue.then(async () => {
                        try {
                            // Attempt heavily compressed worker
                            updateThumbnailStatus(id, 'compressing');
                            const safeClone = pristineFile.slice(0, pristineFile.size, pristineFile.type);
                            fileToUpload = await this.compressWithTolerantFallback(safeClone);

                        } catch (compressionError) {
                            console.warn(`[Pipeline] Compression/Decode failed for ${id}, using raw file:`, compressionError);
                            fileToUpload = pristineFile; // V39 FIX: use the pristine copy, not the dead file pointer
                        }

                        lockResolve();
                    }).catch(err => {
                        console.error('[Pipeline] Global decoder lock error:', err);
                        lockResolve();
                    });
                });

                // 3. Persistence Update (IDB) - upgrade to 'uploading'
                storedReceipt.status = 'uploading';
                storedReceipt.size = fileToUpload.size;
                await saveReceiptToIDB(storedReceipt);
                batchState.notifyGhostMaterialized(1); // Ghost converted to active state

                // 4. FIREBASE UPLOAD
                // (uploadWithResumable now has dynamic extension via our recent fix)
                await this.uploadWithResumable(id, fileToUpload, pristineFile);

                // DATABASE SYNC is handled inside uploadWithResumable's success callback

            } catch (fatalError) {
                // Catch ANY error that happens during upload or DB sync
                console.error(`[Pipeline] Fatal error processing ${id}:`, fatalError);
                updateThumbnailStatus(id, 'error');
                batchState.notifyGhostMaterialized(1);
            } finally {
                // 5. IRONCLAD GARBAGE COLLECTION & QUEUE RELEASE

                // V40 FIX: Release the eager pin lock if IDB fallback was used
                if (storedReceipt && storedReceipt.pinUrl) {
                    URL.revokeObjectURL(storedReceipt.pinUrl);
                }

                state.activeObjectURLs.delete(id);
                this.uploadTasks.delete(id);

                console.log(`[Pipeline] Slot Freed for job: ${id}`);
                // THIS IS THE MOST IMPORTANT LINE. IT FREES THE SLOT.
                resolve();
            }
        });
    }

    cancelJob(id) {
        // Anti-Zombie Protection for rapid delete during gallery influx
        this.cancelledJobs.add(id);

        // PILLAR 8: Cancellation integration
        const task = this.uploadTasks.get(id);
        if (task) {
            console.log(`[Pipeline] Cancelling active upload task: ${id}`);
            task.cancel();
            this.uploadTasks.delete(id);
        } else {
            // It might just be in the active jobQueue waiting for GPU lock
            const idx = this.jobQueue.findIndex(job => job.id === id);
            if (idx > -1) {
                console.log(`[Pipeline] Removing job ${id} from queue before start`);
                this.jobQueue.splice(idx, 1);
            }
        }
    }

    async processSingleItem(blob) {
        const id = uid();
        let payloadBlob = blob; // Default to raw original
        let thumbBlob = null;

        try {
            // 2. Attempt Thumbnail (Main Thread) FIRST
            try {
                if (blob.size > 0) {
                    const img = await blobToImage(blob);
                    thumbBlob = await generateThumbnail(img, false);
                    URL.revokeObjectURL(img.src);
                }
            } catch (thumbErr) {
                console.warn('[Pipeline] Thumbnail skipped (non-critical):', thumbErr);
            }

            // 3. Attempt Compression (Worker) via safe clone
            try {
                const safeClone = blob.slice(0, blob.size, blob.type);
                payloadBlob = await this.compressWithTolerantFallback(safeClone);
            } catch (compressErr) {
                console.warn(`[Pipeline] Compression failed for ${id}. Switching to BLIND upload:`, compressErr);
                payloadBlob = blob; // Explicit fallback to pristine raw
            }

            // 4. PERSISTENCE (Metadata Only)
            const receipt = {
                id: id,
                batchId: state.batchId,
                size: payloadBlob.size,
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
    async uploadWithResumable(id, blob, originalFile) {
        // ISSUE 2 FIX: Derive the actual extension from the blob type, or fallback to the original file name.
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

        const storagePath = `receipts/${state.batchId}/${id}.${ext}`;
        const sRef = storage.ref(storagePath);

        return new Promise(async (resolve, reject) => {

            // PRE-FLIGHT CHECK (V37 Critical Fix)
            // If Android Chrome has aggressively closed the Unix file descriptor for this batched file,
            // passing it to Firebase will silently hang the upload network request forever (0 bytes sent).
            // This 1-byte read forces a rejection instantly if the file is truly dead/unreadable, freeing the queue.
            try {
                await blob.slice(0, 1).arrayBuffer();
            } catch (e) {
                console.error(`[Pipeline] Dead OS File descriptor for ${id}. Upload Impossible.`);
                updateThumbnailStatus(id, 'error');
                return reject(new Error('File descriptor closed by mobile OS. Tap to retry.'));
            }

            // RULE 4: uploadBytesResumable (Network Resilience)
            const task = sRef.put(blob, { contentType: mimeType });
            this.uploadTasks.set(id, task); // Track for cancellation

            // THE 30-SECOND KILL SWITCH (V38)
            // If Firebase catches a corrupted byte stream, it might spin infinitely without throwing an error.
            // This race promise guarantees the pipeline slot is violently freed after 30 seconds of absolute silence.
            const timeoutPromise = new Promise((_, timeoutReject) => {
                setTimeout(() => {
                    console.error(`[Pipeline] 30-Second Kill Switch Triggered for ${id}. Firebase Hung.`);
                    if (this.uploadTasks.has(id)) {
                        task.cancel(); // Force Firebase to stop reading the dead stream
                    }
                    updateThumbnailStatus(id, 'error');
                    timeoutReject(new Error('Network Upload Timeout'));
                }, 30000);
            });

            const firebaseUploadPromise = new Promise((firebaseResolve, firebaseReject) => {
                task.on('state_changed',
                    (snapshot) => {
                        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                        updateThumbnailStatus(id, 'uploading', null, progress);
                    },
                    (error) => {
                        console.error(`[Pipeline] Upload task failed for ${id}:`, error);
                        updateThumbnailStatus(id, 'error'); // V36 strict error marking
                        firebaseReject(error);
                    },
                    async () => {
                        // Check if it was canceled during the final tick
                        if (task.snapshot.state === 'canceled') {
                            return firebaseReject(new Error('Task Canceled'));
                        }

                        try {
                            const downloadUrl = await task.snapshot.ref.getDownloadURL();

                            // Finalize Firestore
                            await firestore.collection('batches').doc(state.batchId).collection('receipts').doc(id).set({
                                storageUrl: downloadUrl, storagePath, file_path: storagePath, file_extension: ext,
                                status: 'synced', extracted: false, uploadedAt: firebase.firestore.FieldValue.serverTimestamp()
                            });

                            await deleteReceiptFromIDB(id);
                            batchState.notifyUploadComplete();
                            updateThumbnailStatus(id, 'synced');
                            firebaseResolve();
                        } catch (e) {
                            firebaseReject(e);
                        }
                    }
                );
            });

            // Race them! First to throw/resolve wins.
            try {
                await Promise.race([firebaseUploadPromise, timeoutPromise]);
                resolve();
            } catch (raceError) {
                reject(raceError);
            }
        });
    }
}

// Singleton Instance
export const uploader = new PipelineController();
