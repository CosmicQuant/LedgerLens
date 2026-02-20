import { state } from './state.js';
import { db } from './firebase-init.js';
import { getIDB, saveReceiptToIDB } from './db.js';
import { uid } from './utils.js';
import { batchState } from './batch-state.js';
import { showToast, setBatchCompleted } from './ui.js';
import { scheduleUpload } from './sync.js';

// Generate a dummy receipt blob (Canvas -> JPEG)
async function generateDummyReceipt(index) {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 1500;
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1000, 1500);

    // Random Noise (to simulate texture/uniqueness)
    for (let i = 0; i < 500; i++) {
        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.1})`;
        ctx.fillRect(Math.random() * 1000, Math.random() * 1500, 2 + Math.random() * 5, 2 + Math.random() * 5);
    }

    // Text Content
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 60px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('STRESS TEST RECEIPT', 500, 200);
    ctx.font = '40px monospace';
    ctx.fillText(`ID: ${uid().toUpperCase()}`, 500, 300);
    ctx.fillText(`ITEM #${index + 1}`, 500, 400);
    ctx.fillText(`DATE: ${new Date().toISOString()}`, 500, 500);
    ctx.fillText('TOTAL: $99.99', 500, 700);

    // Footer
    ctx.font = '30px monospace';
    ctx.fillText('This is a generated test image', 500, 1400);

    return new Promise(resolve => {
        canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.6);
    });
}

// Run the stress test
export async function runStressTest(count = 10) {
    if (state.pendingCount > 0) {
        showToast('Please clear current batch first!', 'error');
        return;
    }

    const confirm = window.confirm(`⚠️ STRESS TEST WARNING ⚠️\n\nThis will generate and upload ${count} dummy receipts.\n\nIt consumes Gemini API quota.\n\nAre you sure?`);
    if (!confirm) return;

    showToast(`Generating ${count} receipts...`, 'info', 3000);

    // 1. Create a dedicated test batch
    const batchId = `STRESS_TEST_${uid()}`;
    state.setClientName("Stress Test Corp");
    state.setBatchId(batchId);

    // Reset UI
    batchState.reset();
    batchState.init(batchId, db);
    setBatchCompleted(false);

    // Create batch doc
    await db.collection('batches').doc(batchId).set({
        clientName: "Stress Test Corp",
        auditCycle: "Performance Test",
        ownerId: state.currentUser.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'active',
        receiptCount: 0,
        isStressTest: true
    });

    // 2. Generate and Save items (in parallel batches of 5 to avoid UI freeze)
    const chunkSize = 5;
    for (let i = 0; i < count; i += chunkSize) {
        const chunk = [];
        for (let j = 0; j < chunkSize && i + j < count; j++) {
            chunk.push((async () => {
                const blob = await generateDummyReceipt(i + j);
                const id = uid();
                await saveReceiptToIDB({
                    id: id,
                    batchId: batchId,
                    blob: blob,
                    thumbBlob: blob, // Reuse main blob as thumb for speed
                    status: 'pending_upload',
                    createdAt: Date.now()
                });
                // Optimistic increment for the stress test
                batchState.notifyBulkAdd(1);
            })());
        }
        await Promise.all(chunk);
        showToast(`Generated ${Math.min(i + chunkSize, count)}/${count}...`, 'info', 1000);
    }

    showToast(`Stress Test Started! Syncing ${count} items...`, 'success');

    // 3. Trigger Sync
    scheduleUpload();
}

// Cleanup all stress test data (Firestore + IDB)
export async function cleanupStressTests() {
    const confirm = window.confirm('🗑️ CLEANUP WARNING\n\nThis will permanently delete all "Stress Test" batches and receipts from the database.\n\nAre you sure?');
    if (!confirm) return;

    showToast('Scanning for test data...', 'info');

    try {
        // 1. Find all stress test batches
        const snapshot = await db.collection('batches')
            .where('isStressTest', '==', true)
            .get();

        if (snapshot.empty) {
            showToast('No stress test data found.', 'success');
            return;
        }

        let totalDeleted = 0;
        const totalBatches = snapshot.size;

        for (const batchDoc of snapshot.docs) {
            const batchId = batchDoc.id;

            // Delete all receipts in subcollection
            const receiptsSnapshot = await batchDoc.ref.collection('receipts').get();
            const deletePromises = receiptsSnapshot.docs.map(doc => doc.ref.delete());
            await Promise.all(deletePromises);

            // Delete batch doc
            await batchDoc.ref.delete();

            // Cleanup IDB (best effort)
            try {
                // If current batch is a stress test, reset it
                if (state.batchId === batchId) {
                    batchState.reset();
                    setBatchCompleted(true); // Close the session visually
                }
            } catch (e) { console.warn(e); }

            totalDeleted += receiptsSnapshot.size;
        }

        showToast(`Cleanup complete! Deleted ${totalBatches} batches and ${totalDeleted} receipts.`, 'success');

        // Refresh UI if needed
        if (state.batchId && state.batchId.startsWith('STRESS_TEST_')) {
            window.location.reload();
        }

    } catch (err) {
        console.error("Cleanup failed:", err);
        showToast('Cleanup failed. Check console.', 'error');
    }
}
