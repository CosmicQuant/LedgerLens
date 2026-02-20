export const state = {
    currentUser: null,
    clientName: '',
    batchId: '',
    mediaStream: null,
    isUploading: false,
    uploadTimer: null,
    uploadRetryDelay: 15000,
    extractionUnsubscribe: null,
    activeObjectURLs: new Map(), // id -> objectURL

    setClientName(name) { this.clientName = name; },
    setBatchId(id) { this.batchId = id; },
    reset() {
        this.clientName = '';
        this.batchId = '';
        this.isUploading = false;
        this.activeObjectURLs.clear();
    }
};
