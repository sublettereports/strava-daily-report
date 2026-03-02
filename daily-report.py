import os
import json
import io
import requests
from datetime import datetime

from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

OUTPUT_DIR = "output"
DATA_FILE = "report-data.json"
TZ_LABEL = "Central Time"


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

    # Landscape page
    pagesize = landscape(letter)
    c = canvas.Canvas(pdf_path, pagesize=pagesize)
    width, height = pagesize

    margin = 0.5 * inch

    # Table config (5 columns)
    headers = ["WALK", "RUN", "RIDE", "HIKE", "NO ACTIVITY"]
    col_count = 5
    col_w = (width - 2 * margin) / col_count

    # Typography
    body_font = 9.0
    header_font = 10.5
    line_h = 0.20 * inch  # slightly taller lines in landscape

    def draw_header():
        """
        Draw compact header with text on left and logo on right (vertically centered).
        Returns y position where the table should start.
        """
        top_y = height - margin
        header_h = 1.20 * inch
        header_bottom_y = top_y - header_h

        gap = 0.25 * inch
        right_w = 5.25 * inch  # generous logo area in landscape
        right_x = width - margin - right_w
        left_x = margin
        left_w = (right_x - gap) - left_x

        # Right logo box (centered vertically)
        if logo:
            try:
                pad = 0.06 * inch
                box_x = right_x + pad
                box_w = right_w - 2 * pad
                box_h = header_h - 2 * pad
                box_y = header_bottom_y + pad

                # The image is placed inside a box and centered by anchor='c'
                c.drawImage(
                    logo,
                    box_x,
                    box_y,
                    width=box_w,
                    height=box_h,
                    preserveAspectRatio=True,
                    anchor="c",
                    mask="auto",
                )
            except Exception:
                pass

        # Left text block
        y = top_y
        c.setFont("Helvetica-Bold", 18)
        c.drawString(left_x, y - 0.06 * inch, "Strava Daily Report")
        y -= 0.40 * inch

        c.setFont("Helvetica", 12)
        c.drawString(left_x, y, f"Report date: {report_date_pretty} ({TZ_LABEL})")
        y -= 0.27 * inch

        c.setFont("Helvetica", 10)
        summary = (
            f"Members: {totals.get('members','?')}  |  "
            f"Active: {totals.get('activeMembers','?')}  |  "
            f"No Activity: {totals.get('inactiveMembers','?')}  |  "
            f"Activities included: {totals.get('activitiesInWindow','?')}"
        )

        # Clip summary so it doesn't run into the logo area
        max_chars = max(30, int(left_w / 5.6))  # rough but stable
        c.drawString(left_x, y, summary[:max_chars])

        # Divider under header
        c.line(margin, header_bottom_y, width - margin, header_bottom_y)

        # Table start
        return header_bottom_y - 0.30 * inch

    def draw_table_header(y):
        c.setFont("Helvetica-Bold", header_font)
        for i, h in enumerate(headers):
            c.drawString(margin + i * col_w, y, h)
        y -= 0.14 * inch
        c.line(margin, y, width - margin, y)
        y -= 0.22 * inch
        c.setFont("Helvetica", body_font)
        return y, y  # (new y, table_content_top_y)

    def draw_column_dividers(y_top, y_bottom):
        # Subtle vertical lines between columns
        c.saveState()
        try:
            c.setStrokeGray(0.82)  # light gray "subtle" lines
            for k in range(1, col_count):
                x = margin + k * col_w
                c.line(x, y_top, x, y_bottom)
        finally:
            c.restoreState()

    # Build column lines (include "mi" in activity columns)
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
    max_lines = max((len(col) for col in columns), default=0)

    # First page
    y = draw_header()
    y, table_content_top = draw_table_header(y)

    # Keep a per-page record so we can draw dividers to the right bounds
    page_table_top = table_content_top + 0.22 * inch  # top where headers end (approx)
    page_table_bottom = margin + 0.60 * inch
    y_min = page_table_bottom

    # Draw rows, page as needed
    for i in range(max_lines):
        if y < y_min:
            # Before new page, draw dividers for current page
            draw_column_dividers(page_table_top, page_table_bottom)

            c.showPage()
            y = draw_header()
            y, table_content_top = draw_table_header(y)
            page_table_top = table_content_top + 0.22 * inch
            page_table_bottom = margin + 0.60 * inch
            y_min = page_table_bottom

        for col_i in range(col_count):
            text = columns[col_i][i] if i < len(columns[col_i]) else ""
            if text:
                c.drawString(margin + col_i * col_w, y, text)

        y -= line_h

    # Draw dividers for the last page
    draw_column_dividers(page_table_top, page_table_bottom)

    c.save()
    pdf_sanity_check(pdf_path)
    print(f"PDF generated OK: {pdf_path}")


if __name__ == "__main__":
    main()
