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
    # "Month D, YYYY"
    try:
        dt = datetime.strptime(yyyy_mm_dd, "%Y-%m-%d")
        day = str(int(dt.strftime("%d")))
        return f"{dt.strftime('%B')} {day}, {dt.strftime('%Y')}"
    except Exception:
        return yyyy_mm_dd


def safe_logo_reader(url: str):
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

    # -------------------------
    # Compact header (text left, logo right)
    # -------------------------
    header_h = 1.15 * inch  # compact header height
    top_y = height - margin
    header_bottom_y = top_y - header_h

    # Split header into left text block and right logo block
    gap = 0.15 * inch
    right_w = 2.4 * inch  # logo block width
    left_x = margin
    right_x = width - margin - right_w
    left_w = (right_x - gap) - left_x

    # Logo on the right
    if logo:
        try:
            # Fit logo into right block with small padding
            pad = 0.05 * inch
            img_x = right_x + pad
            img_y = header_bottom_y + pad
            img_w = right_w - 2 * pad
            img_h = header_h - 2 * pad

            c.drawImage(
                logo,
                img_x,
                img_y,
                width=img_w,
                height=img_h,
                preserveAspectRatio=True,
                anchor="c",
                mask="auto",
            )
        except Exception:
            pass

    # Text on the left
    y = top_y
    c.setFont("Helvetica-Bold", 16)
    c.drawString(left_x, y - 0.02 * inch, "Strava Daily Report")
    y -= 0.30 * inch

    c.setFont("Helvetica", 11)
    c.drawString(left_x, y, f"Report date: {report_date_pretty} (Central Time)")
    y -= 0.22 * inch

    c.setFont("Helvetica", 9)
    summary = (
        f"Members: {totals.get('members','?')}  |  "
        f"Active: {totals.get('activeMembers','?')}  |  "
        f"No Activity: {totals.get('inactiveMembers','?')}  |  "
        f"Activities included: {totals.get('activitiesInWindow','?')}"
    )
    # Keep summary from running into logo block
    c.drawString(left_x, y, summary[:120])
    y -= 0.15 * inch

    # Divider line under header
    c.line(margin, header_bottom_y, width - margin, header_bottom_y)

    # Start table below header
    y = header_bottom_y - 0.25 * inch

    # -------------------------
    # 5-column table: Walk | Run | Ride | Hike | No Activity
    # -------------------------
    c.setFont("Helvetica-Bold", 10)
    col_w = (width - 2 * margin) / 5.0
    headers = ["WALK", "RUN", "RIDE", "HIKE", "NO ACTIVITY"]
    for i, h in enumerate(headers):
        c.drawString(margin + i * col_w, y, h)
    y -= 0.15 * inch
    c.line(margin, y, width - margin, y)
    y -= 0.25 * inch

    # Build column lines
    walk_lines, run_lines, ride_lines, hike_lines, noact_lines = [], [], [], [], []

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

    for m in inactive:
        noact_lines.append(f"{m.get('name','—')}  0.00 mi")

    columns = [walk_lines, run_lines, ride_lines, hike_lines, noact_lines]
    max_lines = max(len(col) for col in columns) if columns else 0

    c.setFont("Helvetica", 8.6)
    line_h = 0.18 * inch
    y_min = margin + 0.75 * inch

    def new_page():
        nonlocal y
        c.showPage()

        # Re-draw a simpler compact header on subsequent pages (no logo to save space)
        top_y2 = height - margin
        header_h2 = 0.70 * inch
        header_bottom_y2 = top_y2 - header_h2

        c.setFont("Helvetica-Bold", 13)
        c.drawString(margin, top_y2 - 0.05 * inch, f"Strava Daily Report — {report_date_pretty}")
        c.setFont("Helvetica", 9)
        c.drawString(margin, top_y2 - 0.32 * inch, "Central Time")
        c.line(margin, header_bottom_y2, width - margin, header_bottom_y2)

        y = header_bottom_y2 - 0.25 * inch

        c.setFont("Helvetica-Bold", 10)
        for i, h in enumerate(headers):
            c.drawString(margin + i * col_w, y, h)
        y -= 0.15 * inch
        c.line(margin, y, width - margin, y)
        y -= 0.25 * inch
        c.setFont("Helvetica", 8.6)

    for i in range(max_lines):
        if y < y_min:
            new_page()

        for col_i in range(5):
            text = columns[col_i][i] if i < len(columns[col_i]) else ""
            if text:
                c.drawString(margin + col_i * col_w, y, text)

        y -= line_h

    c.save()
    pdf_sanity_check(pdf_path)
    print(f"PDF generated OK: {pdf_path}")


if __name__ == "__main__":
    main()
