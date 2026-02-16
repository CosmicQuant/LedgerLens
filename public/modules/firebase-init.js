import { FIREBASE_CONFIG } from './config.js';

firebase.initializeApp(FIREBASE_CONFIG);

export const db = firebase.firestore();
export const storage = firebase.storage();
export const auth = firebase.auth();
export const functions = firebase.functions(); // Added for future use if needed, though app.js uses fetch for export
