/**
 * sync.js — Concurrency Wrapper
 * 
 * Redirects to the Unified PipelineController (uploader.js).
 * Maintains backward compatibility for UI calls.
 */

import { uploader } from './uploader.js';

export function uploadPending() {
    uploader.processNetworkQueue();
}

/** Legacy Scheduler support */
export function scheduleUpload(delay) {
    setTimeout(() => uploadPending(), delay);
}
