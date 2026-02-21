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

        for (const file of validFiles) {
            const id = uid();

            // RULE 1: Ghost UI (Instant Responsiveness)
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

            // Send to background spooler
            this._queueIDBSaveAndStartJob(id, receipt, file);

            // A microscopic pause to keep the DOM fluid
            await new Promise(r => setTimeout(r, 10));
        }
    }

    // ==========================================
    // STAGE 1.5: Non-Blocking SECURE IDB Spooler (V43)
    // ==========================================
    async _queueIDBSaveAndStartJob(id, receipt, volatileFile) {
        // Enforce a strict 1-by-1 transaction lock for IndexedDB
        if (!this.idbSaveLock) this.idbSaveLock = Promise.resolve();

        this.idbSaveLock = this.idbSaveLock.then(async () => {
            if (this.cancelledJobs.has(id)) {
                this.cancelledJobs.delete(id);
                return;
            }

            // --- V44: INSTANT CLIENT-SIDE THUMBNAILS ---
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
                            if (icon) icon.remove();
                        }
                    }
                } else {
                    // Force fallback if Android rejected the image
                    const card = document.getElementById(`q-${id}`);
                    if (card) {
                        card.classList.remove('is-ghost');
                        card.classList.add('is-placeholder');
                        const imgElement = card.querySelector('.thumbnail-img') || card.querySelector('img');
                        if (imgElement) imgElement.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                    }
                }
            } catch (thumbErr) {
                console.warn(`[Pipeline] Early thumbnail generation failed for ${id}`, thumbErr);
            }

            try {
                // --- V48: COMPRESS BEFORE SPOOLING (Fix for DataError) ---
                // Shrink 15MB -> ~500KB so we can fit 100 images in IDB
                const spoolBlob = await this.fastCompressForSpooling(volatileFile);

                receipt.size = spoolBlob.size;
                receipt.blob = spoolBlob;

                // Write to the physical permanent disk partition
                await saveReceiptToIDB(receipt);
            } catch (idbErr) {
                console.warn(`[Pipeline] IDB error for ${id}:`, idbErr.message, idbErr.stack);
                // Fallback: Pin the OS pointer in memory (risky but necessary if disk full)
                receipt.blob = null;
                receipt.pinUrl = URL.createObjectURL(volatileFile);
                await saveReceiptToIDB(receipt);
            }

            if (!this.cancelledJobs.has(id)) {
                this.jobQueue.push({ id });
                this.processConveyorBelt();
            } else {
                this.cancelledJobs.delete(id);
            }
        }).catch(e => console.error("[Pipeline] Critical IDB Queue Failure", e));
    }

    /**
     * HELPER: Quick compression before saving to DB
     * Turns 1.5GB batch into ~50MB batch to fit in Browser Storage
     */
    async fastCompressForSpooling(file) {
        return new Promise((resolve) => {
            // Safety: If file is small (<2MB), don't waste CPU compressing
            if (file.size < 2 * 1024 * 1024) return resolve(file);

            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Max dimension 1920px (Good balance of quality vs size for storage)
                const MAX_DIM = 1920;
                if (width > height && width > MAX_DIM) {
                    height *= MAX_DIM / width;
                    width = MAX_DIM;
                } else if (height > MAX_DIM) {
                    width *= MAX_DIM / height;
                    height = MAX_DIM;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Compress to JPEG 70%
                try {
                    canvas.toBlob((blob) => {
                        URL.revokeObjectURL(url);
                        if (!blob) return resolve(file); // Security fallback

                        // Propagate original metadata
                        const newFile = new File([blob], file.name, {
                            type: 'image/jpeg',
                            lastModified: file.lastModified
                        });
                        resolve(newFile);
                    }, 'image/jpeg', 0.7);
                } catch (canvasErr) {
                    console.warn(`[Pipeline] Canvas compression error for ${file.name}`, canvasErr);
                    URL.revokeObjectURL(url);
                    resolve(file);
                }
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(file); // Fallback to raw if compression fails
            };
            img.src = url;
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

    async generateMicroThumbnail(originalBlobUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
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

                try {
                    ctx.drawImage(img, 0, 0, width, height);
                    const microBase64 = canvas.toDataURL('image/jpeg', 0.3);
                    resolve(microBase64);
                } catch (err) {
                    console.warn('[Pipeline] MicroThumb generation failed:', err);
                    resolve(null);
                }
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
                // 1. ADD GHOST CARD IMMEDIATELY (Redundant safety)
                await addThumbnailToQueue(id, null, 'uploading', null, this.onDelete);

                // We are GUARANTEED that the data exists because IDB spooler pushed us here.
                storedReceipt = await getReceiptFromIDB(id);

                if (storedReceipt && storedReceipt.blob) {
                    pristineFile = storedReceipt.blob;
                } else if (storedReceipt && storedReceipt.pinUrl) {
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
