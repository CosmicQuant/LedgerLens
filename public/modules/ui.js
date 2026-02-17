import { state } from './state.js';
import { db as firestore, storage } from './firebase-init.js';
import { getIDB, deleteReceiptFromIDB } from './db.js';

export const DOM = {
    setup: document.getElementById('screen-setup'),
    camera: document.getElementById('screen-camera'),
    authScreen: document.getElementById('screen-auth'),
    formSetup: document.getElementById('form-setup'),
    inputClient: document.getElementById('input-client'),
    inputCycle: document.getElementById('input-cycle'),
    btnStart: document.getElementById('btn-start'),
    btnHistory: document.getElementById('btn-history'),
    btnBack: document.getElementById('btn-back'),
    lblClient: document.getElementById('lbl-client'),
    lblBatch: document.getElementById('lbl-batch'),
    snapCount: document.getElementById('snap-count'),
    syncInd: document.getElementById('sync-indicator'),
    video: document.getElementById('camera-feed'),
    btnSnap: document.querySelector('.btn-shutter'),
    queueList: document.querySelector('.queue-list'),
    btnFinish: document.getElementById('btn-finish'),
    btnExport: document.getElementById('btn-export'),
    toastBox: document.getElementById('toast-container'),
    modal: document.querySelector('.modal-overlay'),
    modalImg: document.getElementById('modal-img'),
    modalData: document.querySelector('.modal-data'),
    modalClose: document.querySelector('.modal-close-btn'),
    btnTorch: document.getElementById('btn-torch'),
    btnTheme: document.getElementById('btn-theme-toggle'),
    btnResetSession: document.getElementById('btn-reset-session'),
    userProfile: document.getElementById('user-profile'),
    userDisplayEmail: document.getElementById('user-display-email'),
    btnLogout: document.getElementById('btn-logout'),
    btnGoogleLogin: document.getElementById('btn-google-login'),
    // ... add others as needed
};

// Wire up global modal close (Safety for user report: modal not closing)
if (DOM.modalClose) {
    DOM.modalClose.onclick = () => {
        DOM.modal.style.display = 'none';
        if (DOM.modalImg._objectUrl) {
            URL.revokeObjectURL(DOM.modalImg._objectUrl);
            DOM.modalImg._objectUrl = null;
        }
    };
}

if (DOM.modal) {
    DOM.modal.onclick = (e) => {
        if (e.target === DOM.modal) {
            DOM.modal.style.display = 'none';
        }
    };
}

export function showScreen(screenEl) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    screenEl.classList.add('active');
}

/**
 * Replaces simple toast/alert with a professional modal.
 * @param {string} title - Title of the modal
 * @param {string} msg - Message body
 * @param {string} type - 'info', 'success', 'error', 'warning'
 * @param {Array} actions - Array of button objects: { label: 'OK', type: 'primary|secondary|danger', onClick: () => {} }
 */
export function showNotification(title, msg, type = 'info', actions = []) {
    // Remove existing if any
    const existing = document.querySelector('.notification-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'notification-modal-overlay active';

    // Icon mapping
    const icons = {
        info: 'info',
        success: 'check_circle',
        error: 'error',
        warning: 'warning'
    };

    // Default action if none provided
    if (!actions.length) {
        actions.push({ label: 'OK', type: 'primary', onClick: () => overlay.remove() });
    }

    const btnsHtml = actions.map((btn, idx) => `
        <button class="notification-btn ${btn.type || 'secondary'}" data-idx="${idx}">
            ${btn.label}
        </button>
    `).join('');

    overlay.innerHTML = `
        <div class="notification-card">
            <div class="notification-icon ${type}">
                <span class="material-symbols-rounded">${icons[type] || 'info'}</span>
            </div>
            <h3 class="notification-title">${title}</h3>
            <p class="notification-message">${msg}</p>
            <div class="notification-actions">
                ${btnsHtml}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Bind events
    const buttons = overlay.querySelectorAll('.notification-btn');
    buttons.forEach(btn => {
        btn.onclick = () => {
            const idx = btn.getAttribute('data-idx');
            const action = actions[idx];
            if (action.onClick) action.onClick();
            if (!action.keepOpen) overlay.remove();
        };
    });
}

// Keep showToast for non-intrusive updates, but redirect alerts to showNotification
export function showToast(msg, type = 'info', duration = 3000) {
    // If it's an error, use the modal for better visibility
    if (type === 'error') {
        showNotification('Error', msg, 'error');
        return;
    }

    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    DOM.toastBox.appendChild(t);
    setTimeout(() => {
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 300);
    }, duration);
}

export function updateFinishButton() {
    // Only enable if there's at least one receipt and no active uploads
    if (DOM.btnFinish) {
        DOM.btnFinish.disabled = (state.snapCounter === 0 || state.pendingCount > 0);
    }
}

export function setBatchCompleted(isCompleted) {
    if (isCompleted) {
        if (DOM.btnFinish) DOM.btnFinish.style.display = 'none';
        if (DOM.btnExport) DOM.btnExport.style.display = 'flex';
    } else {
        if (DOM.btnFinish) DOM.btnFinish.style.display = 'flex';
        if (DOM.btnExport) DOM.btnExport.style.display = 'none';
        updateFinishButton();
    }
}

export function addThumbnailToQueue(id, thumbUrl, status, firestoreData, onDelete) {
    // Remove empty-state message if present
    const empty = DOM.queueList.querySelector('.queue-empty');
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

    // Status Icons
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

    // Force remove processing if extracted/invalid/error
    updateThumbnailStatus(id, status, firestoreData);

    // Check for Error state (New feature from review)
    if (firestoreData && firestoreData.status === 'error') {
        div.classList.add('is-invalid'); // Reuse invalid style or add new error style
        badgeInvalid.textContent = 'Error';
    }

    // Delete Button
    const btnDel = document.createElement('button');
    btnDel.className = 'btn-card-del';
    btnDel.innerHTML = '<span class="material-symbols-rounded">close</span>';
    btnDel.title = 'Delete receipt';
    btnDel.onclick = (e) => {
        e.stopPropagation();
        if (onDelete) onDelete(id);
    };
    div.appendChild(btnDel);

    // Prepend to list (newest first)
    DOM.queueList.insertBefore(div, DOM.queueList.firstChild);
}

export function updateThumbnailStatus(id, status, firestoreData, uploadProgress) {
    const card = document.getElementById(`q-${id}`);
    if (!card) return;

    card.classList.remove('uploading', 'synced', 'extracted', 'pending_upload', 'is-processing', 'is-invalid', 'pending_retry');
    card.classList.add(status);

    if (firestoreData) card._firestoreData = firestoreData;

    // Logic: Is it currently processing?
    // Processing if: status is synced/uploaded AND extracted is NOT true
    const isActuallyExtracted = status === 'extracted' || (firestoreData && firestoreData.extracted);
    const hasError = status === 'error' || (firestoreData && firestoreData.status === 'error');
    const isInvalid = firestoreData && firestoreData.extractedData && firestoreData.extractedData.category === 'Invalid';

    if (!isActuallyExtracted && !hasError && !isInvalid && (status === 'synced' || status === 'uploaded' || status === 'uploading' || status === 'pending_retry' || status === 'processing')) {
        card.classList.add('is-processing');

        // Granular Labels (New Feature)
        const badgeProc = card.querySelector('.badge-proc');
        if (badgeProc) {
            if (status === 'uploading') badgeProc.textContent = 'Uploading...';
            else if (status === 'synced' || status === 'uploaded') badgeProc.textContent = 'Uploaded';
            else if (status === 'processing') badgeProc.textContent = 'Extracting...';
            else if (status === 'pending_retry') badgeProc.textContent = 'Retrying...';
            else badgeProc.textContent = 'AI Processing...';
        }
    }

    if (isInvalid || hasError) {
        card.classList.add('is-invalid');
        if (hasError) {
            const badge = card.querySelector('.badge-invalid');
            if (badge) badge.textContent = 'Error';
        }
    }

    if (isActuallyExtracted) {
        card.classList.add('extracted');
    }

    // Progress bar
    if (uploadProgress !== undefined) {
        const bar = card.querySelector('.q-prog-bar');
        if (bar) bar.style.width = `${uploadProgress}%`;
    }
}

export async function openPreview(id, thumbUrl, firestoreData) {
    DOM.modal.style.display = 'flex';
    DOM.modalImg.src = '';

    // Safety: If blob URL fails
    DOM.modalImg.onerror = () => {
        if (firestoreData && (firestoreData.storageUrl || firestoreData.thumbUrl)) {
            DOM.modalImg.src = firestoreData.storageUrl || firestoreData.thumbUrl;
            DOM.modalImg.onerror = null;
        }
    };

    DOM.modalData.innerHTML = '<p class="modal-placeholder">AI extraction pending…</p>';
    if (DOM.modalImg._objectUrl) {
        URL.revokeObjectURL(DOM.modalImg._objectUrl);
        DOM.modalImg._objectUrl = null;
    }

    // Try IDB first (for un-uploaded images)
    const database = await getIDB();
    const rec = await database.get('receipts', id);

    if (rec && rec.blob) {
        const objUrl = URL.createObjectURL(rec.blob);
        DOM.modalImg._objectUrl = objUrl;
        DOM.modalImg.src = objUrl;
    } else if (firestoreData && (firestoreData.storageUrl || firestoreData.thumbUrl)) {
        DOM.modalImg.src = firestoreData.storageUrl || firestoreData.thumbUrl;
    } else if (thumbUrl) {
        DOM.modalImg.src = thumbUrl;
    }

    // Fetch latest data from Firestore
    let data = firestoreData;
    try {
        const docSnap = await firestore.collection('batches').doc(state.batchId)
            .collection('receipts').doc(id).get();
        if (docSnap.exists) data = docSnap.data();
    } catch (e) { /* offline */ }

    DOM.modalData.textContent = '';

    if (data && data.extracted) {
        renderEditForm(data.extractedData, id);
    } else {
        const p = document.createElement('p');
        p.className = 'modal-placeholder';

        if (data && data.status === 'error') {
            p.classList.add('error');
            p.textContent = `AI Error: ${data.error_message || 'Unknown error'}`;
            p.style.color = 'var(--error)';
        } else if (data && data.status === 'processing') {
            p.innerHTML = '<span class="material-symbols-rounded spin">sync</span> AI is working...';
        } else {
            p.textContent = 'AI extraction pending…';
        }
        DOM.modalData.appendChild(p);

        // Add Retry Button if not extracted
        const btnRetry = document.createElement('button');
        btnRetry.className = 'btn-primary btn-retry-ai';
        btnRetry.style.marginTop = '15px';
        btnRetry.innerHTML = '<span class="material-symbols-rounded">refresh</span> Retry AI Extraction';
        btnRetry.onclick = async () => {
            btnRetry.disabled = true;
            btnRetry.innerHTML = '<span class="material-symbols-rounded spin">sync</span> Triggering...';
            try {
                await firestore.collection('batches').doc(state.batchId)
                    .collection('receipts').doc(id).update({
                        status: 'pending_retry',
                        updatedAt: new Date()
                    });
                showToast('Retry triggered. Please wait...');
                DOM.modal.style.display = 'none'; // Close modal to let user see queue
            } catch (err) {
                showToast('Failed to trigger retry: ' + err.message);
                btnRetry.disabled = false;
                btnRetry.innerHTML = 'Retry AI Extraction';
            }
        };
        DOM.modalData.appendChild(btnRetry);
    }
}

function renderEditForm(ext, id) {
    const conf = ext.confidence_score ?? 0;
    const form = document.createElement('div');
    form.className = 'edit-form';

    function addEditRow(label, value, fieldId, type = 'text') {
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
        input.id = `edit-${fieldId}`;
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

    DOM.modalData.appendChild(form);

    const confP = document.createElement('p');
    confP.style.fontSize = '12px';
    confP.style.marginTop = '10px';
    confP.style.color = 'var(--text-secondary)';
    confP.textContent = `AI Confidence: ${conf}%`;
    DOM.modalData.appendChild(confP);
}

async function saveReceiptData(id) {
    const vendor = document.getElementById('edit-vendor').value;
    const total = parseFloat(document.getElementById('edit-total').value);
    const date = document.getElementById('edit-date').value;
    const category = document.getElementById('edit-category').value;

    try {
        const ref = firestore.collection('batches').doc(state.batchId)
            .collection('receipts').doc(id);

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

// Force reload modules if they are stuck
if (!window.location.hash.includes('reloaded')) {
    // Optional: could force reload here, but let's rely on the file rename first.
}
