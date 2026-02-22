import { openPreview, showToast, updateFinishButton, updateThumbnailStatus } from './ui.js';

const IDB_NAME = 'ledgerlens-db';
const IDB_VERSION = 3;
const STORE_NAME = 'receipts';

let idbInstance = null;

export async function getIDB() {
    if (idbInstance) return idbInstance;
    idbInstance = await idb.openDB(IDB_NAME, IDB_VERSION, {
        upgrade(database, oldVersion) {
            let store;
            if (oldVersion < 1) {
                store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('status', 'status');
                store.createIndex('batchId', 'batchId');
            } else {
                store = database.transaction.objectStore(STORE_NAME);
            }

            if (oldVersion < 2) {
                // Composite index for efficient upload and counting
                store.createIndex('batchId_status', ['batchId', 'status']);
            }

            if (oldVersion < 3) {
                // V68: The RAM Shield / IDB Native Proxy Sandbox
                database.createObjectStore('raw_files'); // out-of-line keys
            }
        }
    });
    return idbInstance;
}

export async function saveReceiptToIDB(receipt) {
    const database = await getIDB();
    await database.put(STORE_NAME, receipt);
}

export async function getReceiptFromIDB(id) {
    const database = await getIDB();
    return await database.get(STORE_NAME, id);
}

export async function deleteReceiptFromIDB(id) {
    const database = await getIDB();
    await database.delete(STORE_NAME, id);
}

// V68: Native IDB Streamers
export async function saveRawFileToIDB(id, file) {
    const database = await getIDB();
    await database.put('raw_files', file, id);
}
export async function getRawFileFromIDB(id) {
    const database = await getIDB();
    return await database.get('raw_files', id);
}
export async function deleteRawFileFromIDB(id) {
    const database = await getIDB();
    await database.delete('raw_files', id);
}

/** 
 * Returns only a small batch of pending uploads to prevent RAM spikes.
 * On mobile, fetching 50 high-res blobs into an array kills the tab.
 */
export async function getPendingUploads(batchId, limit = 5) {
    const database = await getIDB();

    // 1. Recover stuck items first
    const stuck = await database.getAllFromIndex(STORE_NAME, 'status', 'uploading');
    for (const r of stuck) {
        if (r.batchId === batchId) {
            r.status = 'pending_upload';
            await database.put(STORE_NAME, r);
        }
    }

    // 2. Fetch specific batch with limit
    // We use a cursor to avoid fetching everything into an array
    const pending = [];
    let cursor = await database.transaction(STORE_NAME).store.index('batchId_status')
        .openCursor(IDBKeyRange.only([batchId, 'pending_upload']));

    while (cursor && pending.length < limit) {
        pending.push(cursor.value);
        cursor = await cursor.continue();
    }

    return pending;
}

/** Efficient counting without fetching blobs */
export async function getBatchCounts(batchId) {
    const database = await getIDB();
    const tx = database.transaction(STORE_NAME, 'readonly');
    const store = tx.store;
    const index = store.index('batchId_status');

    const [localCount, pendingCount, uploadingCount] = await Promise.all([
        store.index('batchId').count(batchId),
        index.count(IDBKeyRange.only([batchId, 'pending_upload'])),
        index.count(IDBKeyRange.only([batchId, 'uploading']))
    ]);

    return {
        localCount,
        pendingCount: pendingCount + uploadingCount
    };
}
