import os
import json
import io
import requests
from datetime import datetime

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

OUTPUT_DIR = "output"
DATA_FILE = "report-data.json"


def require_file(path: str):
    if not os.path.exists(path):
        raise RuntimeError(f"Required file missing: {path}")


def fmt_miles(x) -> str:
    try:
        return f"{float(x):.2f}"
    except Exception:
        return "0.00"


def format_report_date(yyyy_mm_dd: str) -> str:
    """
    Input:  YYYY-MM-DD
    Output: Month D, YYYY  (e.g., March 1, 2026)
    """
    try:
        dt = datetime.strptime(yyyy_mm_dd, "%Y-%m-%d")
        # Portable "day without leading zero"
        day = str(int(dt.strftime("%d")))
        return f"{dt.strftime('%B')} {day}, {dt.strftime('%Y')}"
    except Exception:
        return yyyy_mm_dd


def safe_logo_reader(url: str):
    """
    Returns an ImageReader or None.
    Uses BytesIO to reliably pass image bytes to ReportLab.
    """
    if not url:
        return None
    try:
        r = requests.get(
            url,
            timeout=25,
            allow_redirects=True,
            headers={"User-Agent": "strava-daily-report/1.0"},
        )
        r.raise_for_status()

        # Some hosts return HTML instead of an image; quick sanity check.
        ctype = (r.headers.get("Content-Type") or "").lower()
        if "image" not in ctype:
            # Still try (some hosts don't set content-type correctly), but this helps.
            pass

        return ImageReader(io.BytesIO(r.content))
    except Exception:
        return None


def pdf_sanity_check(path: str):
    if not os.path.exists(path):
        raise RuntimeError(f"PDF not created: {path}")

    size = os.path.getsize(path)
    if size < 1200:
        raise RuntimeError(f"PDF too small/corrupt (size={size} bytes): {path}")

    with open(path, "rb") as f:
        if f.read(5) != b"%PDF-":
            raise RuntimeError(f"PDF header invalid (not %PDF-): {path}")


def main():
    require_file(DATA_FILE)

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    report_date_raw = data.get("reportDate", "YYYY-MM-DD")
    report_date_pretty = format_report_date(report_date_raw)

    rows = data.get("rows", [])
    inactive = data.get("inactive", [])
    totals = data.get("totals", {})

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    pdf_name = f"strava-daily-report-{report_date_raw}.pdf"
    pdf_path = os.path.join(OUTPUT_DIR, pdf_name)

    logo_url = os.environ.get("STRAVA_LOGO_URL", "").strip()
    logo = safe_logo_reader(logo_url)

    c = canvas.Canvas(pdf_path, pagesize=letter)
    width, height = letter
    margin = 0.5 * inch
    y = height - margin

    # Full-width banner logo (optional)
    banner_h = 0.8 * inch
    if logo:
        try:
            c.drawImage(
                logo,
                margin,
                y - banner_h,
                width=(width - 2 * margin),
                height=banner_h,
                preserveAspectRatio=True,
                anchor="c",
                mask="auto",
            )
        except Exception:
            # If logo fails to draw for any reason, continue without it.
            pass
    y -= (banner_h + 0.25 * inch)

    # Title + date (pretty) + timezone label
    c.setFont("Helvetica-Bold", 16)
    c.drawString(margin, y, "Strava Daily Report")
    y -= 0.28 * inch

    c.setFont("Helvetica", 11)
    c.drawString(margin, y, f"Report date: {report_date_pretty} (Central Time)")
    y -= 0.28 * inch

    c.setFont("Helvetica", 9)
    c.drawString(
        margin,
        y,
        f"Members: {totals.get('members','?')}  |  Active: {totals.get('activeMembers','?')}  |  No Activity: {totals.get('inactiveMembers','?')}  |  Activities included: {totals.get('activitiesInWindow','?')}",
    )
    y -= 0.30 * inch

    # Headers
    c.setFont("Helvetica-Bold", 11)
    col_w = (width - 2 * margin) / 4.0
    headers = ["WALK", "RUN", "RIDE", "HIKE / NO ACTIVITY"]
    for i, h in enumerate(headers):
        c.drawString(margin + i * col_w, y, h)
    y -= 0.15 * inch
    c.line(margin, y, width - margin, y)
    y -= 0.25 * inch

    # Build column lines
    walk_lines, run_lines, ride_lines, hike_lines = [], [], [], []

    for r in rows:
        name = r.get("name", "—")
        w = float(r.get("Walk", 0.0) or 0.0)
        rn = float(r.get("Run", 0.0) or 0.0)
        rd = float(r.get("Ride", 0.0) or 0.0)
        hk = float(r.get("Hike", 0.0) or 0.0)

        if w > 0:
            walk_lines.append(f"{name}  {fmt_miles(w)} mi")
        if rn > 0:
            run_lines.append(f"{name}  {fmt_miles(rn)} mi")
        if rd > 0:
            ride_lines.append(f"{name}  {fmt_miles(rd)} mi")
        if hk > 0:
            hike_lines.append(f"{name}  {fmt_miles(hk)} mi")

    # NO ACTIVITY block in 4th column
    hike_lines.append("")
    hike_lines.append("NO ACTIVITY")
    hike_lines.append("—" * 18)
    for m in inactive:
        hike_lines.append(f"{m.get('name','—')}  0.00 mi")

    columns = [walk_lines, run_lines, ride_lines, hike_lines]
    max_lines = max(len(col) for col in columns) if columns else 0

    c.setFont("Helvetica", 9)
    line_h = 0.18 * inch
    y_min = margin + 0.75 * inch

    def new_page():
        nonlocal y
        c.showPage()
        y = height - margin
        c.setFont("Helvetica-Bold", 14)
        c.drawString(margin, y, f"Strava Daily Report (continued) — {report_date_pretty}")
        y -= 0.35 * inch

        c.setFont("Helvetica-Bold", 11)
        for i, h in enumerate(headers):
            c.drawString(margin + i * col_w, y, h)
        y -= 0.15 * inch
        c.line(margin, y, width - margin, y)
        y -= 0.25 * inch

        c.setFont("Helvetica", 9)

    for i in range(max_lines):
        if y < y_min:
            new_page()

        for col_i in range(4):
            text = columns[col_i][i] if i < len(columns[col_i]) else ""
            if text:
                c.drawString(margin + col_i * col_w, y, text)

        y -= line_h

    c.save()
    pdf_sanity_check(pdf_path)
    print(f"PDF generated OK: {pdf_path}")


if __name__ == "__main__":
    main()
