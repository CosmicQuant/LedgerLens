export const state = {
    currentUser: null,
    clientName: '',
    batchId: '',
    snapCounter: 0,
    pendingCount: 0,
    mediaStream: null,
    isUploading: false,
    uploadTimer: null,
    uploadRetryDelay: 15000,
    extractionUnsubscribe: null,
    activeObjectURLs: new Map(), // id -> objectURL

    // Helpers to update state and UI optionally
    setClientName(name) { this.clientName = name; },
    setBatchId(id) { this.batchId = id; },
    incrementSnap() { this.snapCounter++; },
    decrementSnap() { this.snapCounter = Math.max(0, this.snapCounter - 1); },
    reset() {
        this.clientName = '';
        this.batchId = '';
        this.snapCounter = 0;
        this.pendingCount = 0;
        this.isUploading = false;
        this.activeObjectURLs.clear();
    }
};
