/* ═══════════════════════════════════════════════════════
   LedgerLens — app.js
   Offline-first receipt processing PWA
   ═══════════════════════════════════════════════════════ */

// ────────────────────────────────────────────────────────
// 0. Firebase Configuration
//    Replace these with YOUR project values.
// ────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDNZ7QAtXtNonffAtnVNkWPUe1kn2_Zhck",
  authDomain: "ledgerlens-b4050.firebaseapp.com",
  projectId: "ledgerlens-b4050",
  storageBucket: "ledgerlens-b4050.firebasestorage.app",
  messagingSenderId: "502864448807",
  appId: "1:502864448807:web:9ddd1e9817ba49ba44ad02",
  measurementId: "G-P78YWQBCDC"
};

firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();
const storage = firebase.storage();
const auth = firebase.auth();

// Current authenticated user (set after anonymous sign-in)
let currentUser = null;

// ────────────────────────────────────────────────────────
// 1. IndexedDB (via idb)
// ────────────────────────────────────────────────────────
const IDB_NAME = 'ledgerlens-db';
const IDB_VERSION = 1;
const STORE_NAME = 'receipts';

let idbInstance = null;

async function getIDB() {
  if (idbInstance) return idbInstance;
  idbInstance = await idb.openDB(IDB_NAME, IDB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('status', 'status');
        store.createIndex('batchId', 'batchId');
      }
    }
  });
  return idbInstance;
}

// ────────────────────────────────────────────────────────
// 2. Globals
// ────────────────────────────────────────────────────────
let clientName = '';
let batchId = '';
let snapCounter = 0;
let pendingCount = 0;          // tracks images still uploading
let mediaStream = null;
window.isUploading = false;
window.uploadTimer = null;         // Explicit global scope for sync variable
window.uploadRetryDelay = 15000;    // Exponential backoff delay for sync
let extractionUnsubscribe = null;

// PERFORMANCE CRITICAL: Single reusable canvas for all snaps
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d');

const MAX_WIDTH = 1500;
const JPEG_QUALITY = 0.8;
const BATCH_MAX_IMAGES = 500;

const activeObjectURLs = new Map(); // id → objectURL

// DOM references
const $setup = document.getElementById('screen-setup');
const $camera = document.getElementById('screen-camera');
const $formSetup = document.getElementById('form-setup');
const $inputClient = document.getElementById('input-client');
const $inputCycle = document.getElementById('input-cycle');
const $btnStart = document.getElementById('btn-start');
const $btnHistory = document.getElementById('btn-history');
const $btnBack = document.getElementById('btn-back');
const $lblClient = document.getElementById('lbl-client');
const $lblBatch = document.getElementById('lbl-batch');
const $snapCount = document.getElementById('snap-count');
const $syncInd = document.getElementById('sync-indicator');
const $video = document.getElementById('camera-feed');
const $flashFx = document.getElementById('flash-fx');
const $btnSnap = document.querySelector('.btn-shutter');
const $queueList = document.querySelector('.queue-list');
const $btnFinish = document.getElementById('btn-finish');
const $btnExport = document.getElementById('btn-export');
const $toastBox = document.getElementById('toast-container');
const $modal = document.querySelector('.modal-overlay');
const $modalImg = document.getElementById('modal-img');
const $modalData = document.querySelector('.modal-data');
const $modalClose = document.querySelector('.modal-close-btn');
const $btnTorch = document.getElementById('btn-torch');
const $btnTheme = document.getElementById('btn-theme-toggle');
const $btnResetSession = document.getElementById('btn-reset-session');
const $btnGallery = document.getElementById('btn-gallery');
const $inputBulk = document.getElementById('input-bulk');



// ────────────────────────────────────────────────────────
// 3. Utility Functions
// ────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Sanitize user input — strip characters that could cause
 * injection in HTML, Firestore paths, or Storage paths.
 */
function sanitizeInput(str) {
  return str
    .replace(/[<>"'&\/\\]/g, '')   // Strip HTML/path-dangerous chars
    .replace(/\.\.+/g, '.')         // Prevent directory traversal
    .replace(/[\x00-\x1F]/g, '')   // Strip control characters
    .trim()
    .slice(0, 120);                 // Enforce max length
}

/**
 * Escape text for safe display — used as a secondary guard
 * even though we use textContent (not innerHTML) for AI data.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(msg, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $toastBox.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function showScreen(screenEl) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  screenEl.classList.add('active');
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

  if ($btnTheme) {
    $btnTheme.innerHTML = `<span class="material-symbols-rounded">${savedTheme === 'dark' ? 'dark_mode' : 'light_mode'}</span>`;
    $btnTheme.onclick = () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      $btnTheme.innerHTML = `<span class="material-symbols-rounded">${next === 'dark' ? 'dark_mode' : 'light_mode'}</span>`;
    };
  }
}

function fireFlash() {
  $flashFx.classList.remove('fire');
  void $flashFx.offsetWidth; // reflow
  $flashFx.classList.add('fire');
}

// ────────────────────────────────────────────────────────
// 4. Session Persistence — "Lunch Break" Logic
// ────────────────────────────────────────────────────────
/** Save local session state */
function saveSession(status = 'active') {
  localStorage.setItem('ll_batch', JSON.stringify({
    clientName,
    batchId,
    status
  }));
}

function clearSession() {
  localStorage.removeItem('ll_batch');
  clientName = '';
  batchId = '';
  if (extractionUnsubscribe) {
    extractionUnsubscribe();
    extractionUnsubscribe = null;
  }
}

async function resetApp() {
  const sure = confirm('This will end the current session. Your data already synced to the cloud is safe, but this device will start fresh. Proceed?');
  if (!sure) return;

  clearSession();
  snapCounter = 0;
  pendingCount = 0;
  $snapCount.textContent = '0';
  $queueList.innerHTML = '<span class="queue-empty">Snap a receipt to begin</span>';
  if ($btnResetSession) $btnResetSession.style.display = 'none';
  $btnExport.style.display = 'none';
  $btnFinish.style.display = 'flex';
  $btnFinish.disabled = true;

  // Clear setup inputs
  $inputClient.value = '';
  $inputCycle.value = '';

  stopCamera();
  showScreen($setup);
}

async function tryRestoreSession() {
  const raw = localStorage.getItem('ll_batch');
  if (!raw) return false;

  try {
    const saved = JSON.parse(raw);
    if (!saved || !saved.batchId) return false;

    clientName = saved.clientName;
    batchId = saved.batchId;

    $lblClient.textContent = clientName;
    $lblBatch.textContent = `Batch ${batchId.slice(0, 8)}…`;

    showScreen($camera);
    await startCamera();
    await restoreQueueFromFirestore();
    await restoreQueueFromIDB(saved);

    // UI State based on status
    if (saved.status === 'completed') {
      $btnFinish.style.display = 'none';
      $btnExport.style.display = 'flex';
    } else {
      $btnFinish.style.display = 'flex';
      $btnExport.style.display = 'none';
      updateFinishButton();
    }

    scheduleUpload(5000);
    showToast('Session restored ✓', 'success');
    if ($btnResetSession) $btnResetSession.style.display = 'flex';

    return true;
  } catch (e) {
    console.warn('Malformed session data:', e);
    return false;
  }
}

// Repopulate queue from Firestore for already-synced receipts
async function restoreQueueFromFirestore() {
  try {
    const snap = await db.collection('batches').doc(batchId)
      .collection('receipts').orderBy('uploadedAt', 'asc').get();

    $queueList.innerHTML = ''; // Clear empty message/old state
    let count = 0;

    snap.forEach(docSnap => {
      const d = docSnap.data();
      const status = d.extracted ? 'extracted' : 'synced';
      addThumbnailToQueue(docSnap.id, d.thumbUrl || d.storageUrl, status, d);
      count++;
    });

    snapCounter = count;
    $snapCount.textContent = snapCounter;
  } catch (err) {
    console.warn('Firestore restore failed (offline?):', err);
  }
}

// Repopulate queue from IDB for un-synced local receipts
async function restoreQueueFromIDB(savedSession) {
  const database = await getIDB();
  const all = await database.getAllFromIndex(STORE_NAME, 'batchId', batchId);
  for (const rec of all) {
    // Skip if already shown from Firestore
    if (document.getElementById(`q-${rec.id}`)) continue;
    const thumbUrl = URL.createObjectURL(rec.blob);
    activeObjectURLs.set(rec.id, thumbUrl); // track for cleanup
    addThumbnailToQueue(rec.id, thumbUrl, rec.status, null);
    snapCounter++;
    if (rec.status === 'pending_upload' || rec.status === 'uploading') pendingCount++;
  }
  $snapCount.textContent = snapCounter;

  // If restored batch was already completed, switch to export view
  const status = savedSession ? savedSession.status : 'active';
  if (status === 'completed') {
    $btnFinish.style.display = 'none';
    $btnExport.style.display = 'flex';
  } else {
    $btnFinish.style.display = 'flex';
    $btnExport.style.display = 'none';
    updateFinishButton();
  }
  // Kick off upload for any pending
  uploadPending();
}

// ────────────────────────────────────────────────────────
// 5. Setup Flow
// ────────────────────────────────────────────────────────
$formSetup.addEventListener('submit', async (e) => {
  e.preventDefault();

  // Sanitize inputs to prevent injection
  clientName = sanitizeInput($inputClient.value);
  const cycle = sanitizeInput($inputCycle.value);
  if (!clientName || !cycle) {
    showToast('Please enter valid names (no special characters)', 'error');
    return;
  }

  batchId = `${clientName.replace(/\s+/g, '_')}_${cycle.replace(/\s+/g, '_')}_${uid()}`;
  saveSession();

  // Clear UI from any previous restored session
  $queueList.innerHTML = '';
  snapCounter = 0;
  pendingCount = 0;
  $snapCount.textContent = '0';
  $btnExport.style.display = 'none';
  $btnFinish.style.display = 'flex';
  $btnFinish.disabled = true;

  // Create batch document in Firestore with ownerId for access control
  try {
    await db.collection('batches').doc(batchId).set({
      clientName,
      auditCycle: cycle,
      ownerId: currentUser.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'active',
      receiptCount: 0
    });
  } catch (err) {
    console.warn('Firestore batch create deferred (offline):', err);
  }

  $lblClient.textContent = clientName;
  $lblBatch.textContent = `Batch ${batchId.slice(0, 8)}…`;
  showScreen($camera);
  await startCamera();
  showToast(`Batch started for ${clientName}`, 'success');
});

// ────────────────────────────────────────────────────────
// 6. Camera — Memory-Safe Loop
// ────────────────────────────────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment', // Rear camera
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    mediaStream = stream;
    $video.srcObject = stream;

    // Torch Capability Check
    const track = stream.getVideoTracks()[0];
    const capabilities = track.getCapabilities();
    if (capabilities.torch) {
      $btnTorch.classList.remove('hidden');
      $btnTorch.onclick = () => {
        isTorchOn = !isTorchOn;
        track.applyConstraints({ advanced: [{ torch: isTorchOn }] });
        $btnTorch.classList.toggle('active', isTorchOn);
      };
    }

    try {
      await $video.play();
    } catch (err) {
      console.error('Video play error:', err);
    }
  } catch (err) {
    showToast('Camera access denied', 'error');
    console.error('Camera error:', err);
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
    $video.srcObject = null;
  }
}

function captureFrame() {
  if (!mediaStream) return null;

  const track = mediaStream.getVideoTracks()[0];
  const settings = track.getSettings();

  const targetW = MAX_WIDTH;
  const scale = targetW / settings.width;
  const targetH = settings.height * scale;

  // Reuse the SINGLE canvas — no DOM thrashing
  captureCanvas.width = targetW;
  captureCanvas.height = targetH;
  captureCtx.drawImage($video, 0, 0, targetW, targetH);

  return new Promise(resolve => {
    // WebP Compression for smaller file size
    captureCanvas.toBlob(blob => resolve(blob), 'image/webp', JPEG_QUALITY);
  });
}

// ────────────────────────────────────────────────────────
// 7. Snap Handler
// ────────────────────────────────────────────────────────
$btnSnap.addEventListener('click', async () => {
  // ── BATCH SAFE-CAP: 500 images max ──────────────────
  if (snapCounter >= BATCH_MAX_IMAGES) {
    showToast(`Batch full (${BATCH_MAX_IMAGES} images). Finish this batch and start a new one.`, 'error', 5000);
    return;
  }

  fireFlash();

  // Haptic Feedback
  if (navigator.vibrate) navigator.vibrate(50);

  const blob = await captureFrame();
  if (!blob) {
    showToast('Camera not ready', 'error');
    return;
  }

  const receiptId = uid();
  snapCounter++;
  pendingCount++;
  $snapCount.textContent = snapCounter;

  // Warn at 90% capacity
  if (snapCounter === Math.floor(BATCH_MAX_IMAGES * 0.9)) {
    showToast(`${BATCH_MAX_IMAGES - snapCounter} snaps remaining in this batch`, 'info', 4000);
  }

  // Save to IndexedDB immediately
  const database = await getIDB();
  await database.put(STORE_NAME, {
    id: receiptId,
    batchId: batchId,
    blob: blob,
    status: 'pending_upload',
    createdAt: Date.now()
  });

  // Add thumbnail to queue (track ObjectURL for cleanup)
  const thumbUrl = URL.createObjectURL(blob);
  activeObjectURLs.set(receiptId, thumbUrl);
  addThumbnailToQueue(receiptId, thumbUrl, 'pending_upload', null);
  updateFinishButton();

  // Trigger upload
  uploadPending();
});

// ── BATCH UPLOAD: Gallery / File Picker ───────────────
$btnGallery.addEventListener('click', () => {
  $inputBulk.click();
});

$inputBulk.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  $inputBulk.value = ''; // Reset for next selection
  handleBulkUpload(files);
});

async function handleBulkUpload(files) {
  showToast(`Processing ${files.length} images…`, 'info');

  for (const file of files) {
    if (snapCounter >= BATCH_MAX_IMAGES) {
      showToast('Batch limit reached', 'error');
      break;
    }

    const receiptId = uid();
    snapCounter++;
    pendingCount++;
    $snapCount.textContent = snapCounter;

    // Save to IDB
    const database = await getIDB();
    await database.put(STORE_NAME, {
      id: receiptId,
      batchId: batchId,
      blob: file,
      status: 'pending_upload',
      createdAt: Date.now()
    });

    // Add to UI
    const thumbUrl = URL.createObjectURL(file);
    activeObjectURLs.set(receiptId, thumbUrl);
    addThumbnailToQueue(receiptId, thumbUrl, 'pending_upload', null);
  }

  updateFinishButton();
  uploadPending();
}

// ────────────────────────────────────────────────────────
// 8. Reactive Queue UI
// ────────────────────────────────────────────────────────
function addThumbnailToQueue(id, thumbUrl, status, firestoreData) {
  // Remove empty-state message if present
  const empty = $queueList.querySelector('.queue-empty');
  if (empty) empty.remove();

  // Prevent duplicates
  if (document.getElementById(`q-${id}`)) {
    updateThumbnailStatus(id, status, firestoreData);
    return;
  }

  const div = document.createElement('div');
  div.className = `q-card ${status}`;
  div.id = `q-${id}`;
  div.onclick = () => openPreview(id, thumbUrl, firestoreData);

  // Inner wrapper for clipping
  const inner = document.createElement('div');
  inner.className = 'q-card-inner';
  div.appendChild(inner);

  // Thumbnail
  const img = document.createElement('img');
  img.src = thumbUrl;
  inner.appendChild(img);

  // Progress Bar
  const prog = document.createElement('div');
  prog.className = 'q-prog-bar';
  inner.appendChild(prog);

  // Status Icons (Check/Sparkle)
  const iconCheck = document.createElement('span');
  iconCheck.className = 'material-symbols-rounded status-icon icon-check';
  iconCheck.textContent = 'check_circle';
  inner.appendChild(iconCheck);

  const iconSparkle = document.createElement('span');
  iconSparkle.className = 'material-symbols-rounded status-icon icon-sparkle';
  iconSparkle.textContent = 'auto_awesome';
  inner.appendChild(iconSparkle);

  const badgeInvalid = document.createElement('div');
  badgeInvalid.className = 'badge-invalid';
  badgeInvalid.textContent = 'Invalid';
  inner.appendChild(badgeInvalid);

  // Processing Badge
  const badgeProc = document.createElement('div');
  badgeProc.className = 'badge-proc';
  badgeProc.textContent = 'AI Processing...';
  inner.appendChild(badgeProc);

  // Initial Visibility
  if (status === 'synced' || status === 'uploaded') {
    div.classList.add('is-processing');
  }

  // Check for Invalid state
  if (firestoreData && firestoreData.extractedData && firestoreData.extractedData.category === 'Invalid') {
    div.classList.add('is-invalid');
  }

  // Delete Button
  const btnDel = document.createElement('button');
  btnDel.className = 'btn-card-del';
  btnDel.innerHTML = '<span class="material-symbols-rounded">close</span>';
  btnDel.title = 'Delete receipt';
  btnDel.onclick = (e) => {
    e.stopPropagation(); // Don't open preview
    deleteReceipt(id);
  };
  div.appendChild(btnDel);

  // Prepend to list (newest first)
  $queueList.insertBefore(div, $queueList.firstChild);
}

async function deleteReceipt(id) {
  const sure = confirm('Delete this receipt permanently?');
  if (!sure) return;

  const card = document.getElementById(`q-${id}`);
  const storagePath = card?._firestoreData?.storagePath;

  try {
    // 1. Storage
    if (storagePath) {
      await storage.ref(storagePath).delete();
    }

    // 2. Firestore
    await db.collection('batches').doc(batchId)
      .collection('receipts').doc(id).delete();

    // 3. IDB
    const database = await getIDB();
    await database.delete(STORE_NAME, id);

    // 4. Memory / UI
    if (activeObjectURLs.has(id)) {
      URL.revokeObjectURL(activeObjectURLs.get(id));
      activeObjectURLs.delete(id);
    }
    if (card) card.remove();

    snapCounter = Math.max(0, snapCounter - 1);
    $snapCount.textContent = snapCounter;

    showToast('Receipt deleted', 'info');
    if ($queueList.children.length === 0) {
      $queueList.innerHTML = '<span class="queue-empty">Snap a receipt to begin</span>';
    }
  } catch (err) {
    console.error('Delete failed:', err);
    showToast('Failed to delete resource', 'error');
  }
}

function updateThumbnailStatus(id, status, firestoreData) {
  const card = document.getElementById(`q-${id}`);
  if (!card) return;
  applyCardState(card, status);
  if (firestoreData) card._firestoreData = firestoreData;

  // Toggle processing badge
  if (status === 'synced' || status === 'uploaded' || status === 'uploading') {
    card.classList.add('is-processing');
  } else {
    card.classList.remove('is-processing');
  }

  // Handle Invalid state override
  if (firestoreData && firestoreData.extractedData && firestoreData.extractedData.category === 'Invalid') {
    card.classList.add('is-invalid');
    card.classList.remove('is-processing');
  }
}

function applyCardState(card, status) {
  card.classList.remove('uploading', 'synced', 'extracted');
  switch (status) {
    case 'pending_upload':
      // Blue border (default CSS)
      break;
    case 'uploading':
      card.classList.add('uploading');
      break;
    case 'synced':
      card.classList.add('synced');
      break;
    case 'extracted':
      card.classList.add('extracted');
      break;
  }
}

function updateFinishButton() {
  // Only enable if there's at least one receipt and no active uploads
  $btnFinish.disabled = (snapCounter === 0 || pendingCount > 0);
}

// ────────────────────────────────────────────────────────
// 9. Upload Engine — Background Sync
// ────────────────────────────────────────────────────────
async function uploadPending() {
  if (isUploading) return;
  isUploading = true;
  $syncInd.classList.add('uploading');

  const database = await getIDB();
  let pending = await database.getAllFromIndex(STORE_NAME, 'status', 'pending_upload');
  // Filter to current batch
  pending = pending.filter(r => r.batchId === batchId);

  // If nothing to upload, schedule next check and exit
  if (pending.length === 0) {
    isUploading = false;
    $syncInd.classList.remove('uploading');
    scheduleUpload(15000); // idle check
    return;
  }

  for (const receipt of pending) {
    try {
      // Mark uploading
      receipt.status = 'uploading';
      await database.put(STORE_NAME, receipt);
      updateThumbnailStatus(receipt.id, 'uploading');

      // Upload WebP blob to Firebase Storage with Progress
      const storagePath = `receipts/${batchId}/${receipt.id}.webp`;
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
      await db.collection('batches').doc(batchId)
        .collection('receipts').doc(receipt.id).set({
          storageUrl: downloadUrl,
          storagePath: storagePath,
          status: 'synced',
          extracted: false,
          uploadedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

      // ── DELETE-ON-SUCCESS ──────────────────────────────
      // Blob confirmed in Firebase Storage → purge from IDB to free memory.
      await database.delete(STORE_NAME, receipt.id);

      // Revoke the local ObjectURL to release the blob from browser memory
      const oldUrl = activeObjectURLs.get(receipt.id);
      if (oldUrl) {
        URL.revokeObjectURL(oldUrl);
        activeObjectURLs.delete(receipt.id);
      }

      // Update the card's image and status
      const card = document.getElementById(`q-${receipt.id}`);
      if (card) {
        const img = card.querySelector('img');
        if (img) img.src = downloadUrl;
        card._firestoreData = { storageUrl: downloadUrl };
      }

      pendingCount = Math.max(0, pendingCount - 1);
      updateThumbnailStatus(receipt.id, 'synced');

      // Success? Reset backoff
      uploadRetryDelay = 15000;

    } catch (err) {
      console.error(`Upload failed for ${receipt.id}:`, err);
      receipt.status = 'pending_upload';
      await database.put(STORE_NAME, receipt);
      updateThumbnailStatus(receipt.id, 'pending_upload');

      // Exponential Backoff
      uploadRetryDelay = Math.min(uploadRetryDelay * 1.5, 300000); // cap at 5 mins
      console.log(`Backing off upload for ${uploadRetryDelay}ms`);
      break; // stop queue
    }
  }

  isUploading = false;
  $syncInd.classList.remove('uploading');
  updateFinishButton();

  // Schedule next run
  scheduleUpload(pending.length > 0 ? 1000 : uploadRetryDelay);
}

function scheduleUpload(delay) {
  if (window.uploadTimer) clearTimeout(window.uploadTimer);
  window.uploadTimer = setTimeout(uploadPending, delay);
}

// Retry every 15 seconds
setInterval(() => {
  if (!batchId) return;
  uploadPending();
}, 15000);

// ────────────────────────────────────────────────────────
// 10. Firestore Listener — AI Extraction Updates
// ────────────────────────────────────────────────────────
function startExtractionListener() {
  if (!batchId || !currentUser) return;

  // Stop existing listener if any
  if (extractionUnsubscribe) {
    extractionUnsubscribe();
    extractionUnsubscribe = null;
  }

  extractionUnsubscribe = db.collection('batches').doc(batchId)
    .collection('receipts')
    .where('extracted', '==', true)
    .onSnapshot(snapshot => {
      // ... same logic ...
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          updateThumbnailStatus(change.doc.id, 'extracted', data);
        }
      });
    }, err => {
      if (err.code === 'permission-denied') return; // Silence permission errors on session transitions
      console.warn('Snapshot listener error:', err);
    });
}

// ────────────────────────────────────────────────────────
// 11. Preview Modal
// ────────────────────────────────────────────────────────
async function openPreview(id, thumbUrl, firestoreData) {
  $modal.style.display = 'flex';
  // Don't set src immediately to avoid stale blob ERR_FILE_NOT_FOUND
  $modalImg.src = '';

  // Safety: If blob URL fails (e.g. revoked due to Delete-on-Success), fall back to remote
  $modalImg.onerror = () => {
    if (firestoreData && (firestoreData.storageUrl || firestoreData.thumbUrl)) {
      $modalImg.src = firestoreData.storageUrl || firestoreData.thumbUrl;
      $modalImg.onerror = null; // Prevent loops
    }
  };

  $modalData.innerHTML = '<p class="modal-placeholder">AI extraction pending…</p>';
  if ($modalImg._objectUrl) {
    URL.revokeObjectURL($modalImg._objectUrl);
    $modalImg._objectUrl = null;
  }

  // Try IDB first (for un-uploaded images), fall back to remote URL
  const database = await getIDB();
  const rec = await database.get(STORE_NAME, id);

  if (rec && rec.blob) {
    const objUrl = URL.createObjectURL(rec.blob);
    $modalImg._objectUrl = objUrl;
    $modalImg.src = objUrl;
  } else if (firestoreData && (firestoreData.storageUrl || firestoreData.thumbUrl)) {
    $modalImg.src = firestoreData.storageUrl || firestoreData.thumbUrl;
  } else if (thumbUrl) {
    $modalImg.src = thumbUrl;
  }

  // Fetch latest data from Firestore
  let data = firestoreData;
  try {
    const docSnap = await db.collection('batches').doc(batchId)
      .collection('receipts').doc(id).get();
    if (docSnap.exists) data = docSnap.data();
  } catch (e) { /* offline, use cached */ }

  // XSS-SAFE: Build modal content with DOM APIs, never innerHTML with user/AI data
  $modalData.textContent = ''; // Clear previous content safely

  if (data && data.extracted) {
    const ext = data.extractedData || {};
    const conf = ext.confidence_score ?? 0;
    const form = document.createElement('div');
    form.className = 'edit-form';

    function addEditRow(label, value, id, type = 'text') {
      const row = document.createElement('div');
      row.className = 'field-row';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      const input = document.createElement(type === 'select' ? 'select' : 'input');
      if (type !== 'select') {
        input.type = type;
        if (type === 'number') input.step = '0.01';
        input.value = value || '';
      }
      input.id = `edit-${id}`;
      row.appendChild(lbl);
      row.appendChild(input);
      form.appendChild(row);
      return input;
    }

    addEditRow('Vendor', ext.vendor, 'vendor');
    addEditRow('Total', ext.total, 'total', 'number');
    addEditRow('Date', ext.date, 'date');

    const catSelect = addEditRow('Category', ext.category, 'category', 'select');
    const categories = ['Food & Beverage', 'Office Supplies', 'Travel', 'Fuel', 'Utilities', 'Medical', 'Equipment', 'Services', 'Miscellaneous', 'Invalid'];
    categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      if (ext.category === c) opt.selected = true;
      catSelect.appendChild(opt);
    });

    const btnSave = document.createElement('button');
    btnSave.className = 'btn-save';
    btnSave.textContent = 'Save Changes';
    btnSave.onclick = () => saveReceiptData(id);
    form.appendChild(btnSave);

    $modalData.appendChild(form);

    // Confidence display
    const confP = document.createElement('p');
    confP.style.fontSize = '12px';
    confP.style.marginTop = '10px';
    confP.style.color = 'var(--text-secondary)';
    confP.textContent = `AI Confidence: ${conf}%`;
    $modalData.appendChild(confP);

  } else {
    const p = document.createElement('p');
    p.className = 'modal-placeholder';
    p.textContent = 'AI extraction pending…';
    $modalData.appendChild(p);
  }
}

async function saveReceiptData(id) {
  const vendor = document.getElementById('edit-vendor').value;
  const total = parseFloat(document.getElementById('edit-total').value);
  const date = document.getElementById('edit-date').value;
  const category = document.getElementById('edit-category').value;

  try {
    const ref = db.collection('batches').doc(batchId)
      .collection('receipts').doc(id);

    const snap = await ref.get();
    const currentData = snap.data() || {};
    const extData = currentData.extractedData || {};

    await ref.update({
      "extractedData.vendor": vendor,
      "extractedData.total": total,
      "extractedData.date": date,
      "extractedData.category": category,
      "manualCorrection": true
    });

    showToast('Data updated', 'success');
  } catch (err) {
    showToast('Update failed: ' + err.message, 'error');
  }
}

$modalClose.addEventListener('click', () => {
  $modal.style.display = 'none';
  // Cleanup: revoke ObjectURL used by modal preview image
  if ($modalImg._objectUrl) {
    URL.revokeObjectURL($modalImg._objectUrl);
    $modalImg._objectUrl = null;
  }
});
$modal.addEventListener('click', (e) => {
  if (e.target === $modal) {
    $modal.style.display = 'none';
    if ($modalImg._objectUrl) {
      URL.revokeObjectURL($modalImg._objectUrl);
      $modalImg._objectUrl = null;
    }
  }
});

// ────────────────────────────────────────────────────────
// 12. Finish Batch
// ────────────────────────────────────────────────────────
$btnFinish.addEventListener('click', async () => {
  const confirmFinish = confirm(
    `Finish batch for "${clientName}"?\n\nAll ${snapCounter} receipt(s) have been synced. The batch will be marked as complete.`
  );
  if (!confirmFinish) return;

  try {
    await db.collection('batches').doc(batchId).update({
      status: 'completed',
      completedAt: firebase.firestore.FieldValue.serverTimestamp(),
      totalReceipts: snapCounter
    });
    saveSession('completed'); // Sync local status
    showToast('Batch completed ✓', 'success');
    $btnFinish.style.display = 'none';
    $btnExport.style.display = 'flex';
  } catch (err) {
    showToast('Failed to finalize batch', 'error');
    console.error(err);
  }
});

// Added: Past Batches Placeholder
// Batch History implementation
if ($btnHistory) {
  $btnHistory.addEventListener('click', showHistory);
}

async function deleteBatch(id, name) {
  const sure = confirm(`Permanently delete batch "${name || id}" and all its receipts?`);
  if (!sure) return;

  try {
    showToast('Deleting batch...', 'info');

    // 1. Delete all images from Storage for this batch
    try {
      const storageRef = storage.ref(`receipts/${id}`);
      const listResult = await storageRef.listAll();
      const storageDeletions = listResult.items.map(item => item.delete());
      await Promise.all(storageDeletions);
    } catch (sErr) {
      console.warn('Storage deletion warning (some files may remain):', sErr);
    }

    // 2. Delete all receipts in subcollection (Firestore basic delete doesn't do subcollections automatically)
    const receipts = await db.collection('batches').doc(id).collection('receipts').get();
    const batch = db.batch();
    receipts.forEach(r => batch.delete(r.ref));

    // 3. Delete the batch document itself
    batch.delete(db.collection('batches').doc(id));

    await batch.commit();
    showToast('Batch and images deleted ✓', 'success');
  } catch (err) {
    console.error('[Delete] failed:', err);
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function showHistory() {
  const historyOverlay = document.createElement('div');
  historyOverlay.className = 'history-overlay active';
  historyOverlay.innerHTML = `
    <div class="history-content">
      <div class="history-header">
        <h2>Past Sessions</h2>
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
      .where('ownerId', '==', currentUser.uid)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const list = document.getElementById('history-list');
    list.innerHTML = '';

    if (snap.empty) {
      list.innerHTML = '<p class="empty">No past sessions found.</p>';
      return;
    }

    snap.forEach(doc => {
      const b = doc.data();
      const date = b.createdAt ? b.createdAt.toDate().toLocaleDateString() : 'Unknown';
      const item = document.createElement('div');
      item.className = 'history-item';

      const countElId = `hist-count-${doc.id}`;
      item.innerHTML = `
        <div class="info">
          <strong>${b.clientName || 'Unnamed'}</strong>
          <span>${b.auditCycle || ''} • ${date} • <span id="${countElId}">${b.receiptCount || '—'}</span> receipts</span>
        </div>
        <div class="actions">
          <button class="btn-restore">Restore</button>
          <button class="btn-batch-del" title="Delete Batch">
            <span class="material-symbols-rounded">delete</span>
          </button>
        </div>
      `;

      // Fallback: If count is 0, query the sub-collection to double check
      if (!b.receiptCount) {
        db.collection('batches').doc(doc.id).collection('receipts').get().then(rSnap => {
          const countEl = document.getElementById(countElId);
          if (countEl && rSnap.size > 0) {
            countEl.textContent = rSnap.size;
          }
        }).catch(() => { });
      }
      item.querySelector('.btn-restore').onclick = async () => {
        const sure = confirm('Restore this past session?');
        if (!sure) return;

        clientName = b.clientName;
        batchId = doc.id;
        // Save with the status from the database
        saveSession(b.status || 'active');

        // Full refresh to clean state and let tryRestoreSession take over
        window.location.reload();
      };

      item.querySelector('.btn-batch-del').onclick = async (e) => {
        e.stopPropagation();
        await deleteBatch(doc.id, b.clientName);
        historyOverlay.remove();
        showHistory(); // Re-open history to see updated list
      };

      list.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    document.getElementById('history-list').innerHTML = `<p class="error">Error: ${err.message}</p>`;
  }
}

// ────────────────────────────────────────────────────────
// 13. Export Excel
// ────────────────────────────────────────────────────────
$btnExport.addEventListener('click', async () => {
  showToast('Generating Excel report…', 'info', 5000);
  try {
    // Get the current user's ID token for authenticated request
    const idToken = await currentUser.getIdToken(true);

    // Call the Cloud Function export endpoint via proxy (same-origin)
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ batch_id: batchId })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Export failed (Status ${response.status})`);
    }

    const result = await response.json();
    if (result.download_url) {
      window.open(result.download_url, '_blank');
      showToast('Excel report ready!', 'success');
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
    console.error(err);
  }
});

// ────────────────────────────────────────────────────────
// 14. Back / End Session
// ────────────────────────────────────────────────────────
$btnBack.addEventListener('click', () => {
  resetApp();
});

// ────────────────────────────────────────────────────────
// 15. Professional Authentication (Google Auth)
// ────────────────────────────────────────────────────────
const $authScreen = document.getElementById('screen-auth');
const $btnGoogleLogin = document.getElementById('btn-google-login');
const $userProfile = document.getElementById('user-profile');
const $userDisplayEmail = document.getElementById('user-display-email');
const $btnLogout = document.getElementById('btn-logout');

// Google Login
$btnGoogleLogin.onclick = async () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
    showToast('Signed in with Google', 'success');
  } catch (err) {
    console.error('[Auth] Google sign-in failed:', err);
    showToast(err.message, 'error');
  }
};

// Logout
$btnLogout.onclick = async () => {
  if (confirm('Sign out?')) {
    await auth.signOut();
    window.location.reload();
  }
};

async function ensureAuth() {
  return new Promise((resolve) => {
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        currentUser = user;
        $userProfile.style.display = 'flex';
        $userDisplayEmail.textContent = user.email || user.displayName;
        showScreen($setup);
        resolve(user);
      } else {
        currentUser = null;
        $userProfile.style.display = 'none';
        showScreen($authScreen);
        // We don't resolve — enforcing the login screen
      }
    });
  });
}

// ────────────────────────────────────────────────────────
// 16. Init
// ────────────────────────────────────────────────────────
(async function init() {
  // Existing init code...

  initTheme();

  if ($btnResetSession) {
    $btnResetSession.addEventListener('click', resetApp);
  }

  // Show empty queue message
  const emptyMsg = document.createElement('span');
  emptyMsg.className = 'queue-empty';
  emptyMsg.textContent = 'Snap a receipt to begin';
  $queueList.appendChild(emptyMsg);

  // SECURITY: Authenticate before any Firestore/Storage access
  try {
    await ensureAuth();
  } catch (e) {
    // Auth failed — stay on setup screen, user will see error toast
    showScreen($setup);
    return;
  }

  const restored = await tryRestoreSession();
  if (restored) {
    startExtractionListener();
  } else {
    showScreen($setup);
  }
})();

// Start listener once we enter camera screen from setup
const cameraObserver = new MutationObserver(() => {
  if ($camera.classList.contains('active')) {
    startExtractionListener();
  }
});
cameraObserver.observe($camera, { attributes: true, attributeFilter: ['class'] });
