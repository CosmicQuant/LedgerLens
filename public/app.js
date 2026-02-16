import { state } from './modules/state.js';
import { db, auth, storage } from './modules/firebase-init.js';
import { startCamera, stopCamera, captureFrame, captureThumbnail } from './modules/camera.js';
import { getIDB, saveReceiptToIDB, deleteReceiptFromIDB } from './modules/db.js';
import { DOM, showScreen, showToast, addThumbnailToQueue, updateFinishButton, updateThumbnailStatus } from './modules/ui.js';
import { uploadPending, scheduleUpload } from './modules/sync.js';
import { uid, sanitizeInput } from './modules/utils.js';

// ────────────────────────────────────────────────────────
// Session Management
// ────────────────────────────────────────────────────────
function saveSession(status = 'active') {
  localStorage.setItem('ledgerlens_session', JSON.stringify({
    clientName: state.clientName,
    batchId: state.batchId,
    status: status,
    timestamp: Date.now()
  }));
}

async function tryRestoreSession() {
  const raw = localStorage.getItem('ledgerlens_session');
  if (!raw) return false;

  try {
    const sess = JSON.parse(raw);
    // Expire after 24 hours
    if (Date.now() - sess.timestamp > 86400000) {
      localStorage.removeItem('ledgerlens_session');
      return false;
    }

    if (sess.status === 'completed') return false;

    state.setClientName(sess.clientName);
    state.setBatchId(sess.batchId);

    DOM.lblClient.textContent = state.clientName;
    DOM.lblBatch.textContent = `Batch ${state.batchId.slice(0, 8)}…`;

    // Restore Queue from IDB
    const database = await getIDB();
    const all = await database.getAllFromIndex('receipts', 'batchId', state.batchId);

    // Sort by creation time (descending)
    all.sort((a, b) => b.createdAt - a.createdAt);

    for (const r of all) {
      state.incrementSnap();
      if (r.status === 'pending_upload' || r.status === 'uploading') {
        state.pendingCount++;
      }

      let thumbUrl;
      if (r.blob) {
        // Check if we stored a separate thumbnail blob (future proofing) or just use the main blob
        thumbUrl = URL.createObjectURL(r.blob);
        state.activeObjectURLs.set(r.id, thumbUrl);
      } else if (r.thumbBlob) {
        thumbUrl = URL.createObjectURL(r.thumbBlob);
        state.activeObjectURLs.set(r.id, thumbUrl);
      }

      // Fetch firestore status if synced
      let firestoreData = null;
      if (r.status === 'synced' || r.status === 'extracted') {
        // We might want to fetch this async
        db.collection('batches').doc(state.batchId).collection('receipts').doc(r.id).get()
          .then(snap => {
            if (snap.exists) {
              updateThumbnailStatus(r.id, 'extracted', snap.data()); // Assuming extracted, or let listener handle it
            }
          });
      }

      addThumbnailToQueue(r.id, thumbUrl, r.status, firestoreData, deleteReceipt);
    }

    DOM.snapCount.textContent = state.snapCounter;
    showScreen(DOM.camera);
    await startCamera(DOM.video, DOM.btnTorch);
    updateFinishButton();

    // Trigger uploads
    uploadPending();

    return true;
  } catch (e) {
    console.warn('Session restore failed:', e);
    localStorage.removeItem('ledgerlens_session');
    return false;
  }
}

function resetApp() {
  if (confirm('Exit current batch? Unsynced images will be kept in history.')) {
    stopCamera(DOM.video);
    state.reset();
    showScreen(DOM.setup);
    DOM.queueList.innerHTML = '<span class="queue-empty">Snap a receipt to begin</span>';
    DOM.btnExport.style.display = 'none';
    DOM.btnFinish.style.display = 'flex';
  }
}

// ────────────────────────────────────────────────────────
// Event Listeners
// ────────────────────────────────────────────────────────

// Setup Form
DOM.formSetup.addEventListener('submit', async (e) => {
  e.preventDefault();

  const cName = sanitizeInput(DOM.inputClient.value);
  const cycle = sanitizeInput(DOM.inputCycle.value);

  if (!cName || !cycle) {
    showToast('Please enter valid names', 'error');
    return;
  }

  state.setClientName(cName);
  const newBatchId = `${cName.replace(/\s+/g, '_')}_${cycle.replace(/\s+/g, '_')}_${uid()}`;
  state.setBatchId(newBatchId);

  saveSession();

  // Clear UI
  DOM.queueList.innerHTML = '';
  state.snapCounter = 0;
  state.pendingCount = 0;
  DOM.snapCount.textContent = '0';
  DOM.btnExport.style.display = 'none';
  DOM.btnFinish.style.display = 'flex';
  DOM.btnFinish.disabled = true;

  // Create batch in Firestore
  try {
    await db.collection('batches').doc(newBatchId).set({
      clientName: cName,
      auditCycle: cycle,
      ownerId: state.currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'active',
      receiptCount: 0
    });
  } catch (err) {
    console.warn('Firestore batch create deferred (offline):', err);
  }

  DOM.lblClient.textContent = cName;
  DOM.lblBatch.textContent = `Batch ${newBatchId.slice(0, 8)}…`;

  showScreen(DOM.camera);
  await startCamera(DOM.video, DOM.btnTorch);
  showToast(`Batch started for ${cName}`, 'success');
});

// Snap Button
const BATCH_MAX_IMAGES = 100;
const MAX_GALLERY_UPLOAD = 20; // New limit for gallery uploads

// Gallery Button
const $btnGallery = document.getElementById('btn-gallery');
const $inputBulk = document.getElementById('input-bulk');

if ($btnGallery) {
  $btnGallery.addEventListener('click', () => {
    $inputBulk.click();
  });
}

if ($inputBulk) {
  $inputBulk.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    // Limit Check
    if (files.length > MAX_GALLERY_UPLOAD) {
      showToast(`Please select up to ${MAX_GALLERY_UPLOAD} images at a time.`, 'error');
      $inputBulk.value = '';
      return;
    }

    if (state.snapCounter + files.length > BATCH_MAX_IMAGES) {
      showToast(`Cannot add ${files.length} images. Batch limit is ${BATCH_MAX_IMAGES}.`, 'error');
      $inputBulk.value = '';
      return;
    }

    $inputBulk.value = ''; // Reset for next selection
    handleBulkUpload(files);
  });
}

async function handleBulkUpload(files) {
  showToast(`Processing ${files.length} images…`, 'info');

  for (const file of files) {
    if (state.snapCounter >= BATCH_MAX_IMAGES) break;

    const receiptId = uid();
    state.incrementSnap();
    state.pendingCount++;
    DOM.snapCount.textContent = state.snapCounter;

    // Save to IDB
    // For gallery uploads, we use the file itself as the blob
    // Optionally create a thumbnail blob if performance is needed, but for now reuse file
    await saveReceiptToIDB({
      id: receiptId,
      batchId: state.batchId,
      blob: file,
      // thumbBlob: file, // Could resize here if needed
      status: 'pending_upload',
      createdAt: Date.now()
    });

    // Add to UI
    const thumbUrl = URL.createObjectURL(file);
    state.activeObjectURLs.set(receiptId, thumbUrl);
    addThumbnailToQueue(receiptId, thumbUrl, 'pending_upload', null, deleteReceipt);
  }

  updateFinishButton();
  uploadPending();
}

// Delete Receipt
async function deleteReceipt(id) {
  if (!confirm('Delete this receipt permanently?')) return;

  const card = document.getElementById(`q-${id}`);
  const storagePath = card?._firestoreData?.storagePath;

  try {
    if (storagePath) await storage.ref(storagePath).delete();

    await db.collection('batches').doc(state.batchId)
      .collection('receipts').doc(id).delete();

    await deleteReceiptFromIDB(id);

    if (state.activeObjectURLs.has(id)) {
      URL.revokeObjectURL(state.activeObjectURLs.get(id));
      state.activeObjectURLs.delete(id);
    }
    if (card) card.remove();

    state.decrementSnap();
    DOM.snapCount.textContent = state.snapCounter;
    showToast('Receipt deleted', 'info');

    if (DOM.queueList.children.length === 0) {
      DOM.queueList.innerHTML = '<span class="queue-empty">Snap a receipt to begin</span>';
    }
  } catch (err) {
    console.error('Delete failed:', err);
    showToast('Failed to delete resource', 'error');
  }
}

// Finish Batch
DOM.btnFinish.addEventListener('click', async () => {
  if (!confirm(`Finish batch for "${state.clientName}"?`)) return;

  try {
    await db.collection('batches').doc(state.batchId).update({
      status: 'completed',
      completedAt: firebase.firestore.FieldValue.serverTimestamp(),
      totalReceipts: state.snapCounter
    });
    saveSession('completed');
    showToast('Batch completed ✓', 'success');
    DOM.btnFinish.style.display = 'none';
    DOM.btnExport.style.display = 'flex';
  } catch (err) {
    showToast('Failed to finalize batch', 'error');
  }
});

// Export
DOM.btnExport.addEventListener('click', async () => {
  // 1. Smart Guard: Check for processing items
  const processingCount = document.querySelectorAll('.is-processing').length;
  if (processingCount > 0 || state.pendingCount > 0) {
    alert(`Wait! AI is still labeling ${processingCount || state.pendingCount} receipts.\n\nPlease wait for the "AI Processing" badges to disappear before exporting.`);
    return;
  }

  showToast('Generating Excel report…', 'info', 5000);
  try {
    const idToken = await state.currentUser.getIdToken(true);
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ batch_id: state.batchId })
    });

    if (!response.ok) throw new Error(`Export failed (${response.status})`);

    const result = await response.json();
    if (result.download_url) {
      window.open(result.download_url, '_blank');
      showToast('Excel report ready!', 'success');
    }
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
});

// Auth & Init
async function ensureAuth() {
  return new Promise((resolve, reject) => {
    // 1. Show nothing (handled by CSS body.visibility: hidden)

    auth.onAuthStateChanged(async (user) => {
      // 2. Determine state
      if (user) {
        state.currentUser = user;
        DOM.userProfile.style.display = 'flex';
        DOM.userDisplayEmail.textContent = user.email || user.displayName;
        showScreen(DOM.setup); // Show Home/Setup
        resolve(user);
      } else {
        state.currentUser = null;
        DOM.userProfile.style.display = 'none';
        showScreen(DOM.authScreen); // Show Login
        // reject('Auth required'); 
      }

      // 3. Reveal App (Fade in)
      document.body.classList.add('loaded');
    });
  });
}

DOM.btnGoogleLogin.onclick = async () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

DOM.btnLogout.onclick = async () => {
  if (confirm('Sign out?')) {
    await auth.signOut();
    window.location.reload();
  }
};

// ────────────────────────────────────────────────────────
// 14. Back / End Session (Fixed)
// ────────────────────────────────────────────────────────
// Ensure the back button calls resetApp properly
if (DOM.btnBack) {
  DOM.btnBack.addEventListener('click', (e) => {
    e.preventDefault(); // Prevent any default anchor behavior
    console.log('Back button clicked');
    resetApp();
  });
}
if (DOM.btnResetSession) {
  DOM.btnResetSession.addEventListener('click', (e) => {
    e.preventDefault();
    resetApp();
  });
}

// History
if (DOM.btnHistory) {
  DOM.btnHistory.addEventListener('click', showHistory);
}

async function showHistory() {
  const historyOverlay = document.createElement('div');
  historyOverlay.className = 'history-overlay active';
  historyOverlay.innerHTML = `
      <div class="history-content">
        <div class="history-header">
          <h2>Past Batches</h2>
          <button id="btn-close-history"><span class="material-symbols-rounded">close</span></button>
        </div>
        <div id="history-list" class="history-list">
          <p class="loading">Loading batches…</p>
        </div>
      </div>
    `;
  document.body.appendChild(historyOverlay);
  document.getElementById('btn-close-history').onclick = () => historyOverlay.remove();

  try {
    const snap = await db.collection('batches')
      .where('ownerId', '==', state.currentUser.uid)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const list = document.getElementById('history-list');
    list.innerHTML = '';
    if (snap.empty) {
      list.innerHTML = '<p class="empty">No past batches found.</p>';
      return;
    }

    snap.forEach(doc => {
      const b = doc.data();
      const date = b.createdAt ? b.createdAt.toDate().toLocaleDateString() : 'Unknown';
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
                <div class="info">
                    <strong>${b.clientName || 'Unnamed'}</strong>
                    <span>${b.auditCycle || ''} • ${date}</span>
                </div>
                <div class="actions">
                    <button class="btn-restore">Restore</button>
                    <button class="btn-batch-del" title="Delete Batch" style="color: var(--danger); margin-left: 8px;">
                        <span class="material-symbols-rounded">delete</span>
                    </button>
                </div>
            `;
      item.querySelector('.btn-restore').onclick = () => {
        if (!confirm('Restore this batch?')) return;
        state.setClientName(b.clientName);
        state.setBatchId(doc.id);
        saveSession(b.status || 'active');
        window.location.reload();
      };
      item.querySelector('.btn-batch-del').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Permanently delete batch "${b.clientName || 'Batch'}" and all its images? This cannot be undone.`)) return;

        // Optimistic UI removal
        item.remove();

        try {
          const batchRef = db.collection('batches').doc(doc.id);
          const receiptsSnap = await batchRef.collection('receipts').get();

          const batch = db.batch();

          // 1. Delete Images from Storage (Parallel)
          const deletionPromises = [];
          receiptsSnap.forEach(r => {
            const data = r.data();
            if (data.storagePath) {
              const imageRef = storage.ref(data.storagePath);
              deletionPromises.push(imageRef.delete().catch(err => {
                console.warn(`Failed to delete image ${data.storagePath}:`, err);
                // Continue even if one fails
              }));
            }
            // 2. Queue Firestore Deletion
            batch.delete(r.ref);
          });

          // Wait for all storage deletions
          await Promise.all(deletionPromises);

          // 3. Commit Firestore Deletion
          batch.delete(batchRef);
          await batch.commit();

          showToast('Batch and images deleted', 'success');
        } catch (err) {
          console.error(err);
          showToast('Failed to delete batch', 'error');
          // Restore item if failed (simplified, just reload list)
          showHistory();
        }
      };
      list.appendChild(item);
    });

  } catch (e) {
    document.getElementById('history-list').innerHTML = `<p class="error">${e.message}</p>`;
  }
}

// ────────────────────────────────────────────────────────
// Initialization
// ────────────────────────────────────────────────────────
(async function init() {
  // Theme
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  DOM.btnTheme.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const newTheme = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
  });

  try {
    await ensureAuth();
    const restored = await tryRestoreSession();
    if (restored) {
      startExtractionListener();
    } else {
      showScreen(DOM.setup);
    }
  } catch (e) {
    console.error(e);
  }
})();

// Firestore Listener
function startExtractionListener() {
  if (!state.batchId || !state.currentUser) return;
  if (state.extractionUnsubscribe) state.extractionUnsubscribe();

  state.extractionUnsubscribe = db.collection('batches').doc(state.batchId)
    .collection('receipts')
    .where('extracted', '==', true)
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added' || change.type === 'modified') {
          updateThumbnailStatus(change.doc.id, 'extracted', change.doc.data());
        }
      });
    });
}

// Camera Lifecycle
const cameraObserver = new MutationObserver(() => {
  if (DOM.camera.classList.contains('active')) {
    startExtractionListener();
  }
});
cameraObserver.observe(DOM.camera, { attributes: true, attributeFilter: ['class'] });
