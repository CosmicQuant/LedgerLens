import { state } from './modules/state.js';
import { db, auth, storage } from './modules/firebase-init.js';
import { startCamera, stopCamera, captureFrame } from './modules/camera.js';
import { getIDB, saveReceiptToIDB, deleteReceiptFromIDB } from './modules/db.js';
import { DOM, showScreen, showToast, addThumbnailToQueue, updateFinishButton, updateThumbnailStatus, setBatchCompleted, updateUsageMeter, showLoader, hideLoader, showNotification } from './modules/ui.js';
import { uploader } from './modules/uploader.js';
import { uid, sanitizeInput } from './modules/utils.js';
import { batchState } from './modules/batch-state.js';
import { startWatchdog, stopWatchdog } from './modules/watchdog.js';

// ────────────────────────────────────────────────────────
// BatchStateManager → UI Binding
// ────────────────────────────────────────────────────────
batchState.subscribe((payload) => {
  updateUsageMeter(payload);
  updateFinishButton(payload.totalCount, payload.pendingCount);
});

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
    batchState.init(sess.batchId, db);

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

    // Sort: Handle mixed Timestamp/Number/Null
    const getTs = (r) => {
      if (r.createdAt) return r.createdAt;
      if (r.uploadedAt) {
        if (typeof r.uploadedAt.toMillis === 'function') return r.uploadedAt.toMillis();
        return r.uploadedAt;
      }
      return 0;
    };
    all.sort((a, b) => getTs(b) - getTs(a));

    DOM.queueList.innerHTML = '';

    for (const r of all) {
      // let thumbUrl;

      let thumbUrl;
      if (r.thumbBlob) {
        thumbUrl = URL.createObjectURL(r.thumbBlob);
        state.activeObjectURLs.set(r.id, thumbUrl);
      } else if (r.blob) {
        thumbUrl = URL.createObjectURL(r.blob);
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

    // Use BatchStateManager for authoritative count
    await batchState.recalculate();

    console.log(`[Restore] Displaying ${all.length} items. UI Screen: Camera.`);
    showScreen(DOM.camera);
    setBatchCompleted(sess.status === 'completed');

    if (window.location.hash !== '#camera') {
      history.pushState({ screen: 'camera' }, 'Camera', '#camera');
    }

    try {
      await startCamera(DOM.video, DOM.btnTorch);
    } catch (camErr) {
      console.error('[Restore] Camera failed:', camErr);
      showToast('Camera access failed, but batch restored.', 'error');
    }

    uploader.processConveyorBelt();
    return true;
  } catch (e) {
    console.warn('Session restore failed:', e);
    localStorage.removeItem('ledgerlens_session');
    return false;
  }
}

function resetApp(isPopState = false) {
  if (DOM.setup.classList.contains('active')) return;

  if (confirm('Exit current batch? Unsynced images will be kept in history.')) {
    stopCamera(DOM.video);
    stopWatchdog();
    state.reset();
    batchState.reset();
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
  console.log('[History] Popstate:', window.location.hash);
  // If user hits 'back' from camera screen
  if (DOM.camera.classList.contains('active') && window.location.hash !== '#camera') {
    // Only reset if they are actually moving AWAY from camera
    if (window.location.hash === '' || window.location.hash === '#setup') {
      resetApp(true);
    }
  } else if (window.location.hash === '#camera' && !DOM.camera.classList.contains('active')) {
    tryRestoreSession();
  }
});

// Setup Form
// Setup Form
// Setup Form
DOM.formSetup.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (DOM.btnStart) DOM.btnStart.disabled = true;
  showLoader('Setting up batch...');

  try {
    const cName = sanitizeInput(DOM.inputClient.value);
    const rawCategories = (DOM.inputCategories.value || '').trim();

    if (!cName) {
      showToast('Please enter a company name', 'error');
      return;
    }

    // Parse comma-separated categories into array (filter empty)
    const customCategories = rawCategories
      ? rawCategories.split(',').map(c => c.trim()).filter(c => c.length > 0)
      : null;

    state.setClientName(cName);
    const newBatchId = `${cName.replace(/\s+/g, '_')}_${uid()}`;
    state.setBatchId(newBatchId);
    batchState.init(newBatchId, db);

    saveSession();

    // Clear UI
    DOM.queueList.innerHTML = '';
    state.pendingCount = 0;
    batchState.reset();
    batchState.init(newBatchId, db);
    setBatchCompleted(false);

    // Create batch in Firestore
    try {
      const batchDoc = {
        clientName: cName,
        ownerId: state.currentUser.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'active',
        receiptCount: 0
      };
      // Only store custom categories if provided
      if (customCategories && customCategories.length > 0) {
        batchDoc.expenseCategories = customCategories;
      }
      await db.collection('batches').doc(newBatchId).set(batchDoc);
    } catch (err) {
      console.warn('Firestore batch create deferred (offline):', err);
    }

    DOM.lblClient.textContent = cName;
    DOM.lblBatch.textContent = `Batch ${newBatchId.slice(0, 8)}…`;

    // Push history state so back button works
    history.pushState({ screen: 'camera' }, 'Camera', '#camera');

    showScreen(DOM.camera);
    await startCamera(DOM.video, DOM.btnTorch);

    // Start Listeners
    startExtractionListener();
    startWatchdog();

    showToast(`Batch started for ${cName}`, 'success');
  } catch (err) {
    showToast(`Setup failed: ${err.message}`, 'error');
    console.error(err);
  } finally {
    hideLoader();
    if (DOM.btnStart) DOM.btnStart.disabled = false;
  }
});

const MAX_GALLERY_UPLOAD = 100;

// Snap Button
if (DOM.btnSnap) {
  DOM.btnSnap.onclick = async () => {
    if (batchState.isAtLimit) {
      showToast('Batch Limit Reached. Please Finish this batch.', 'error');
      return;
    }

    try {
      const fullBlob = await captureFrame(DOM.video);
      if (!fullBlob) throw new Error('Capture failed');

      // Hand over to the Unified Pipeline
      uploader.handleFiles([fullBlob]);
    } catch (err) {
      console.error("[Shutter] A++ Capture Failure:", err);
      showToast('Capture error. Trying anyway...', 'warning');
    }
  };
}

// Gallery Button
const $btnGallery = document.getElementById('btn-gallery');
const $inputBulk = document.getElementById('input-bulk');

if ($btnGallery) {
  $btnGallery.addEventListener('click', () => {
    showToast('Opening Gallery...', 'info');
    $btnGallery.disabled = true;
    setTimeout(() => $btnGallery.disabled = false, 3000);
    $inputBulk.click();
  });
}

if ($inputBulk) {
  $inputBulk.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    if (files.length > MAX_GALLERY_UPLOAD) {
      showToast('Max 100 images per selection', 'warning');
      $inputBulk.value = '';
      return;
    }

    if (files.length > batchState.remaining) {
      showToast(`Batch limit reached. Only ${batchState.remaining} slots left.`, 'error');
      $inputBulk.value = '';
      return;
    }

    // Do NOT clear $inputBulk.value = ''; here! 
    // On Android Chrome, clearing the input can invalidate the File handles 
    // before the async pipeline can process them.
    uploader.handleFiles(files);
  });
}

// Queue State










// Delete Receipt
async function deleteReceipt(id) {
  if (!confirm('Delete this receipt permanently?')) return;

  const card = document.getElementById(`q-${id}`);
  const storagePath = card?._firestoreData?.storagePath;

  try {
    if (storagePath) {
      await storage.ref(storagePath).delete();
      // Decrement batch count (syncs with History list)
      await db.collection('batches').doc(state.batchId).update({
        uploadedCount: firebase.firestore.FieldValue.increment(-1)
      });
    }

    await db.collection('batches').doc(state.batchId)
      .collection('receipts').doc(id).delete();

    await deleteReceiptFromIDB(id);

    if (state.activeObjectURLs.has(id)) {
      URL.revokeObjectURL(state.activeObjectURLs.get(id));
      state.activeObjectURLs.delete(id);
    }
    if (card) card.remove();

    batchState.notifyDelete();
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
      totalReceipts: batchState.totalCount
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
    if (processingCount > 0 || batchState.pendingCount > 0) {
      alert(`Wait! AI is still labeling ${processingCount || batchState.pendingCount} receipts.\n\nPlease wait for the "AI Processing" badges to disappear before exporting.`);
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
        showToast('Excel report ready! Downloading…', 'success');

        // Safari/iOS blocks target=_blank and link.click() in async callbacks.
        // Use window.location.href for maximum compatibility — the Firebase
        // Storage URL returns Content-Disposition: attachment, so it downloads
        // instead of navigating away.
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

        if (isSafari) {
          // Safari: direct navigation (won't leave page for file downloads)
          window.location.href = result.download_url;
        } else {
          // Chrome/Firefox: hidden link with download attribute
          const link = document.createElement('a');
          link.href = result.download_url;
          link.download = `LedgerLens_Report.xlsx`;
          link.rel = 'noopener';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
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
        const shouldRestore = window.location.hash === '#camera';

        // UX: Show loader immediately if we expect to restore
        if (shouldRestore && localStorage.getItem('ledgerlens_session')) {
          showLoader('Resuming session...');
        }

        const restored = shouldRestore ? await tryRestoreSession() : false;

        hideLoader(); // Clear loader

        if (restored) {
          startExtractionListener();
          startWatchdog();
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
      const catInfo = b.expenseCategories
        ? `${b.expenseCategories.length} custom categories`
        : (b.auditCycle || 'Default categories');
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
                <div class="info">
                    <strong>${b.clientName || 'Unnamed'}</strong>
                    <span>${catInfo} &bull; ${date} &bull; <b>${b.uploadedCount || b.receiptCount || 0} receipts</b></span>
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
        showLoader('Restoring session...');
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
  // Theme logic removed - app is now permanently light.

  try {
    uploader.setDeleteCallback(deleteReceipt);
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
  autoRetryInterval = setInterval(() => checkAndTriggerRetries(), 10000);
}

async function checkAndTriggerRetries() {
  if (!state.batchId) return;

  const cards = document.querySelectorAll('.is-processing');
  const now = Date.now();

  for (const card of cards) {
    const data = card._firestoreData;
    if (!data) continue;

    const isStuckState = data.status === 'synced' || data.status === 'uploaded' || data.status === 'processing' || data.status === 'error';
    if (!isStuckState || data.extracted === true) continue;

    const uploadedTime = data.uploadedAt ? (typeof data.uploadedAt.toMillis === 'function' ? data.uploadedAt.toMillis() : data.uploadedAt) : (data.createdAt || now);
    const diffMs = now - uploadedTime;

    // Retry after 20s stuck (reduced from 60s for speed)
    if (diffMs > 20000 && data.status !== 'pending_retry') {
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
