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

  // --- Fetch all activities
  const activitiesRes = await axios.get(
    `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // --- Fetch all members with pagination (future-proof)
  let members = [];
  let page = 1;
  const perPage = 200; // fetch all in batches of 200
  while (true) {
    const res = await axios.get(
      `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/members?page=${page}&per_page=${perPage}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.data || res.data.length === 0) break;
    members = members.concat(res.data);
    page++;
  }

  // --- Build totals with Last, First format ---
  const totals = { Walk: [], Run: [], Ride: [], Hike: [], None: [] };
  const activeIds = new Set();

  for (const a_attach of activitiesRes.data) {
    if (!a_attach.activity || !a_attach.activity.distance) continue;

    const a = a_attach.activity;
    const miles = a.distance / 1609.34;
    const name = `${a.athlete.lastname.trim()}, ${a.athlete.firstname.trim()}`; // FULL last name
    activeIds.add(a.athlete.id);

    if (totals[a.type]) {
      totals[a.type].push({ name, miles: miles.toFixed(2) });
    }
  }

  // Add inactive members (No Activity)
  for (const m of members) {
    if (!activeIds.has(m.id)) {
      totals.None.push({ name: `${m.lastname.trim()}, ${m.firstname.trim()}`, miles: "0.00" });
    }
  }

  // Sort each column alphabetically by last name
  Object.keys(totals).forEach(type => {
    totals[type].sort((a, b) => a.name.localeCompare(b.name));
  });

  // Convert to string for PDF
  Object.keys(totals).forEach(type => {
    totals[type] = totals[type].map(item => `${item.name} — ${item.miles} mi`);
  });

  // --- Generate PDF ---
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(fs.createWriteStream(fileName));

  const pageHeight = doc.page.height - 80;
  const startY = 150;
  const rowHeight = 14;

  // Load banner synchronously
  const logoResponse = await axios.get(STRAVA_LOGO_URL, { responseType: "arraybuffer" });
  const logoBuffer = Buffer.from(logoResponse.data, "binary");

  // --- Helper to draw columns ---
  function drawColumns(titles, dataArrays, xPositions, showBannerOnFirstPage = false) {
    let y = startY;
    let firstPage = true;

    while (true) {
      if (showBannerOnFirstPage && firstPage) {
        doc.image(logoBuffer, 0, 0, { width: 595 });
        doc.moveDown(5);
        doc.fontSize(18).text(`Strava Daily Report — ${dateLabel}`, { align: "center" });
        doc.moveDown();
        firstPage = false;
      }

      // Column headers
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
    true
  );

  // --- Hike / No Activity section ---
  if (totals.Hike.length > 0 || totals.None.length > 0) {
    doc.addPage();
    drawColumns(
      ["Hike", "No Activity"],
      [totals.Hike.slice(), totals.None.slice()],
      [40, doc.page.width / 2 + 20],
      true
    );
  }

  doc.end();
}

run();
