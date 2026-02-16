"""
LedgerLens — Cloud Function: Excel Report Export
Generates a professionally formatted Excel audit report for a batch
using pandas + XlsxWriter, with permanent Firebase Storage download URLs.
"""

import io
import os
import uuid
import json
from datetime import datetime

import firebase_admin
from firebase_admin import auth, firestore, storage, initialize_app
from firebase_functions import https_fn, options


# ────────────────────────────────────────────────────────
# Firebase References (admin already initialized in main.py)
# ────────────────────────────────────────────────────────



# ────────────────────────────────────────────────────────
# Permanent Download URL Builder
# ────────────────────────────────────────────────────────
def get_permanent_download_url(bucket_name: str, file_path: str, token: str) -> str:
    """
    Construct a permanent Firebase Storage download URL using the
    firebaseStorageDownloadTokens metadata. This URL never expires
    (unlike 7-day signed URLs).
    """
    encoded_path = file_path.replace("/", "%2F")
    return (
        f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}"
        f"/o/{encoded_path}?alt=media&token={token}"
    )


def ensure_storage_token(blob) -> str:
    """
    Get or create a permanent download token for a Storage blob.
    Uses the firebaseStorageDownloadTokens metadata field.
    """
    blob.reload()
    metadata = blob.metadata or {}
    token = metadata.get("firebaseStorageDownloadTokens")
    if not token:
        token = str(uuid.uuid4())
        blob.metadata = {**(blob.metadata or {}), "firebaseStorageDownloadTokens": token}
        blob.patch()
    return token


# ────────────────────────────────────────────────────────
# Excel Generation Engine
# ────────────────────────────────────────────────────────
def generate_excel_report(batch_id: str, db) -> tuple[bytes, str]:
    """
    Queries all receipts for the batch, builds a formatted Excel workbook,
    and returns the bytes + suggested filename.
    """

    # ── 1. Fetch batch metadata ──────────────────────────
    import pandas as pd
    import xlsxwriter

    batch_ref = db.collection("batches").document(batch_id)
    batch_doc = batch_ref.get()
    if not batch_doc.exists:
        raise ValueError(f"Batch '{batch_id}' not found.")

    batch_data = batch_doc.to_dict()
    client_name = batch_data.get("clientName", "Unknown")
    audit_cycle = batch_data.get("auditCycle", "")

    # ── 2. Fetch all receipts ────────────────────────────
    receipts_ref = batch_ref.collection("receipts")
    receipt_docs = receipts_ref.order_by("uploadedAt").stream()

    rows = []
    bucket = storage.bucket()

    for doc in receipt_docs:
        data = doc.to_dict()
        ext = data.get("extractedData", {})
        storage_path = data.get("storagePath", "")

        # Build permanent link for the receipt image
        image_link = ""
        if storage_path:
            try:
                blob = bucket.blob(storage_path)
                token = ensure_storage_token(blob)
                image_link = get_permanent_download_url(
                    bucket.name, storage_path, token
                )
            except Exception as e:
                print(f"[Warn] Could not get URL for {storage_path}: {e}")

        rows.append({
            "Receipt ID":      doc.id,
            "Date":            ext.get("date", ""),
            "Vendor":          ext.get("vendor", ""),
            "Total":           ext.get("total", 0),
            "Tax":             ext.get("tax", 0),
            "Category":        ext.get("category", ""),
            "Invoice #":       ext.get("invoice_number", ""),
            "Confidence":      ext.get("confidence_score", 0),
            "Duplicate":       ext.get("flag_duplicate", False),
            "Image Link":      image_link,
        })

    if not rows:
        raise ValueError("No receipts found in this batch.")

    df = pd.DataFrame(rows)

    # ── 3. Write Excel with XlsxWriter ──────────────────
    buffer = io.BytesIO()
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"LedgerLens_{client_name}_{audit_cycle}_{timestamp}.xlsx"
    safe_filename = "".join(c if c.isalnum() or c in "._- " else "_" for c in filename)

    with pd.ExcelWriter(buffer, engine="xlsxwriter") as writer:
        sheet_name = "Audit Report"
        df.to_excel(writer, index=False, sheet_name=sheet_name, startrow=3)

        workbook  = writer.book
        worksheet = writer.sheets[sheet_name]

        # ── Formats ─────────────────────────────────────
        fmt_title = workbook.add_format({
            "bold": True,
            "font_size": 18,
            "font_color": "#1a1a2e",
            "font_name": "Calibri",
        })
        fmt_subtitle = workbook.add_format({
            "font_size": 11,
            "font_color": "#555555",
            "font_name": "Calibri",
        })
        fmt_header = workbook.add_format({
            "bold": True,
            "font_size": 11,
            "font_color": "#ffffff",
            "bg_color": "#2d3250",
            "border": 1,
            "border_color": "#1a1a2e",
            "text_wrap": True,
            "valign": "vcenter",
            "align": "center",
            "font_name": "Calibri",
        })
        fmt_cell = workbook.add_format({
            "font_size": 10,
            "font_name": "Calibri",
            "border": 1,
            "border_color": "#d0d0d0",
            "valign": "vcenter",
        })
        fmt_currency = workbook.add_format({
            "font_size": 10,
            "font_name": "Calibri",
            "border": 1,
            "border_color": "#d0d0d0",
            "num_format": "#,##0.00",
            "valign": "vcenter",
        })
        fmt_flag_row = workbook.add_format({
            "font_size": 10,
            "font_name": "Calibri",
            "border": 1,
            "border_color": "#d0d0d0",
            "bg_color": "#FFD6D6",
            "font_color": "#990000",
            "valign": "vcenter",
        })
        fmt_flag_currency = workbook.add_format({
            "font_size": 10,
            "font_name": "Calibri",
            "border": 1,
            "border_color": "#d0d0d0",
            "bg_color": "#FFD6D6",
            "font_color": "#990000",
            "num_format": "#,##0.00",
            "valign": "vcenter",
        })
        fmt_link = workbook.add_format({
            "font_size": 10,
            "font_name": "Calibri",
            "font_color": "#0066cc",
            "underline": True,
            "border": 1,
            "border_color": "#d0d0d0",
            "valign": "vcenter",
        })

        # ── Title rows ──────────────────────────────────
        worksheet.merge_range("A1:J1", f"LedgerLens Audit Report — {client_name}", fmt_title)
        worksheet.merge_range(
            "A2:J2",
            f"Cycle: {audit_cycle}  |  Batch: {batch_id}  |  Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}",
            fmt_subtitle,
        )

        # ── Header row (row index 3) ────────────────────
        for col_idx, col_name in enumerate(df.columns):
            worksheet.write(3, col_idx, col_name, fmt_header)

        # ── Data rows ───────────────────────────────────
        for row_idx, row in df.iterrows():
            excel_row = row_idx + 4  # data starts at row 4 (0-indexed)

            # Determine if this row should be flagged (red)
            is_flagged = (
                row.get("Confidence", 100) < 80
                or row.get("Duplicate", False) is True
            )

            cell_fmt = fmt_flag_row if is_flagged else fmt_cell
            money_fmt = fmt_flag_currency if is_flagged else fmt_currency

            for col_idx, col_name in enumerate(df.columns):
                value = row[col_name]

                if col_name in ("Total", "Tax"):
                    worksheet.write_number(excel_row, col_idx, float(value or 0), money_fmt)
                elif col_name == "Image Link" and value:
                    worksheet.write_url(
                        excel_row, col_idx, str(value),
                        fmt_link, string="View Receipt"
                    )
                elif col_name == "Duplicate":
                    worksheet.write(excel_row, col_idx, "YES" if value else "No", cell_fmt)
                elif col_name == "Confidence":
                    worksheet.write_number(excel_row, col_idx, int(value or 0), cell_fmt)
                else:
                    worksheet.write(excel_row, col_idx, str(value) if value else "", cell_fmt)

        # ── Column widths ───────────────────────────────
        col_widths = [14, 12, 22, 12, 10, 16, 14, 12, 10, 16]
        for i, w in enumerate(col_widths):
            worksheet.set_column(i, i, w)

        # ── Summary row ─────────────────────────────────
        summary_row = len(df) + 5
        worksheet.write(summary_row, 0, "TOTALS", workbook.add_format({
            "bold": True, "font_size": 11, "font_name": "Calibri",
        }))
        total_col = list(df.columns).index("Total")
        tax_col = list(df.columns).index("Tax")
        worksheet.write_formula(
            summary_row, total_col,
            f"=SUM({chr(65+total_col)}5:{chr(65+total_col)}{len(df)+4})",
            fmt_currency,
        )
        worksheet.write_formula(
            summary_row, tax_col,
            f"=SUM({chr(65+tax_col)}5:{chr(65+tax_col)}{len(df)+4})",
            fmt_currency,
        )

        # Freeze panes: header row
        worksheet.freeze_panes(4, 0)

    buffer.seek(0)
    return buffer.getvalue(), safe_filename


# ────────────────────────────────────────────────────────
# Authentication Helper
# ────────────────────────────────────────────────────────
def verify_request_auth(req) -> dict:
    """
    Extract and verify the Firebase ID token from the Authorization header.
    Returns the decoded token payload, or raises ValueError on failure.
    """
    auth_header = req.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise ValueError("Missing or malformed Authorization header.")

    id_token = auth_header.split("Bearer ", 1)[1].strip()
    if not id_token:
        raise ValueError("Empty bearer token.")

    # Verify with Firebase Admin SDK — raises on invalid/expired tokens
    decoded = auth.verify_id_token(id_token)
    return decoded


# ────────────────────────────────────────────────────────
# Cloud Function — HTTPS Callable (Authenticated)
# ────────────────────────────────────────────────────────
@https_fn.on_request(
    region="us-central1",
    memory=options.MemoryOption.GB_1,
    timeout_sec=300,
    max_instances=5,
    cors=options.CorsOptions(
        cors_origins="*",
        cors_methods=["POST", "OPTIONS"],
    ),
)
def export_batch(req: https_fn.Request) -> https_fn.Response:
    """
    HTTP Cloud Function to export a batch of receipts to an Excel file.
    """
    if not firebase_admin._apps:
        initialize_app()
    db = firestore.client()

    # ── SECURITY Check ────────────────────────────────
    try:
        decoded_token = verify_request_auth(req)
        caller_uid = decoded_token["uid"]
    except Exception as auth_err:
        return https_fn.Response(
            json={"error": "Unauthorized"},
            status=401,
        )

    try:
        body = req.get_json(silent=True) or {}
        batch_id = body.get("batch_id")
        if not batch_id:
            return https_fn.Response(
                json={"error": "Missing required field: batch_id"},
                status=400,
            )

        # ── SECURITY: Verify caller owns this batch ──────
        batch_doc = db.collection("batches").document(batch_id).get()
        if not batch_doc.exists:
            return https_fn.Response(
                json={"error": "Batch not found."},
                status=404,
            )
        batch_owner = batch_doc.to_dict().get("ownerId")
        if batch_owner != caller_uid:
            print(f"[Export] Ownership mismatch: batch owner={batch_owner}, caller={caller_uid}")
            return https_fn.Response(
                json={"error": "Access denied. You do not own this batch."},
                status=403,
            )

        # Generate the Excel report
        excel_bytes, filename = generate_excel_report(batch_id, db)

        # Upload to Firebase Storage
        export_path = f"exports/{batch_id}/{filename}"
        bucket = storage.bucket()
        blob = bucket.blob(export_path)
        blob.upload_from_string(
            excel_bytes,
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

        # Create permanent download token
        token = str(uuid.uuid4())
        blob.metadata = {"firebaseStorageDownloadTokens": token}
        blob.patch()

        download_url = get_permanent_download_url(bucket.name, export_path, token)

        return https_fn.Response(
            response=json.dumps({
                "download_url": download_url,
                "filename": filename,
            }),
            status=200,
            mimetype="application/json"
        )

    except ValueError as e:
        return https_fn.Response(
            response=json.dumps({"error": str(e)}),
            status=404,
            mimetype="application/json"
        )
    except Exception as e:
        # SECURITY: Log real error server-side, return generic message to client
        print(f"[Export Error] {e}")
        return https_fn.Response(
            response=json.dumps({"error": "An internal error occurred. Please try again."}),
            status=500,
            mimetype="application/json"
        )
