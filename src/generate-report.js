import axios from "axios";
import fs from "fs";
import PDFDocument from "pdfkit";

const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
  STRAVA_CLUB_ID,
  STRAVA_LOGO_URL
} = process.env;

// Date in Month Day, Year format
const reportDate = new Date(Date.now() - 86400000);
const options = { year: "numeric", month: "long", day: "numeric" };
const dateLabel = reportDate.toLocaleDateString("en-US", options);

const fileName = `strava-daily-report-${reportDate.toISOString().split("T")[0]}.pdf`;

async function getAccessToken() {
  const res = await axios.post("https://www.strava.com/oauth/token", {
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    refresh_token: STRAVA_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  return res.data.access_token;
}

async function run() {
  const token = await getAccessToken();

  // Get activities and members
  const activities = await axios.get(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const members = await axios.get(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/members`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const totals = { Walk: [], Run: [], Ride: [], Hike: [], None: [] };
  const activeIds = new Set();

  // Process activities safely
  for (const a_attach of activities.data) {
    if (!a_attach.activity || !a_attach.activity.distance) continue;

    const a = a_attach.activity;
    const miles = a.distance / 1609.34;
    const name = `${a.athlete.firstname} ${a.athlete.lastname}`;

    activeIds.add(a.athlete.id);

    if (totals[a.type]) {
      totals[a.type].push(`${name} — ${miles.toFixed(2)} mi`);
    }
  }

  // Inactive members
  for (const m of members.data) {
    if (!activeIds.has(m.id)) {
      totals.None.push(`${m.firstname} ${m.lastname} — 0.00 mi`);
    }
  }

  // Generate PDF
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(fs.createWriteStream(fileName));

  // Banner logo top
  const logo = await axios.get(STRAVA_LOGO_URL, { responseType: "arraybuffer" });
  doc.image(logo.data, 0, 0, { width: 595 }); // full page width approx

  // Title below banner
  doc.moveDown(6);
  doc.fontSize(18).text("Strava Daily Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(14).text(dateLabel, { align: "center" });
  doc.moveDown();

  // Constants
  const pageHeight = doc.page.height - 80;
  const startY = 150;
  const columnWidth = 180;
  const rowHeight = 14;

  // Helper to draw columns and manage page breaks
  function drawColumns(titles, dataArrays, startY) {
    let y = startY;
    const xPositions = [40, 40 + columnWidth, 40 + columnWidth * 2];

    while (true) {
      // Draw headers
      titles.forEach((title, i) => {
        doc.fontSize(12).text(title, xPositions[i], y);
      });
      y += 20;

      let maxRows = 0;
      titles.forEach((title, i) => {
        const data = dataArrays[i];
        const rows = data.splice(0, Math.floor((pageHeight - y) / rowHeight));
        rows.forEach((line, j) => {
          doc.fontSize(10).text(line, xPositions[i], y + j * rowHeight);
        });
        if (rows.length > maxRows) maxRows = rows.length;
      });

      y += maxRows * rowHeight + 20;

      // If any data left, add new page and repeat headers
      if (dataArrays.some(arr => arr.length > 0)) {
        doc.addPage();
      } else break;
    }
  }

  // First pages: Walk, Run, Ride
  drawColumns(
    ["Walk", "Run", "Ride"],
    [totals.Walk.slice(), totals.Run.slice(), totals.Ride.slice()],
    startY
  );

  // Hike + NO ACTIVITY on next page(s)
  if (totals.Hike.length > 0 || totals.None.length > 0) {
    doc.addPage();
    drawColumns(
      ["Hike", "No Activity", ""],
      [totals.Hike.slice(), totals.None.slice(), []],
      startY
    );
  }

  doc.end();
}

run();
