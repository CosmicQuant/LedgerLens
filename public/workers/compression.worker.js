
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

        bitmap.close();

        // Success! Send the smaller, compressed file back
        self.postMessage({ blob: compressedBlob, id: id, success: true });

    } catch (error) {
        // It failed to read the pixels (likely a WhatsApp or Cloud file).
        // WE DO NOT SKIP IT. We send the ORIGINAL raw file back.
        console.warn(`[Worker] Raw Bypass for ${id}: ${error.message}`);

        self.postMessage({
            blob: file, // Send the original raw file back!
            id: id,
            success: true // It's a "success" for the pipeline
        });
    }
};
