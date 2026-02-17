import { state } from './state.js';
import { showToast } from './ui.js';

const MAX_WIDTH = 1500;
const THUMB_WIDTH = 150; // Thumbnail width
const JPEG_QUALITY = 0.8;

// Reusable canvases
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d');
const thumbCanvas = document.createElement('canvas');
const thumbCtx = thumbCanvas.getContext('2d');

let isTorchOn = false;

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
}

export function captureFrame(videoElement) {
    if (!state.mediaStream) {
        console.error("No media stream available for capture");
        return null;
    }

    const track = state.mediaStream.getVideoTracks()[0];
    const settings = track.getSettings();

    // Fallback if settings are missing (common on some devices)
    const videoWidth = videoElement.videoWidth || settings.width || 1280;
    const videoHeight = videoElement.videoHeight || settings.height || 720;

    const targetW = MAX_WIDTH;
    const scale = targetW / videoWidth;
    const targetH = videoHeight * scale;

    captureCanvas.width = targetW;
    captureCanvas.height = targetH;

    try {
        captureCtx.drawImage(videoElement, 0, 0, targetW, targetH);
    } catch (err) {
        console.error("Canvas draw error:", err);
        return null;
    }
    return new Promise(resolve => {
        captureCanvas.toBlob(blob => resolve(blob), 'image/webp', JPEG_QUALITY);
    });
}

// NEW: Generate small thumbnail from either video or generic source (Blob/Image)
export async function generateThumbnail(source, isVideo = true) {
    let sw, sh;
    if (isVideo) {
        sw = source.videoWidth;
        sh = source.videoHeight;
    } else {
        // Assume source is an Image or another Canvas
        sw = source.width;
        sh = source.height;
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

    return new Promise(resolve => {
        thumbCanvas.toBlob(blob => resolve(blob), 'image/webp', 0.7);
    });
}

/**
 * Creates an Image object from a Blob (helper for gallery thumbnails)
 */
export function blobToImage(blob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
    });
}
