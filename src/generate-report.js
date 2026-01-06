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

// Report date in Month Day, Year
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

  // Pull activities and members
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

  // Add inactive members to NO ACTIVITY
  for (const m of members.data) {
    if (!activeIds.has(m.id)) {
      totals.None.push(`${m.firstname} ${m.lastname} — 0.00 mi`);
    }
  }

  // Generate PDF
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(fs.createWriteStream(fileName));

  const pageHeight = doc.page.height - 80;
  const startY = 150;
  const rowHeight = 14;

  // Load banner image synchronously before drawing pages
  const logoResponse = await axios.get(STRAVA_LOGO_URL, { responseType: "arraybuffer" });
  const logoBuffer = Buffer.from(logoResponse.data, "binary");

  // --- Helper to draw columns for a section ---
  function drawColumns(titles, dataArrays, xPositions, showBannerOnFirstPage = false) {
    let y = startY;
    let firstPage = true;

    while (true) {
      if (showBannerOnFirstPage && firstPage) {
        // Draw banner + title
        doc.image(logoBuffer, 0, 0, { width: 595 });
        doc.moveDown(5);
        doc.fontSize(18).text(`Strava Daily Report — ${dateLabel}`, { align: "center" });
        doc.moveDown();
        firstPage = false;
      }

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

      if (dataArrays.some(arr => arr.length > 0)) {
        doc.addPage();
        y = startY;
      } else break;
    }
  }

  // --- Walk / Run / Ride section ---
  drawColumns(
    ["Walk", "Run", "Ride"],
    [totals.Walk.slice(), totals.Run.slice(), totals.Ride.slice()],
    [40, doc.page.width / 2 - 50, doc.page.width - 180],
    true // banner/title on first page of this section
  );

  // --- Hike / No Activity section ---
  if (totals.Hike.length > 0 || totals.None.length > 0) {
    doc.addPage(); // ensure section starts on new page
    drawColumns(
      ["Hike", "No Activity"],
      [totals.Hike.slice(), totals.None.slice()],
      [40, doc.page.width / 2 + 20],
      true // banner/title on first page of this section
    );
  }

  doc.end();
}

run();
