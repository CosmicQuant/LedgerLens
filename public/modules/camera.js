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
    if (!state.mediaStream) return null;

    const track = state.mediaStream.getVideoTracks()[0];
    const settings = track.getSettings();

    const targetW = MAX_WIDTH;
    const scale = targetW / settings.width;
    const targetH = settings.height * scale;

    captureCanvas.width = targetW;
    captureCanvas.height = targetH;
    captureCtx.drawImage(videoElement, 0, 0, targetW, targetH);

    return new Promise(resolve => {
        captureCanvas.toBlob(blob => resolve(blob), 'image/webp', JPEG_QUALITY);
    });
}

// NEW: Generate small thumbnail
export function captureThumbnail(videoElement) {
    if (!state.mediaStream) return null;

    const track = state.mediaStream.getVideoTracks()[0];
    const settings = track.getSettings();

    const targetW = THUMB_WIDTH;
    const scale = targetW / settings.width;
    const targetH = settings.height * scale;

    thumbCanvas.width = targetW;
    thumbCanvas.height = targetH;
    thumbCtx.drawImage(videoElement, 0, 0, targetW, targetH);

    return new Promise(resolve => {
        thumbCanvas.toBlob(blob => resolve(blob), 'image/webp', 0.7);
    });
}
