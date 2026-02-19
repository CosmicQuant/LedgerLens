
/*
 * compression.worker.js
 * Offloads image compression to a background thread using OffscreenCanvas.
 */

self.onmessage = async (e) => {
    const { file, maxWidth = 1920, quality = 0.6, id } = e.data;

    try {
        // 1. Create ImageBitmap (efficient decoding)
        // If file is already ImageBitmap, this clones it (fast)
        const bitmap = file instanceof ImageBitmap ? file : await createImageBitmap(file);

        // 2. Calculate dimensions
        let width = bitmap.width;
        let height = bitmap.height;

        if (width > maxWidth || height > maxWidth) {
            const ratio = maxWidth / Math.max(width, height);
            width *= ratio;
            height *= ratio;
        }

        // 3. Use OffscreenCanvas
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);

        // 4. Compress to Blob
        const blob = await canvas.convertToBlob({
            type: 'image/jpeg',
            quality: quality
        });

        // 5. Cleanup
        bitmap.close();

        // 6. Return result
        self.postMessage({ id, blob, success: true }, [blob]); // Transfer buffer
    } catch (err) {
        self.postMessage({ id, error: err.message, success: false });
    }
};
