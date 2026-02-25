import { state } from './state.js';
import { showToast } from './ui.js';
import { acquireWakeLock, releaseWakeLock } from './wakelock.js';

const MAX_WIDTH = 1500;
const THUMB_WIDTH = 150;
const COMPRESS_QUALITY = 0.8;

// Reusable canvas for thumbnails only (low-risk, small size)
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
            if (err.name !== 'AbortError') {
                console.error('Video play error:', err);
            }
        }

        // Prevent phone sleep
        await acquireWakeLock('camera');
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
    releaseWakeLock('camera');
}

// ── Frame Capture ────────────────────────────────────────
// Pure Shutter: Captures raw pixels with pre-downscale, hands over to Pipeline.
// FIX: Uses an independent canvas per capture to prevent race conditions
// on rapid shutter taps (shared canvas caused DOMException on Vivo Y03).
export async function captureFrame(videoElement) {
    if (!state.mediaStream) return null;

    try {
        // Shutter: Capture instantaneous bitmap
        const bitmap = await createImageBitmap(videoElement);

        // Pre-downscale to MAX_WIDTH to reduce blob size and RAM pressure.
        // A 1920×1080 frame at full quality = ~2MB blob + 8MB pixel buffer.
        // At 1500px wide = ~500KB blob + 4MB pixel buffer — 50% RAM savings.
        const srcW = bitmap.width;
        const srcH = bitmap.height;
        let targetW = srcW;
        let targetH = srcH;
        if (srcW > MAX_WIDTH) {
            const scale = MAX_WIDTH / srcW;
            targetW = MAX_WIDTH;
            targetH = Math.round(srcH * scale);
        }

        // FIX: Create a NEW canvas per capture instead of reusing a singleton.
        // This prevents the race condition where rapid taps overwrite the
        // shared canvas while toBlob() is still encoding the previous frame.
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        bitmap.close();

        return new Promise(resolve => {
            canvas.toBlob(blob => {
                if (blob) blob.name = `capture_${Date.now()}.jpg`;
                resolve(blob);
                // Canvas is now garbage-collectible (no reference held)
            }, 'image/jpeg', COMPRESS_QUALITY);
        });
    } catch (err) {
        console.error("[Camera] Shutter failed:", err);
        return null;
    }
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

// Note: Worker Pool and Compression logic moved to uploader.js

// ── Helpers ──────────────────────────────────────────────

export function blobToImage(blob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        const timeout = setTimeout(() => {
            URL.revokeObjectURL(url);
            img.src = '';
            reject(new Error('Image load timeout (10s)'));
        }, 10000);

        img.onload = () => {
            clearTimeout(timeout);
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = (err) => {
            clearTimeout(timeout);
            URL.revokeObjectURL(url);
            reject(err);
        };
        img.src = url;
    });
}
