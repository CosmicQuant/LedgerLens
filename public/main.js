import { state } from './modules/state.js';
import { db, auth, storage } from './modules/firebase-init.js';
import { startCamera, stopCamera, captureFrame, generateThumbnail, blobToImage } from './modules/camera.js';
import { getIDB, saveReceiptToIDB, deleteReceiptFromIDB } from './modules/db.js';
import { DOM, showScreen, showToast, addThumbnailToQueue, updateFinishButton, updateThumbnailStatus, setBatchCompleted } from './modules/ui.js';
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
    if (Date.now() - sess.timestamp > 86400000) {
      localStorage.removeItem('ledgerlens_session');
      return false;
    }

    state.setClientName(sess.clientName);
    state.setBatchId(sess.batchId);

    DOM.lblClient.textContent = state.clientName;
    DOM.lblBatch.textContent = `Batch ${state.batchId.slice(0, 8)}…`;

    const database = await getIDB();
    const localReceipts = await database.getAllFromIndex('receipts', 'batchId', state.batchId);

    const remoteSnap = await db.collection('batches').doc(state.batchId)
      .collection('receipts').orderBy('uploadedAt', 'desc').get();

    const remoteReceipts = [];
    remoteSnap.forEach(doc => {
      if (!localReceipts.find(r => r.id === doc.id)) {
        remoteReceipts.push({ id: doc.id, ...doc.data() });
      }
    });

    const all = [...localReceipts, ...remoteReceipts];

    // Safer Sort: Handle mixed Timestamp/Number/Null
    const getTs = (r) => {
      if (r.createdAt) return r.createdAt;
      if (r.uploadedAt) {
        if (typeof r.uploadedAt.toMillis === 'function') return r.uploadedAt.toMillis();
        return r.uploadedAt; // probably a raw number
      }
      return 0;
    };
    all.sort((a, b) => getTs(b) - getTs(a));

    state.snapCounter = all.length;
    DOM.queueList.innerHTML = '';

    for (const r of all) {
      if (r.status === 'pending_upload' || r.status === 'uploading') state.pendingCount++;

      let thumbUrl;
      if (r.blob) {
        thumbUrl = URL.createObjectURL(r.blob);
        state.activeObjectURLs.set(r.id, thumbUrl);
      } else if (r.thumbBlob) {
        thumbUrl = URL.createObjectURL(r.thumbBlob);
        state.activeObjectURLs.set(r.id, thumbUrl);
      } else if (r.storageUrl) {
        thumbUrl = r.storageUrl;
      }

      let firestoreData = r.storageUrl ? r : null;
      let effectiveStatus = r.status || 'synced';
      if (r.extracted) effectiveStatus = 'extracted';
      if (r.status === 'error') effectiveStatus = 'error';

      addThumbnailToQueue(r.id, thumbUrl, effectiveStatus, firestoreData, deleteReceipt);
    }

    DOM.snapCount.textContent = state.snapCounter;
    showScreen(DOM.camera);
    setBatchCompleted(sess.status === 'completed');

    if (window.location.hash !== '#camera') {
      history.pushState({ screen: 'camera' }, 'Camera', '#camera');
    }

    // Camera initialization should NOT kill the whole restoration if it fails
    try {
      await startCamera(DOM.video, DOM.btnTorch);
    } catch (camErr) {
      console.error('Camera failed during restore:', camErr);
      showToast('Camera access failed, but batch restored.', 'error');
    }

    uploadPending();
    // Proactive check for stuck AI after restoration
    setTimeout(() => checkAndTriggerRetries(), 2000);
    return true;
  } catch (e) {
    console.warn('Session restore failed:', e);
    // Don't remove session immediately if it's a network error? 
    // But for now, let's keep it to prevent infinite redirect loops
    localStorage.removeItem('ledgerlens_session');
    return false;
  }
}

function resetApp(isPopState = false) {
  if (DOM.setup.classList.contains('active')) return;

  if (confirm('Exit current batch? Unsynced images will be kept in history.')) {
    stopCamera(DOM.video);
    state.reset();
    showScreen(DOM.setup);
    DOM.queueList.innerHTML = '<span class="queue-empty">Snap a receipt to begin</span>';
    setBatchCompleted(false);

    if (!isPopState && window.location.hash === '#camera') {
      history.back();
    } else if (isPopState && window.location.hash === '#camera') {
      history.replaceState({ screen: 'setup' }, 'Setup', '#setup');
    }
  } else {
    if (isPopState) {
      history.pushState({ screen: 'camera' }, 'Camera', '#camera');
    }
  }
}

// ────────────────────────────────────────────────────────
// Event Listeners
// ────────────────────────────────────────────────────────

// Handle Android Back Button (History API)
window.addEventListener('popstate', (event) => {
  // If the user was on the camera screen and hit the browser's back button
  if (DOM.camera.classList.contains('active') && window.location.hash !== '#camera') {
    resetApp(true);
  } else if (window.location.hash === '#camera' && !DOM.camera.classList.contains('active')) {
    // If they navigated FORWARD to #camera (unlikely via browser native UI but possible)
    tryRestoreSession();
  }
});

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
  setBatchCompleted(false);
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

  // Push history state so back button works
  history.pushState({ screen: 'camera' }, 'Camera', '#camera');

  showScreen(DOM.camera);
  await startCamera(DOM.video, DOM.btnTorch);
  showToast(`Batch started for ${cName}`, 'success');
});

// Snap Button
if (DOM.btnSnap) {
  DOM.btnSnap.onclick = async () => {
    if (state.snapCounter >= BATCH_MAX_IMAGES) {
      showToast('Batch limit reached', 'error');
      return;
    }

    const receiptId = uid();
    state.incrementSnap();
    state.pendingCount++;
    DOM.snapCount.textContent = state.snapCounter;

    // 1. Capture Full Image
    const fullBlob = await captureFrame(DOM.video);
    // 2. Capture/Generate Thumbnail
    const thumbBlob = await generateThumbnail(DOM.video, true);

    // Save to IDB
    await saveReceiptToIDB({
      id: receiptId,
      batchId: state.batchId,
      blob: fullBlob,
      thumbBlob: thumbBlob,
      status: 'pending_upload',
      createdAt: Date.now()
    });

    // Add to UI
    const thumbUrl = URL.createObjectURL(thumbBlob || fullBlob);
    state.activeObjectURLs.set(receiptId, thumbUrl);
    addThumbnailToQueue(receiptId, thumbUrl, 'pending_upload', null, deleteReceipt);

    updateFinishButton();
    uploadPending();
  };
}
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

    // Generate Thumbnail for the gallery image
    let thumbBlob = null;
    try {
      const img = await blobToImage(file);
      thumbBlob = await generateThumbnail(img, false);
      URL.revokeObjectURL(img.src); // Cleanup temp URL
    } catch (e) {
      console.warn("Gallery thumbnail generation failed:", e);
    }

    // Save to IDB
    await saveReceiptToIDB({
      id: receiptId,
      batchId: state.batchId,
      blob: file,
      thumbBlob: thumbBlob,
      status: 'pending_upload',
      createdAt: Date.now()
    });

    // Add to UI (prefer thumbBlob for queue)
    const displayUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : URL.createObjectURL(file);
    state.activeObjectURLs.set(receiptId, displayUrl);
    addThumbnailToQueue(receiptId, displayUrl, 'pending_upload', null, deleteReceipt);
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
    setBatchCompleted(true);
  } catch (err) {
    showToast('Failed to finalize batch', 'error');
  }
});

if (DOM.btnExport) {
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
}

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

        // ONLY auto-restore if explicitly #camera
        // This prevents reloads from root or setup from jumping to camera unexpectedly
        const shouldRestore = window.location.hash === '#camera';

        const restored = shouldRestore ? await tryRestoreSession() : false;

        if (restored) {
          startExtractionListener();
        } else if (window.location.hash === '#camera') {
          // If hash is #camera but session failed, go to setup
          showScreen(DOM.setup);
          history.replaceState({ screen: 'setup' }, 'Setup', '#setup');
        } else {
          // Normal flow
          showScreen(DOM.setup);
        }

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

if (DOM.btnGoogleLogin) {
  DOM.btnGoogleLogin.onclick = async () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(provider);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
}

if (DOM.btnLogout) {
  DOM.btnLogout.onclick = async () => {
    if (confirm('Sign out?')) {
      await auth.signOut();
      window.location.reload();
    }
  };
}

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
                    <span>${b.auditCycle || ''} • ${date} • <b>${b.receiptCount || 0} receipts</b></span>
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
        // Ensure we load with #camera so ensureAuth triggers restoration
        window.location.href = '#camera';
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
    // Logic moved inside ensureAuth to prevent flicker
  } catch (e) {
    console.error(e);
  }
})();

// Firestore Listener
function startExtractionListener() {
  if (!state.batchId || !state.currentUser) return;
  if (state.extractionUnsubscribe) state.extractionUnsubscribe();

  console.log('Listening for updates on batch:', state.batchId);

  // Listen to ALL receipts in this batch, not just extracted ones
  // This ensures we catch errors, processing states, and completions
  state.extractionUnsubscribe = db.collection('batches').doc(state.batchId)
    .collection('receipts')
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        const data = change.doc.data();
        const id = change.doc.id;
        console.log(`[Receipt Update] ${id}:`, data.status, data.extracted);

        if (change.type === 'added' || change.type === 'modified') {
          // Derive status strictly: prioritize "extracted" boolean
          const effectiveStatus = data.extracted ? 'extracted' : (data.status || 'synced');
          updateThumbnailStatus(id, effectiveStatus, data);
        }
      });
    }, err => {
      console.error("Listener failed:", err);
    });
}

// Camera Lifecycle
const cameraObserver = new MutationObserver(() => {
  if (DOM.camera.classList.contains('active')) {
    startExtractionListener();
    startAutoRetryCheck();
  } else {
    stopAutoRetryCheck();
  }
});
cameraObserver.observe(DOM.camera, { attributes: true, attributeFilter: ['class'] });

let autoRetryInterval = null;
function startAutoRetryCheck() {
  if (autoRetryInterval) return;
  autoRetryInterval = setInterval(() => checkAndTriggerRetries(), 30000);
}

async function checkAndTriggerRetries() {
  if (!state.batchId) return;

  const cards = document.querySelectorAll('.is-processing');
  const now = Date.now();

  for (const card of cards) {
    const data = card._firestoreData;
    if (!data) continue;

    const isStuckState = data.status === 'synced' || data.status === 'uploaded' || data.status === 'processing';
    if (!isStuckState || data.extracted === true) continue;

    const uploadedTime = data.uploadedAt ? data.uploadedAt.toMillis() : (data.createdAt || now);
    const diffMs = now - uploadedTime;

    if (diffMs > 120000 && data.status !== 'pending_retry') {
      const id = card.id.replace('q-', '');
      console.log(`[Auto-Retry] Triggering for ${id} (Stuck for ${Math.round(diffMs / 1000)}s)`);

      try {
        data.status = 'pending_retry';
        await db.collection('batches').doc(state.batchId)
          .collection('receipts').doc(id).update({
            status: 'pending_retry',
            autoRetryCount: firebase.firestore.FieldValue.increment(1),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
      } catch (err) {
        console.warn(`[Auto-Retry] Failed for ${id}:`, err);
      }
    }
  }
}

function stopAutoRetryCheck() {
  if (autoRetryInterval) {
    clearInterval(autoRetryInterval);
    autoRetryInterval = null;
  }
}
