import { state } from './state.js';
import { db as firestore, storage } from './firebase-init.js';
import { getPendingUploads, saveReceiptToIDB, deleteReceiptFromIDB } from './db.js';
import { DOM, showToast, updateThumbnailStatus, updateFinishButton } from './ui.js';

export async function uploadPending() {
    if (state.isUploading) return;
    state.isUploading = true;
    DOM.syncInd.classList.add('uploading');

    const pending = await getPendingUploads(state.batchId);

    // If nothing to upload, schedule next check and exit
    if (pending.length === 0) {
        state.isUploading = false;
        DOM.syncInd.classList.remove('uploading');
        scheduleUpload(15000); // idle check
        return;
    }

    for (const receipt of pending) {
        try {
            // Mark uploading
            receipt.status = 'uploading';
            await saveReceiptToIDB(receipt);
            updateThumbnailStatus(receipt.id, 'uploading');

            // Upload WebP blob to Firebase Storage with Progress
            const storagePath = `receipts/${state.batchId}/${receipt.id}.webp`;
            const ref = storage.ref(storagePath);
            const task = ref.put(receipt.blob, { contentType: 'image/webp' });

            // Promisify the upload task
            await new Promise((resolve, reject) => {
                task.on('state_changed',
                    (snapshot) => {
                        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                        updateThumbnailStatus(receipt.id, 'uploading', null, progress);
                    },
                    (error) => reject(error),
                    () => resolve()
                );
            });

            const downloadUrl = await task.snapshot.ref.getDownloadURL();

            // Write metadata to Firestore
            await firestore.collection('batches').doc(state.batchId)
                .collection('receipts').doc(receipt.id).set({
                    storageUrl: downloadUrl,
                    storagePath: storagePath,
                    file_path: storagePath, // For compatibility
                    file_extension: 'webp',
                    status: 'synced',
                    extracted: false,
                    uploadedAt: firebase.firestore.FieldValue.serverTimestamp()
                });

            // ── DELETE-ON-SUCCESS ──────────────────────────────
            // Blob confirmed in Firebase Storage → purge from IDB to free memory.
            await deleteReceiptFromIDB(receipt.id);

            // Update the card's firestore data
            const card = document.getElementById(`q-${receipt.id}`);
            if (card) {
                card._firestoreData = {
                    storageUrl: downloadUrl,
                    storagePath: storagePath,
                    status: 'synced'
                };
                // NOTE: We keep showing the local ObjectURL (thumbnail) to avoid flicker.
                // The remote storageUrl is now stored in _firestoreData for previews.
            }

            state.pendingCount = Math.max(0, state.pendingCount - 1);
            updateThumbnailStatus(receipt.id, 'synced');

            // Success? Reset backoff
            state.uploadRetryDelay = 15000;

        } catch (err) {
            console.error(`Upload failed for ${receipt.id}:`, err);
            receipt.status = 'pending_upload';
            await saveReceiptToIDB(receipt);
            updateThumbnailStatus(receipt.id, 'pending_upload');

            // Exponential Backoff
            state.uploadRetryDelay = Math.min(state.uploadRetryDelay * 1.5, 300000); // cap at 5 mins
            console.log(`Backing off upload for ${state.uploadRetryDelay}ms`);
            break; // stop queue
        }
    }

    state.isUploading = false;
    DOM.syncInd.classList.remove('uploading');
    updateFinishButton();

    // Schedule next run
    scheduleUpload(pending.length > 0 ? 1000 : state.uploadRetryDelay);
}

export function scheduleUpload(delay) {
    if (state.uploadTimer) clearTimeout(state.uploadTimer);
    state.uploadTimer = setTimeout(() => uploadPending(), delay);
}
