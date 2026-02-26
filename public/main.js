import { state } from './modules/state.js';
import { db, auth, storage } from './modules/firebase-init.js';
import { startCamera, stopCamera, captureFrame } from './modules/camera.js';
import { getIDB, saveReceiptToIDB, deleteReceiptFromIDB, clearIDBForBatch } from './modules/db.js';
import { DOM, showScreen, showToast, addThumbnailToQueue, updateThumbnailStatus, updateUsageMeter, showLoader, hideLoader, showNotification, showConfirm } from './modules/ui.js';
import { uploader } from './modules/uploader.js';
import { uid, sanitizeInput, escapeHtml } from './modules/utils.js';
import { batchState } from './modules/batch-state.js';
import { startWatchdog, stopWatchdog } from './modules/watchdog.js';

// ────────────────────────────────────────────────────────
// BatchStateManager → UI Binding
// ────────────────────────────────────────────────────────
batchState.subscribe((payload) => {
  updateUsageMeter(payload);
  if (DOM.btnExport) {
    const processingCount = document.querySelectorAll('.is-processing').length;
    const busy = payload.totalCount === 0 || payload.pendingCount > 0 || processingCount > 0;
    DOM.btnExport.disabled = busy;
  }
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

    // Purge IDB zombies: any item left in IDB from a previous session is a failed 
    // or interrupted upload. Since we don't have a resume mechanism, we must 
    // clear them to prevent them from permanently inflating counts.
    await clearIDBForBatch(sess.batchId);

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

    // Clean up any pending IDB files before leaving
    if (state.batchId) clearIDBForBatch(state.batchId);

    state.reset();
    batchState.reset();
    showScreen(DOM.setup);
    DOM.queueList.innerHTML = '<span class="queue-empty">Snap a receipt to begin</span>';

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

// Snap Button (with debounce to prevent DOMException from rapid taps)
let _shutterBusy = false;
if (DOM.btnSnap) {
  DOM.btnSnap.onclick = async () => {
    // Debounce: prevent overlapping captures on rapid taps
    if (_shutterBusy) return;
    _shutterBusy = true;
    DOM.btnSnap.classList.add('disabled');
    setTimeout(() => {
      _shutterBusy = false;
      DOM.btnSnap.classList.remove('disabled');
    }, 800);

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
    if ($btnGallery.disabled) return;
    showToast('Opening Gallery...', 'info');
    $inputBulk.click();
  });
}

if ($inputBulk) {
  $inputBulk.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    if (files.length > batchState.remaining) {
      showToast(`Batch limit reached. Only ${batchState.remaining} slots left.`, 'error');
      $inputBulk.value = '';
      return;
    }

    // SAFETY LOCK: Disable gallery button during vault-save
    // Prevents double-selection while blobs are being read + saved to IDB
    if ($btnGallery) {
      $btnGallery.disabled = true;
      $btnGallery.classList.add('is-vaulting');
    }

    try {
      // handleFiles reads files + vault-saves to IDB + kicks off conveyor
      // It resolves when ALL blobs are safely in IDB (Phase 1 + Phase 2 complete)
      await uploader.handleFiles(files);
    } finally {
      // RE-ENABLE: All blobs are in IDB, RAM is released, safe to select more
      if ($btnGallery) {
        $btnGallery.disabled = false;
        $btnGallery.classList.remove('is-vaulting');
      }
    }
  });
}

// Queue State










// Delete Receipt
async function deleteReceipt(id) {
  if (!confirm('Delete this receipt permanently?')) return;

  // PILLAR 8: Pre-emptive Task Cancellation
  uploader.cancelJob(id);

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

// Map the UI delete buttons to the Pipeline
uploader.setDeleteCallback(deleteReceipt);

// Finish Batch
if (DOM.btnExport) {
  DOM.btnExport.addEventListener('click', async () => {
    // 1. Smart Guard: Check for processing items
    const processingCount = document.querySelectorAll('.is-processing').length;
    if (processingCount > 0 || batchState.pendingCount > 0) {
      alert(`Wait! AI is still labeling ${processingCount || batchState.pendingCount} receipts.\n\nPlease wait for the "AI Processing" badges to disappear before exporting.`);
      return;
    }

    try {
      await db.collection('batches').doc(state.batchId).update({
        status: 'completed',
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        totalReceipts: batchState.totalCount
      });
      saveSession('completed');
    } catch (err) {
      console.warn('Failed to update batch completed status:', err);
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
  const PAGE_SIZE = 20;
  let lastDoc = null;    // Firestore cursor for pagination
  let isLoading = false;

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

  const list = document.getElementById('history-list');

  // ── Render a single batch item ──
  function renderBatchItem(doc) {
    const b = doc.data();
    const date = b.createdAt ? b.createdAt.toDate().toLocaleDateString() : 'Unknown';
    const catInfo = b.expenseCategories
      ? `${b.expenseCategories.length} custom categories`
      : (b.auditCycle || 'Default categories');
    const item = document.createElement('div');
    item.className = 'history-item';

    // XSS-safe: Use textContent for user-controlled fields instead of innerHTML
    const infoDiv = document.createElement('div');
    infoDiv.className = 'info';
    const nameEl = document.createElement('strong');
    nameEl.textContent = b.clientName || 'Unnamed';
    const detailEl = document.createElement('span');
    const receiptCount = b.uploadedCount || b.receiptCount || 0;
    detailEl.innerHTML = `${escapeHtml(catInfo)} &bull; ${escapeHtml(date)} &bull; <b>${receiptCount} receipts</b>`;
    infoDiv.appendChild(nameEl);
    infoDiv.appendChild(detailEl);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'actions';
    actionsDiv.innerHTML = `
        <button class="btn-restore">Restore</button>
        <button class="btn-batch-del" title="Delete Batch" style="color: var(--danger); margin-left: 8px;">
            <span class="material-symbols-rounded">delete</span>
        </button>
    `;

    item.appendChild(infoDiv);
    item.appendChild(actionsDiv);
    item.querySelector('.btn-restore').onclick = async () => {
      const confirmed = await showConfirm('Restore Batch', `Restore batch "${b.clientName || 'Unnamed'}"? This will replace your current session.`, 'Restore', 'primary');
      if (!confirmed) return;
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
      const confirmed = await showConfirm('Delete Batch', `Permanently delete batch "${b.clientName || 'Batch'}" and all its images? This cannot be undone.`, 'Delete', 'danger');
      if (!confirmed) return;

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
      }
    };
    return item;
  }

  // ── Load a page of batches ──
  async function loadPage() {
    if (isLoading) return;
    isLoading = true;

    // Remove existing "Load More" button if present
    const existingBtn = list.querySelector('.btn-load-more');
    if (existingBtn) existingBtn.remove();

    try {
      let query = db.collection('batches')
        .where('ownerId', '==', state.currentUser.uid)
        .orderBy('createdAt', 'desc')
        .limit(PAGE_SIZE);

      // Cursor: start after the last document from the previous page
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snap = await query.get();

      // First page: clear the loading indicator
      if (!lastDoc) {
        list.innerHTML = '';
        if (snap.empty) {
          list.innerHTML = '<p class="empty">No past batches found.</p>';
          return;
        }
      }

      // Render each batch item
      snap.forEach(doc => {
        list.appendChild(renderBatchItem(doc));
      });

      // Save the cursor for the next page
      lastDoc = snap.docs[snap.docs.length - 1];

      // Show "Load More" if we got a full page (more may exist)
      if (snap.size === PAGE_SIZE) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'btn-load-more';
        loadMoreBtn.textContent = 'Load More';
        loadMoreBtn.onclick = () => loadPage();
        list.appendChild(loadMoreBtn);
      }

    } catch (e) {
      const errEl = document.createElement('p');
      errEl.className = 'error';
      errEl.textContent = e.message;
      list.appendChild(errEl);
    } finally {
      isLoading = false;
    }
  }

  // Load the first page
  await loadPage();
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

          // Re-evaluate Export button (processing cards may have just finished)
          if (DOM.btnExport) {
            const stillProcessing = document.querySelectorAll('.is-processing').length;
            DOM.btnExport.disabled = (batchState.totalCount === 0 || batchState.pendingCount > 0 || stillProcessing > 0);
          }
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
    // Retry logic is handled solely by watchdog.js (unified system)
  }
});
cameraObserver.observe(DOM.camera, { attributes: true, attributeFilter: ['class'] });
