"""
LedgerLens — Cloud Function: Receipt AI Extraction
Trigger: storage_fn.on_object_finalized
Runtime: Python 3.11

Extracts structured data from receipt images using Google Gemini 1.5 Flash
via Vertex AI. Stores results in Firestore with duplicate detection.
"""

import hashlib
import json
import os
import random
import re
import time

import firebase_admin
from firebase_admin import credentials, firestore, initialize_app, storage
from google.cloud.firestore_v1.base_query import FieldFilter
from firebase_functions import options, storage_fn

# Type hints for Firebase sentinel values
from typing import Optional, Dict, Any



# Import export function so Firebase discovers it at deploy time
from export import export_batch  # noqa: F401, E402

# ────────────────────────────────────────────────────────
# Gemini Configuration
# ────────────────────────────────────────────────────────
# The API key is stored in Firebase Secrets Manager and exposed
# as an environment variable via firebase functions:secrets:set
# GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") <-- Configured locally



DEFAULT_CATEGORIES = [
    "Food & Beverage", "Office Supplies", "Travel", "Fuel",
    "Utilities", "Medical", "Equipment", "Services", "Miscellaneous"
]

EXTRACTION_PROMPT_TEMPLATE = """You are a professional auditor and receipt data extraction expert.
Analyze the provided receipt/invoice image and extract the following structured fields.

Return ONLY a valid JSON object with these exact keys:
{{
  "date": "YYYY-MM-DD (format as ISO 8601 if possible)",
  "vendor": "Official business name",
  "total": "Numeric total amount including tax",
  "tax": "Numeric tax amount (0.0 if not found)",
  "category": "One of: {categories}",
  "invoice_number": "Invoice/Receipt reference number",
  "confidence_score": 0-100 (integer)
}}

Rules:
1. If the image is not a receipt or invoice, return category "Invalid" and empty strings/0.
2. Ensure 'total' and 'tax' are pure numbers (e.g. 1250.00, not "1,250.00").
3. Use your best judgment for 'category' based on the vendor and items.
4. You MUST categorize into one of the categories listed above. Pick the closest match.
5. Output ONLY the raw JSON string. No preamble, no markdown formatting.
"""


def build_extraction_prompt(categories: list = None) -> str:
    """Build the Gemini prompt with custom or default categories."""
    cats = categories if categories else DEFAULT_CATEGORIES
    return EXTRACTION_PROMPT_TEMPLATE.format(categories=", ".join(cats))





# ────────────────────────────────────────────────────────
# Gemini Extraction
# ────────────────────────────────────────────────────────
def extract_receipt_data(image_bytes: bytes, categories: list = None) -> dict:
    """Send receipt image to Gemini with retry + exponential backoff."""
    from google import genai
    from google.genai import types
    
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY environment variable not set.")
        
    client = genai.Client(api_key=api_key)

    # Build prompt with custom or default categories
    prompt = build_extraction_prompt(categories)

    # Models to try in order of preference
    models_to_try = [
        "gemini-flash-latest",
        "gemini-flash-lite-latest"
    ]

    last_error = None

    for model_id in models_to_try:
        # Retry each model up to 3 times with exponential backoff
        for attempt in range(3):
            try:
                if attempt > 0:
                    delay = (2 ** attempt) + random.uniform(0, 1)
                    print(f"[Gemini] Retry {attempt} for {model_id} after {delay:.1f}s")
                    time.sleep(delay)

                print(f"[Gemini] Attempting extraction with {model_id} (attempt {attempt + 1}/3)")
                
                response = client.models.generate_content(
                    model=model_id,
                    contents=[
                        prompt,
                        types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")
                    ],
                    config=types.GenerateContentConfig(
                        temperature=0.1,
                        max_output_tokens=1024,
                    )
                )

                raw_text = response.text.strip()

                # Clean potential markdown fences
                if raw_text.startswith("```"):
                    raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
                    raw_text = re.sub(r"\s*```$", "", raw_text)

                # Robust JSON extraction
                json_match = re.search(r"\{.*\}", raw_text, re.DOTALL)
                if json_match:
                    raw_text = json_match.group(0)
                
                # Final attempt to clean trailing commas or weirdness
                raw_text = re.sub(r",\s*\}", "}", raw_text)

                data = json.loads(raw_text)

                # Validate / enforce schema
                return {
                    "date":             str(data.get("date", "")),
                    "vendor":           str(data.get("vendor", "")),
                    "total":            _to_float(data.get("total", 0)),
                    "tax":              _to_float(data.get("tax", 0)),
                    "category":         str(data.get("category", "Miscellaneous")),
                    "invoice_number":   str(data.get("invoice_number", "")),
                    "confidence_score": int(data.get("confidence_score", 0)),
                    "model_used":       model_id
                }

            except Exception as e:
                last_error = e
                error_str = str(e).lower()
                # Only retry on rate-limit or transient errors
                is_retryable = any(kw in error_str for kw in ['429', 'resource_exhausted', 'rate', 'quota', 'overloaded', 'unavailable', '503', '500'])
                
                if is_retryable and attempt < 2:
                    print(f"[Gemini] {model_id} retryable error (attempt {attempt + 1}): {e}")
                    continue  # retry same model
                else:
                    print(f"[Gemini] {model_id} error (attempt {attempt + 1}): {e}")
                    break  # move to next model

    print(f"[Gemini] All models failed after retries. Last error: {last_error}")
    raise RuntimeError(f"All Gemini models failed: {last_error}")


def _to_float(val) -> float:
    """Safely parse a numeric value."""
    try:
        cleaned = re.sub(r"[^\d.\-]", "", str(val))
        return round(float(cleaned), 2) if cleaned else 0.0
    except (ValueError, TypeError):
        return 0.0


def _fallback_data(confidence: int) -> dict:
    return {
        "date": "",
        "vendor": "",
        "total": 0.0,
        "tax": 0.0,
        "category": "Miscellaneous",
        "invoice_number": "",
        "confidence_score": confidence,
    }


def compute_receipt_hash(data: dict) -> str:
    """Generate a deterministic hash for duplicate detection.
    Uses normalized vendor + total + date + invoice_number."""
    
    def norm(s):
        return str(s).lower().strip().replace(" ", "")

    # Create a string that ignores case/whitespace differences
    raw = f"{norm(data.get('vendor', ''))}|{norm(data.get('total', ''))}|{norm(data.get('date', ''))}|{norm(data.get('invoice_number', ''))}"
    return hashlib.md5(raw.encode()).hexdigest()


# ────────────────────────────────────────────────────────
# Cloud Function — Storage Trigger
# ────────────────────────────────────────────────────────
# ────────────────────────────────────────────────────────
# Cloud Function — Storage Trigger
# ────────────────────────────────────────────────────────
@storage_fn.on_object_finalized(
    region="us-central1",
    memory=options.MemoryOption.GB_1,
    timeout_sec=300,
    max_instances=20,
    secrets=["GEMINI_API_KEY"],
)
def on_receipt_upload(event: storage_fn.CloudEvent[storage_fn.StorageObjectData]):
    """
    Triggered when a receipt image is uploaded to Firebase Storage.
    """
    file_path = None
    batch_id = None
    receipt_id = None
    
    try:
        if not firebase_admin._apps:
            initialize_app()
        
        file_path = event.data.name
        bucket_name = event.data.bucket

        # Guard: only process receipt images
        if not file_path or not file_path.startswith("receipts/"):
            return
        if not file_path.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            return

        parts = file_path.split("/")
        if len(parts) < 3: return
        batch_id, receipt_id = parts[1], parts[2].rsplit(".", 1)[0]

        process_receipt_extraction(batch_id, receipt_id, bucket_name, file_path)

    except Exception as e:
        print(f"[ERROR] on_receipt_upload failed for {file_path}: {str(e)}")
        # CRITICAL: Set error status so the receipt doesn't stay stuck
        if batch_id and receipt_id:
            try:
                db = firestore.client()
                db.collection("batches").document(batch_id).collection("receipts").document(receipt_id).set({
                    "status": "error",
                    "error_message": f"Upload trigger failed: {str(e)}",
                    "processedAt": firestore.SERVER_TIMESTAMP  # type: ignore
                }, merge=True)
            except Exception as inner_e:
                print(f"[ERROR] Could not set error status: {inner_e}")


# ────────────────────────────────────────────────────────
# Core Extraction Helper
# ────────────────────────────────────────────────────────
def process_receipt_extraction(batch_id: str, receipt_id: str, bucket_name: str, file_path: str):
    """
    Downloads image, runs AI extraction, and updates Firestore.
    Shared by storage trigger and manual retry trigger.
    """
    if not firebase_admin._apps: initialize_app()
    db = firestore.client()
    
    # Stagger: random 0-1s delay to spread simultaneous Gemini calls
    stagger = random.uniform(0, 1.0)
    print(f"[Process] Staggering {stagger:.1f}s before processing {receipt_id}")
    time.sleep(stagger)
    
    try:
        print(f"[Process] batch={batch_id} receipt={receipt_id} path={file_path}")

        # Read batch doc for custom categories
        batch_doc = db.collection("batches").document(batch_id).get()
        custom_categories = None
        if batch_doc.exists:
            batch_data = batch_doc.to_dict()
            custom_categories = batch_data.get("expenseCategories")
            if custom_categories:
                print(f"[Process] Using {len(custom_categories)} custom categories")

        # Download the image
        bucket = storage.bucket(bucket_name)
        blob = bucket.blob(file_path)
        image_bytes = blob.download_as_bytes()

        # ── IDEMPOTENCY CHECK (Cost Optimization) ────────────────
        image_hash_sha256 = hashlib.sha256(image_bytes).hexdigest()
        
        # Check global receipts for this image hash
        existing_docs = db.collection_group("receipts")\
                          .where(filter=FieldFilter("image_hash_sha256", "==", image_hash_sha256))\
                          .limit(1).get()

        if existing_docs:
            print(f"[Idempotency] Found match for {image_hash_sha256[:8]}...")
            existing_data: Optional[Dict[str, Any]] = existing_docs[0].to_dict()
            
            if existing_data and existing_data.get("status") == "extracted":
                print("[Idempotency] Skipping Gemini call. Copying data.")
                reused_data = existing_data["extractedData"]
                reused_data["source"] = "cache_hit"
                
                # Check if this is a duplicate in the SAME batch
                is_duplicate = False
                duplicate_of = None
                try:
                    existing_ref = existing_docs[0].reference
                    # reference -> collection(receipts) -> document(batch)
                    existing_batch_id = existing_ref.parent.parent.id
                    if existing_batch_id == batch_id:
                        is_duplicate = True
                        duplicate_of = existing_docs[0].id
                        reused_data["flag_duplicate"] = True
                except Exception as e:
                    print(f"[Warning] Idempotency batch check failed: {e}")

                _finalize_extraction(db, batch_id, receipt_id, reused_data, image_hash_sha256, is_duplicate=is_duplicate, duplicate_of=duplicate_of)
                return

        # ── GEMINI EXTRACTION ────────────────────────────────────
        extracted = extract_receipt_data(image_bytes, custom_categories)
        receipt_hash = compute_receipt_hash(extracted)
        
        # Duplicate detection within batch
        is_duplicate = False
        duplicate_of = None
        try:
            batch_ref = db.collection("batches").document(batch_id).collection("receipts")
            existing_query = batch_ref.where(filter=FieldFilter("receipt_hash", "==", receipt_hash)).limit(2).stream()
            for doc in existing_query:
                if doc.id != receipt_id:
                    is_duplicate = True
                    duplicate_of = doc.id
                    break
        except Exception as q_err:
            print(f"[Warning] Duplicate check failed: {q_err}")
        
        extracted["flag_duplicate"] = is_duplicate
        _finalize_extraction(db, batch_id, receipt_id, extracted, image_hash_sha256, receipt_hash, is_duplicate, duplicate_of)

    except Exception as e:
        print(f"[ERROR] Extraction failed for {receipt_id}: {e}")
        db.collection("batches").document(batch_id).collection("receipts").document(receipt_id).set({
            "status": "error",
            "error_message": str(e),
            "processedAt": firestore.SERVER_TIMESTAMP  # type: ignore
        }, merge=True)


def _finalize_extraction(db, batch_id: str, receipt_id: str, data: dict, img_hash: str, receipt_hash: str = "", is_duplicate: bool = False, duplicate_of: Optional[str] = None):
    """Updates Firestore and increments batch count if not already done."""
    receipt_ref = db.collection("batches").document(batch_id).collection("receipts").document(receipt_id)
    
    # Check if this receipt was already counted as 'extracted'
    snap = receipt_ref.get()
    was_extracted = snap.exists and snap.to_dict().get("extracted") is True

    update_data = {
        "extracted": True,
        "extractedData": data,
        "receipt_hash": receipt_hash or data.get("receipt_hash", ""),
        "image_hash_sha256": img_hash,
        "processedAt": firestore.SERVER_TIMESTAMP,  # type: ignore
        "status": "extracted",
        "flag_duplicate": is_duplicate,
    }
    
    if duplicate_of:
        update_data["duplicate_of"] = duplicate_of
    
    receipt_ref.set(update_data, merge=True)

    if is_duplicate:
        print(f"[Duplicate] Receipt {receipt_id} is a duplicate of {duplicate_of}")

    if not was_extracted:
        print(f"[Firestore] Incrementing count for batch {batch_id}")
        db.collection("batches").document(batch_id).set({
            "receiptCount": firestore.Increment(1)  # type: ignore
        }, merge=True)


# ────────────────────────────────────────────────────────
# Cloud Function — Firestore Trigger (Retry)
# ────────────────────────────────────────────────────────
from firebase_functions import firestore_fn

@firestore_fn.on_document_updated(
    document="batches/{batch_id}/receipts/{receipt_id}",
    secrets=["GEMINI_API_KEY"]
)
def on_receipt_retry(event: firestore_fn.Event[firestore_fn.Change[firestore_fn.DocumentSnapshot]]):
    """
    Triggered when a receipt document is updated.
    Listens for status == 'pending_retry'.
    """
    if not event.data: return
    
    new_data = event.data.after.to_dict()
    old_data = event.data.before.to_dict()
    
    if not new_data or not old_data: return

    # Trigger only if status CHANGED to 'pending_retry'
    if new_data.get("status") == "pending_retry" and old_data.get("status") != "pending_retry":
        print(f"[Retry] Triggered for {event.params['receipt_id']}")
        
        batch_id = event.params["batch_id"]
        receipt_id = event.params["receipt_id"]
        
        # We need the storage path
        file_path = new_data.get("storagePath") or new_data.get("file_path")
        if not file_path:
            ext = new_data.get("file_extension", "webp")
            file_path = f"receipts/{batch_id}/{receipt_id}.{ext}"
            
        if not firebase_admin._apps: initialize_app()
        bucket_name = storage.bucket().name
        process_receipt_extraction(batch_id, receipt_id, bucket_name, file_path)
