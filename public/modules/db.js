import { openPreview, showToast, updateFinishButton, updateThumbnailStatus } from './ui.js';

const IDB_NAME = 'ledgerlens-db';
const IDB_VERSION = 1;
const STORE_NAME = 'receipts';

let idbInstance = null;

export async function getIDB() {
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

export async function getPendingUploads(batchId) {
    const database = await getIDB();
    let pending = await database.getAllFromIndex(STORE_NAME, 'status', 'pending_upload');
    return pending.filter(r => r.batchId === batchId);
}
