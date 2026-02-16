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
import re

import firebase_admin
from firebase_admin import credentials, firestore, initialize_app, storage
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



EXTRACTION_PROMPT = """You are a professional receipt/invoice data extraction AI.
Analyze the receipt image provided and extract the following fields.
Return ONLY a valid JSON object with these exact keys:

{
  "date": "YYYY-MM-DD or original format if ambiguous",
  "vendor": "Business/store name",
  "total": "Total amount as a number (no currency symbol)",
  "tax": "Tax amount as a number (0 if not found)",
  "category": "One of: Food & Beverage, Office Supplies, Travel, Fuel, Utilities, Medical, Equipment, Services, Miscellaneous",
  "invoice_number": "Invoice or receipt number (empty string if not found)",
  "confidence_score": 0-100 integer indicating extraction confidence
}

Rules:
- If the image is NOT a receipt or invoice, return a JSON with all fields empty strings/0 and set category to "Invalid".
- Return raw numeric values for total and tax (e.g. 42.50 not "$42.50").
- If a field is unreadable, use an empty string "" for text or 0 for numbers.
- confidence_score: 90-100 if all fields clearly readable, 60-89 if some fields
  are guessed, below 60 if image is blurry or data is mostly unreadable.
- Return ONLY the JSON object, no markdown fences or extra text.
"""





# ────────────────────────────────────────────────────────
# Gemini Extraction
# ────────────────────────────────────────────────────────
def extract_receipt_data(image_bytes: bytes) -> dict:
    """Send receipt image to Gemini with fallback to smaller model if needed."""
    import google.generativeai as genai
    
    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key:
        genai.configure(api_key=api_key)

    # Models to try in order of preference
    models_to_try = [
        "gemini-flash-latest",
        "gemini-flash-lite-latest"
    ]

    # Build the image part for Gemini
    image_part = {
        "mime_type": "image/jpeg",
        "data": image_bytes,
    }

    for model_name in models_to_try:
        try:
            print(f"[Gemini] Attempting extraction with {model_name}...")
            model = genai.GenerativeModel(model_name)
            response = model.generate_content(
                [EXTRACTION_PROMPT, image_part],
                generation_config=genai.GenerationConfig(
                    temperature=0.1,
                    max_output_tokens=1024,
                ),
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
                "model_used":       model_name
            }

        except json.JSONDecodeError as e:
            print(f"[Gemini] {model_name} parse error: {e}")
            # Try next model or fallback
            continue
        except Exception as e:
            print(f"[Gemini] {model_name} error: {e}")
            # Try next model (quota, server error, etc)
            continue

    print("[Gemini] All models failed.")
    # Raise error to be caught by caller instead of returning fallback
    raise RuntimeError("All Gemini models failed to extract data.")


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
    """Generate a simple deterministic hash for duplicate detection."""
    raw = f"{data.get('vendor')}|{data.get('total')}|{data.get('date')}"
    return hashlib.md5(raw.encode()).hexdigest()


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
    try:
        if not firebase_admin._apps:
            initialize_app()
        db = firestore.client()
        
        file_path = event.data.name
        bucket_name = event.data.bucket

        # Guard: only process receipt images
        if not file_path or not file_path.startswith("receipts/"):
            return
        if not file_path.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            return

        # Parse batch_id and receipt_id from path
        parts = file_path.split("/")
        if len(parts) < 3: return

        batch_id = parts[1]
        receipt_id = parts[2].rsplit(".", 1)[0]

        print(f"[Process] batch={batch_id} receipt={receipt_id} bucket={bucket_name}")

        # Download the image
        bucket = storage.bucket(bucket_name)
        blob = bucket.blob(file_path)
        image_bytes = blob.download_as_bytes()

        # ── IDEMPOTENCY CHECK (Cost Optimization) ────────────────
        # Calculate SHA256 of raw image bytes to detect duplicates BEFORE calling AI
        image_hash_sha256 = hashlib.sha256(image_bytes).hexdigest()
        
        # Check global receipts for this image hash
        # Note: Requires a single-field index on 'image_hash_sha256' if the collection grows large,
        # but works automatically for basic equality queries in Firestore.
        existing_docs = db.collection_group("receipts")\
                          .where("image_hash_sha256", "==", image_hash_sha256)\
                          .limit(1).get()

        if existing_docs:
            print(f"[Idempotency] Found existing match for hash {image_hash_sha256[:8]}...")
            existing_data: Optional[Dict[str, Any]] = existing_docs[0].to_dict()
            
            # Reuse the extraction data if available
            if existing_data and existing_data.get("extracted") and existing_data.get("extractedData"):
                print("[Idempotency] Skipping Gemini call. Copying data.")
                reused_data = existing_data["extractedData"]
                reused_data["source"] = "cache_hit" # Mark as reused
                
                # Write result immediately
                batch_ref = db.collection("batches").document(batch_id).collection("receipts")
                batch_ref.document(receipt_id).set({
                    "extracted": True,
                    "extractedData": reused_data,
                    "receipt_hash": reused_data.get("receipt_hash", ""), # Keep legacy hash
                    "image_hash_sha256": image_hash_sha256,
                    "processedAt": firestore.SERVER_TIMESTAMP,  # type: ignore
                    "status": "extracted"
                }, merge=True)
                
                # Increment count
                db.collection("batches").document(batch_id).set({
                    "receiptCount": firestore.Increment(1)  # type: ignore
                }, merge=True)
                
                return # EXIT FUNCTION
        
        # ─────────────────────────────────────────────────────────

        # Extract data via Gemini
        try:
            extracted = extract_receipt_data(image_bytes)
            
            # Compute duplicate hash (Legacy logic based on content)
            receipt_hash = compute_receipt_hash(extracted)
            
            # Check for duplicates within this batch - Wrap in TRY to prevent 403/Index crashes
            is_duplicate = False
            try:
                batch_ref = db.collection("batches").document(batch_id).collection("receipts")
                existing_query = batch_ref.where("receipt_hash", "==", receipt_hash).limit(2).stream()
                for doc in existing_query:
                    if doc.id != receipt_id:
                        is_duplicate = True
                        break
            except Exception as q_err:
                print(f"[Warning] Duplicate check failed: {q_err}")
            
            extracted["flag_duplicate"] = is_duplicate

            # Update Firestore document
            print(f"[Firestore] Updating receipt {receipt_id} in {batch_id}")
            receipt_ref = batch_ref.document(receipt_id)
            receipt_ref.set({
                "extracted": True,
                "extractedData": extracted,
                "receipt_hash": receipt_hash,
                "image_hash_sha256": image_hash_sha256, # Store for future idempotency
                "processedAt": firestore.SERVER_TIMESTAMP,  # type: ignore
                "status": "extracted" 
            }, merge=True)

            # Increment receiptCount in the parent batch document
            print(f"[Firestore] Incrementing count for batch {batch_id}")
            db.collection("batches").document(batch_id).set({
                "receiptCount": firestore.Increment(1)  # type: ignore
            }, merge=True)

            print(f"[Done] receipt={receipt_id} vendor={extracted.get('vendor')}")

        except Exception as e:
            print(f"[ERROR] Extraction failed for {receipt_id}: {e}")
            # Update Firestore with error status so client knows
            batch_ref.document(receipt_id).set({
                "status": "error",
                "error_message": str(e),
                "processedAt": firestore.SERVER_TIMESTAMP  # type: ignore
            }, merge=True)
            return

    except Exception as e:
        print(f"[ERROR] on_receipt_upload failed for {event.data.name}: {str(e)}")
        import traceback
        traceback.print_exc()
