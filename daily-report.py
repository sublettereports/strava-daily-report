import os
import json
import requests
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


def safe_logo_reader(url: str):
    if not url:
        return None
    try:
        r = requests.get(url, timeout=20)
        r.raise_for_status()
        return ImageReader(r.content)
    except Exception:
        return None


def pdf_sanity_check(path: str):
    # Valid PDFs can be small if there are few lines/no logo.
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

    report_date = data.get("reportDate", "YYYY-MM-DD")
    rows = data.get("rows", [])
    inactive = data.get("inactive", [])
    totals = data.get("totals", {})

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    pdf_name = f"strava-daily-report-{report_date}.pdf"
    pdf_path = os.path.join(OUTPUT_DIR, pdf_name)

    logo_url = os.environ.get("STRAVA_LOGO_URL", "")
    logo = safe_logo_reader(logo_url)

    c = canvas.Canvas(pdf_path, pagesize=letter)
    width, height = letter
    margin = 0.5 * inch
    y = height - margin

    # Full-width banner
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
            )
        except Exception:
            pass
    y -= (banner_h + 0.25 * inch)

    # Title + date
    c.setFont("Helvetica-Bold", 16)
    c.drawString(margin, y, "Strava Daily Report")
    y -= 0.28 * inch

    c.setFont("Helvetica", 11)
    c.drawString(margin, y, f"Report date: {report_date} (America/Chicago)")
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
        c.drawString(margin, y, f"Strava Daily Report (continued) — {report_date}")
        y -= 0.35 * inch

        c.setFont("Helvetica-Bold", 11)
        for i, h in enumerate(headers):
            c.drawString(margin + i * col_w, y, h)
        y -= 0.15 * inch
        c.line(margin, y, width - margin, y)
        y -= 0.25 * inch

        c.setFont("Helvetica", 9)

    # Draw aligned rows across columns
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
