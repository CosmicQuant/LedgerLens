
/*
 * compression.worker.js
 * Offloads image compression to a background thread using OffscreenCanvas.
 */

self.onmessage = async (e) => {
    const { file, maxWidth = 1500, quality = 0.8, id } = e.data;

    let bitmap = null;
    try {
        // 1. Create ImageBitmap (efficient decoding)
        // file can be a File, Blob, or ImageBitmap
        bitmap = file instanceof ImageBitmap ? file : await createImageBitmap(file);

        // 2. Calculate professional proportional resizing
        let targetWidth = bitmap.width;
        let targetHeight = bitmap.height;

        if (targetWidth > maxWidth) {
            const scale = maxWidth / targetWidth;
            targetWidth = maxWidth;
            targetHeight = Math.round(bitmap.height * scale);
        }

        // 3. OffscreenCanvas Resizing (Fast, no DOM)
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext('2d');

        // High quality scaling
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

        // 4. Compress to Blob
        // Convert to blob is async and off-thread
        const compressedBlob = await canvas.convertToBlob({
            type: 'image/jpeg',
            quality: quality
        });

        // 5. Cleanup memory IMMEDIATELY (Critical for mobile)
        bitmap.close();
        bitmap = null;

        // 6. Return result using Transferable List
        // We transfer the arrayBuffer of the blob if possible, or just send the blob
        self.postMessage({ id, blob: compressedBlob, success: true });
    } catch (err) {
        if (bitmap) bitmap.close();
        self.postMessage({ id, error: err.message, success: false });
    }
};
