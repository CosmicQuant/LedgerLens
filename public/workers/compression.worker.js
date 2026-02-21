
/*
 * compression.worker.js
 * Offloads image compression to a background thread using OffscreenCanvas.
 */

self.onmessage = async (e) => {
    const { file, maxWidth = 1500, quality = 0.8, id } = e.data;

    try {
        // Attempt the RAM-safe A++ compression
        const bitmap = file instanceof ImageBitmap ? file : await createImageBitmap(file);

        // Scaled Compression
        let targetWidth = bitmap.width;
        let targetHeight = bitmap.height;
        if (targetWidth > maxWidth) {
            const scale = maxWidth / targetWidth;
            targetWidth = maxWidth;
            targetHeight = Math.round(bitmap.height * scale);
        }

        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

        const compressedBlob = await canvas.convertToBlob({
            type: 'image/jpeg',
            quality: quality
        });

        // 2. Tiny UI Thumbnail (Memory-Safe Base64)
        // This offloads the Android DOMException risk entirely off the main thread
        let thumbW = bitmap.width;
        let thumbH = bitmap.height;
        const THUMB_MAX = 100;
        if (thumbW > thumbH && thumbW > THUMB_MAX) {
            thumbH = Math.round(thumbH * THUMB_MAX / thumbW);
            thumbW = THUMB_MAX;
        } else if (thumbH > THUMB_MAX) {
            thumbW = Math.round(thumbW * THUMB_MAX / thumbH);
            thumbH = THUMB_MAX;
        }
        const tCanvas = new OffscreenCanvas(thumbW, thumbH);
        const tCtx = tCanvas.getContext('2d');
        tCtx.imageSmoothingEnabled = true;
        tCtx.drawImage(bitmap, 0, 0, thumbW, thumbH);

        const tBlob = await tCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.4 });

        const reader = new FileReader();
        const thumbUrl = await new Promise(res => {
            reader.onloadend = () => res(reader.result);
            reader.readAsDataURL(tBlob);
        });

        bitmap.close();

        // Success! Send the smaller, compressed file back along with the micro-thumbnail
        self.postMessage({ blob: compressedBlob, id: id, success: true, thumbnailUrl: thumbUrl });

    } catch (error) {
        // It failed to read the pixels (likely a WhatsApp or Cloud file or HEIC).
        // WE DO NOT SEND THE FILE BACK (prevents DataCloneError in IndexedDB).
        // We tell the main thread it failed, and it will fall back to its pristine copy.
        console.warn(`[Worker] Rejecting ${id} to trigger main-thread fallback: ${error.message}`);

        self.postMessage({
            error: error.message,
            id: id,
            success: false
        });
    }
};
