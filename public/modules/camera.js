import { state } from './state.js';
import { showToast } from './ui.js';

const MAX_WIDTH = 1500;
const THUMB_WIDTH = 150;
const COMPRESS_QUALITY = 0.8;

// Reusable canvases
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d');
const thumbCanvas = document.createElement('canvas');
const thumbCtx = thumbCanvas.getContext('2d');

// ── WebP Support Detection ──────────────────────────────
// Safari < 16.4 doesn't support WebP canvas encoding.
// toBlob('image/webp') silently returns null → broken uploads.
let _preferredMime = null;

function getPreferredMime() {
    if (_preferredMime) return _preferredMime;

    // Test if the browser can encode WebP via canvas
    const testCanvas = document.createElement('canvas');
    testCanvas.width = 1;
    testCanvas.height = 1;
    const dataUrl = testCanvas.toDataURL('image/webp');

    if (dataUrl.startsWith('data:image/webp')) {
        _preferredMime = 'image/webp';
    } else {
        _preferredMime = 'image/jpeg';
        console.warn('[Camera] WebP encoding not supported. Falling back to JPEG.');
    }
    return _preferredMime;
}

/** Returns 'webp' or 'jpeg' — used for storage path extension */
export function getFileExtension() {
    return getPreferredMime() === 'image/webp' ? 'webp' : 'jpg';
}

// ── Wake Lock ────────────────────────────────────────────
let isTorchOn = false;
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
            console.log('[WakeLock] Acquired');
        }
    } catch (e) {
        console.warn('[WakeLock] Failed:', e.message);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
        console.log('[WakeLock] Released');
    }
}

// ── Camera Control ───────────────────────────────────────

export async function startCamera(videoElement, torchButton) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        });

        state.mediaStream = stream;
        videoElement.srcObject = stream;

        // Force play (required for some mobile browsers)
        videoElement.onloadedmetadata = () => {
            videoElement.play().catch(e => console.error("Play error:", e));
        };

        // Torch Logic
        const track = stream.getVideoTracks()[0];
        const capabilities = track.getCapabilities();

        if (capabilities.torch && torchButton) {
            torchButton.classList.remove('hidden');
            torchButton.onclick = () => {
                isTorchOn = !isTorchOn;
                track.applyConstraints({ advanced: [{ torch: isTorchOn }] });
                torchButton.classList.toggle('active', isTorchOn);
            };
        }

        try {
            await videoElement.play();
        } catch (err) {
            console.error('Video play error:', err);
        }

        // Prevent phone sleep
        await requestWakeLock();
    } catch (err) {
        showToast('Camera access denied', 'error');
        console.error('Camera error:', err);
    }
}

export function stopCamera(videoElement) {
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(t => t.stop());
        state.mediaStream = null;
        if (videoElement) videoElement.srcObject = null;
    }
    releaseWakeLock();
}

// ── Frame Capture ────────────────────────────────────────
// A++ Architecture: Offloads encoding to worker via ImageBitmap transfer
export async function captureFrame(videoElement) {
    if (!state.mediaStream) {
        console.error("No media stream available for capture");
        return null;
    }

    try {
        // 1. Create Bitmap on the main thread (fastest way to "pause" the frame)
        // This is effectively our "shutter"
        const bitmap = await createImageBitmap(videoElement);

        // 2. Hand off to worker for compression
        // This keeps the UI thread 100% free while the JPEG is generated
        return await compressImageWorker(bitmap);
    } catch (err) {
        console.error("[Capture] A++ worker failure:", err);
        showToast('Camera capture failed (Worker Busy)', 'error');
        throw err;
    }
}

async function captureFrameFallback(videoElement) {
    const track = state.mediaStream.getVideoTracks()[0];
    const settings = track.getSettings();

    const videoWidth = videoElement.videoWidth || settings.width || 1280;
    const videoHeight = videoElement.videoHeight || settings.height || 720;

    const targetW = MAX_WIDTH;
    const scale = targetW / videoWidth;
    const targetH = videoHeight * scale;

    captureCanvas.width = targetW;
    captureCanvas.height = targetH;
    captureCtx.drawImage(videoElement, 0, 0, targetW, targetH);

    return new Promise(resolve => {
        captureCanvas.toBlob(blob => resolve(blob), getPreferredMime(), COMPRESS_QUALITY);
    });
}

// ── Thumbnail Generation ─────────────────────────────────

export async function generateThumbnail(source, isVideo = true) {
    let sw, sh;
    if (isVideo) {
        sw = source.videoWidth;
        sh = source.videoHeight;
    } else {
        sw = source.naturalWidth || source.width;
        sh = source.naturalHeight || source.height;
    }

    if (!sw || !sh) return null;

    const targetW = THUMB_WIDTH;
    const scale = targetW / sw;
    const targetH = sh * scale;

    thumbCanvas.width = targetW;
    thumbCanvas.height = targetH;

    try {
        thumbCtx.drawImage(source, 0, 0, targetW, targetH);
    } catch (err) {
        console.error("Thumb canvas draw error:", err);
        return null;
    }

    const mime = getPreferredMime();
    return new Promise(resolve => {
        thumbCanvas.toBlob(blob => {
            if (!blob || blob.size === 0) {
                thumbCanvas.toBlob(fb => resolve(fb), 'image/jpeg', 0.7);
            } else {
                resolve(blob);
            }
        }, mime, 0.7);
    });
}

// ── Gallery Image Compression ────────────────────────────

/* Worker Pool by LedgerLens - 2 Parallel Workers */
const WORKER_COUNT = 2;
const workerPool = [];
let workerRR = 0; // Round Robin index

function createWorker(index) {
    const w = new Worker('./workers/compression.worker.js');
    console.log(`[Camera] Worker ${index} Spawned 🚀`);
    return w;
}

if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    try {
        for (let i = 0; i < WORKER_COUNT; i++) {
            workerPool.push(createWorker(i));
        }
    } catch (e) {
        console.warn('[Camera] Worker init failed:', e);
    }
}

function respawnWorker(index) {
    if (workerPool[index]) {
        workerPool[index].terminate(); // Double safe
    }
    workerPool[index] = createWorker(index);
}

export async function compressImage(file) {
    if (workerPool.length > 0) {
        // A++ Path: Use ImageBitmap for zero-copy if possible
        try {
            const bitmap = await createImageBitmap(file);
            return await compressImageWorker(bitmap);
        } catch (e) {
            console.warn('[Camera] Bitmap creation failed, sending raw blob:', e);
            return compressImageWorker(file);
        }
    }
    return compressImageFallback(file);
}

function compressImageWorker(data) {
    return new Promise((resolve, reject) => {
        // Round Robin Worker Selection
        const currentIdx = workerRR;
        const worker = workerPool[currentIdx];
        workerRR = (workerRR + 1) % workerPool.length;

        const id = Math.random().toString(36).substr(2, 9);

        // A++ Kill & Respawn Timeout (30s)
        const timeout = setTimeout(() => {
            worker.removeEventListener('message', handler);
            console.error(`[A++ Guard] Worker ${currentIdx} HUNG on ${id}. TERMINATING! 🛡️`);

            // 1. Kill the zombie worker
            worker.terminate();

            // 2. Respawn a clean slate
            respawnWorker(currentIdx);

            // 3. Quarantine the task (reject)
            reject(new Error(`Worker Timeout (${id})`));
        }, 30000);

        const handler = (e) => {
            if (e.data.id === id) {
                clearTimeout(timeout);
                worker.removeEventListener('message', handler);
                if (e.data.success) {
                    console.log(`[Worker] ${id} success (${Math.round(e.data.blob.size / 1024)} KB)`);
                    resolve(e.data.blob);
                } else {
                    console.error(`[Worker] ${id} Failed:`, e.data.error);
                    reject(new Error(e.data.error));
                }
            }
        };

        const transfer = (data instanceof ImageBitmap) ? [data] : [];
        worker.addEventListener('message', handler);
        worker.postMessage({
            file: data,
            id,
            maxWidth: MAX_WIDTH,
            quality: COMPRESS_QUALITY
        }, transfer);
    });
}

// Compresses raw gallery photos (Fallback for Main Thread)
export async function compressImageFallback(file) {
    const img = await blobToImage(file);

    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;

    // Only downscale if wider than MAX_WIDTH
    let targetW = sw;
    let targetH = sh;
    if (sw > MAX_WIDTH) {
        const scale = MAX_WIDTH / sw;
        targetW = MAX_WIDTH;
        targetH = Math.round(sh * scale);
    }

    // Reuse shared canvas
    captureCanvas.width = targetW;
    captureCanvas.height = targetH;

    try {
        captureCtx.drawImage(img, 0, 0, targetW, targetH);
    } catch (err) {
        console.error('[Compress] Canvas draw error:', err);
        URL.revokeObjectURL(img.src);
        return file; // Return original on failure
    }

    URL.revokeObjectURL(img.src);

    const mime = getPreferredMime();
    return new Promise(resolve => {
        captureCanvas.toBlob(blob => {
            if (!blob || blob.size === 0) {
                // Fallback to JPEG
                captureCanvas.toBlob(fb => {
                    resolve(fb || file);
                }, 'image/jpeg', COMPRESS_QUALITY);
            } else {
                const savings = ((1 - blob.size / file.size) * 100).toFixed(0);
                console.log(`[Compress Main] ${(file.size / 1024).toFixed(0)}KB → ${(blob.size / 1024).toFixed(0)}KB (${savings}% saved)`);
                resolve(blob);
            }
        }, mime, COMPRESS_QUALITY);
    });
}

// ── Helpers ──────────────────────────────────────────────

export function blobToImage(blob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const timeout = setTimeout(() => {
            img.src = '';
            reject(new Error('Image load timeout (10s)'));
        }, 10000);

        img.onload = () => {
            clearTimeout(timeout);
            resolve(img);
        };
        img.onerror = (err) => {
            clearTimeout(timeout);
            reject(err);
        };
        img.src = URL.createObjectURL(blob);
    });
}
