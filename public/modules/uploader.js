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
import { getFileExtension, blobToImage, generateThumbnail } from './camera.js';
import { uid } from './utils.js';

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

        // PILLAR 8: Pre-batch Auth Token Refresh
        // 1. WAKE LOCK IMMEDIATELY
        if ('wakeLock' in navigator && !this.wakeLock) {
            this.requestWakeLock();
        }

        // 2. FAST FILTER (Pure JS, no Async)
        const validFiles = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            // Skip non-images
            if (!file.type.startsWith('image/')) continue;

            // Check duplicates
            const fingerprint = `${file.name}-${file.size}-${file.lastModified}`;
            if (this.fingerprints.has(fingerprint)) continue;

            this.fingerprints.add(fingerprint);
            validFiles.push(file);
        }

        if (validFiles.length === 0) {
            showToast('No new files to add.', 'info');
            return;
        }

        showToast(`Vaulting ${validFiles.length} images...`, 'info');
        batchState.notifyBulkAdd(validFiles.length);

        // 3. UI OPTIMIZATION
        const queueItems = validFiles.map(file => {
            return {
                id: uid(),
                file: file, // We pass the file down, but DON'T put it in the receipt yet
                receipt: {
                    batchId: state.batchId,
                    name: file.name || `gallery_${Date.now()}.jpg`,
                    size: file.size,
                    status: 'queued',
                    createdAt: Date.now(),
                    mimeType: file.type || 'image/jpeg'
                    // NOTE: 'blob: file' has been completely removed from here!
                }
            };
        });

        // 4. RENDER UI IN BACKGROUND
        requestAnimationFrame(() => {
            queueItems.forEach(item => {
                item.receipt.id = item.id;
                addThumbnailToQueue(item.id, null, 'ghost', null, this.onDelete);
            });
        });

        // 5. PARALLEL VAULTING (The "Chunker")
        const CHUNK_SIZE = 5;
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
            // 1. Convert the OS File pointer into raw binary data (ArrayBuffer)
            // This is lightning fast, avoids VRAM crashes, and permanently beats the Android security timer!
            const arrayBuffer = await file.arrayBuffer();

            // 2. Attach the pure binary buffer to the receipt
            const receiptToSave = {
                ...receiptBase,
                buffer: arrayBuffer
            };

            // 3. DIRECT WRITE TO IDB
            await saveReceiptToIDB(receiptToSave);

            // 4. Push to processing queue
            this.jobQueue.push({ id });

            // 5. Update UI from "Ghost" to "Placeholder"
            const card = document.getElementById(`q-${id}`);
            if (card) {
                card.classList.remove('is-ghost');
                card.classList.add('is-placeholder');
            }

        } catch (err) {
            console.error(`[Pipeline] Vault Save Failed ${id}`, err);
            updateThumbnailStatus(id, 'error');
        }
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
            this.requestWakeLock();
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
                    this.releaseWakeLock();

                    // V39 STRICT BATCH COMPLETION WIPE:
                    const inputBulk = document.getElementById('input-bulk');
                    if (inputBulk) inputBulk.value = '';
                } else {
                    this.processConveyorBelt();
                }
            });
        }
    }



    processFullJobPipeline({ id }) {
        return new Promise(async (resolve) => {
            let displayUrl = null;
            let pristineFile = null;
            let fileToUpload = null;
            let storedReceipt = null;

            try {
                // 1. ADD GHOST CARD IMMEDIATELY (Redundant safety)
                await addThumbnailToQueue(id, null, 'uploading', null, this.onDelete);

                // We are GUARANTEED that the data exists because IDB spooler pushed us here.
                storedReceipt = await getReceiptFromIDB(id);

                if (storedReceipt && storedReceipt.buffer) {
                    // V60: Reconstruct the Blob from the raw ArrayBuffer exactly at the moment of upload
                    pristineFile = new Blob([storedReceipt.buffer], { type: storedReceipt.mimeType || 'image/jpeg' });
                } else if (storedReceipt && storedReceipt.blob) {
                    pristineFile = typeof storedReceipt.blob === 'string'
                        ? await (await fetch(storedReceipt.blob)).blob()
                        : storedReceipt.blob;
                } else if (storedReceipt && storedReceipt.base64Fallback) {
                    try {
                        const response = await fetch(storedReceipt.base64Fallback);
                        pristineFile = await response.blob();
                    } catch (fetchErr) {
                        throw new Error(`Failed to read Base64 fallback for ${id} - string corrupted.`);
                    }
                } else if (storedReceipt && storedReceipt.pinUrl) {
                    // Legacy code path in case of weird old cache hits
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
                await new Promise((lockResolve) => {
                    this.decodeQueue = this.decodeQueue.then(async () => {
                        try {
                            updateThumbnailStatus(id, 'compressing');
                            // NOTE: Since we compressed in the Spooler, this step is fast now!
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
                // 5. IRONCLAD GARBAGE COLLECTION
                if (storedReceipt && storedReceipt.pinUrl) {
                    URL.revokeObjectURL(storedReceipt.pinUrl);
                }

                state.activeObjectURLs.delete(id);
                this.uploadTasks.delete(id);

                console.log(`[Pipeline] Slot Freed for job: ${id}`);
                resolve();
            }
        });
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
        if (this.workerPool.length === 0) return blob;

        const currentIdx = this.workerRR;
        this.workerRR = (this.workerRR + 1) % this.workerPool.length;

        // Send to worker
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

        const storagePath = `receipts/${state.batchId}/${id}.${ext}`;
        const sRef = storage.ref(storagePath);

        return new Promise(async (resolve, reject) => {
            // PRE-FLIGHT CHECK
            try {
                await blob.slice(0, 1).arrayBuffer();
            } catch (e) {
                console.error(`[Pipeline] Dead OS File descriptor for ${id}.`);
                updateThumbnailStatus(id, 'error');
                return reject(new Error('File descriptor closed by mobile OS. Tap to retry.'));
            }

            const task = sRef.put(blob, { contentType: mimeType });
            this.uploadTasks.set(id, task);

            // 30-SECOND KILL SWITCH
            let killSwitchTimer;
            const timeoutPromise = new Promise((_, timeoutReject) => {
                killSwitchTimer = setTimeout(() => {
                    console.error(`[Pipeline] 30-Second Kill Switch Triggered for ${id}.`);
                    if (this.uploadTasks.has(id)) {
                        task.cancel();
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
                        console.error(`[Pipeline] Upload task failed for ${id}:`, error ? error.message : '', error);
                        updateThumbnailStatus(id, 'error');
                        firebaseReject(error);
                    },
                    async () => {
                        if (task.snapshot.state === 'canceled') {
                            return firebaseReject(new Error('Task Canceled'));
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

            try {
                await Promise.race([firebaseUploadPromise, timeoutPromise]);
                resolve();
            } catch (raceError) {
                reject(raceError);
            } finally {
                clearTimeout(killSwitchTimer);
            }
        });
    }
}

export const uploader = new PipelineController();
