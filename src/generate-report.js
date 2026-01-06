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

async function fetchAllActivities(token) {
  let activities = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const res = await axios.get(
      `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities?page=${page}&per_page=${perPage}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.data || res.data.length === 0) break;
    activities = activities.concat(res.data);
    page++;
  }
  return activities;
}

async function fetchAllMembers(token) {
  let members = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const res = await axios.get(
      `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/members?page=${page}&per_page=${perPage}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.data || res.data.length === 0) break;
    members = members.concat(res.data);
    page++;
  }
  return members;
}

async function run() {
  const token = await getAccessToken();
  const activities = await fetchAllActivities(token);
  const members = await fetchAllMembers(token);

  // --- Build totals using First LastInitial
  const totals = { Walk: [], Run: [], Ride: [], Hike: [], None: [] };
  const activeIds = new Set();

  activities.forEach(a => {
    if (!a || !a.type || !a.distance || !a.athlete) return;

    const miles = a.distance / 1609.34;
    const first = a.athlete.firstname.trim();
    const lastInitial = a.athlete.lastname.trim()[0];
    const name = `${first} ${lastInitial}`;

    activeIds.add(a.athlete.id);

    if (totals[a.type]) {
      totals[a.type].push({ name, lastInitial, miles: miles.toFixed(2) });
    }
  });

  // Add inactive members
  members.forEach(m => {
    if (!activeIds.has(m.id)) {
      const name = `${m.firstname.trim()} ${m.lastname.trim()[0]}`;
      totals.None.push({ name, lastInitial: m.lastname.trim()[0], miles: "0.00" });
    }
  });

  // Sort columns alphabetically by last initial
  Object.keys(totals).forEach(type => {
    totals[type].sort((a, b) => a.lastInitial.localeCompare(b.lastInitial));
    totals[type] = totals[type].map(item => `${item.name} — ${item.miles} mi`);
  });

  // --- Generate PDF ---
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(fs.createWriteStream(fileName));

  const pageHeight = doc.page.height - 80;
  const startY = 150;
  const rowHeight = 14;

  // Load banner
  const logoResponse = await axios.get(STRAVA_LOGO_URL, { responseType: "arraybuffer" });
  const logoBuffer = Buffer.from(logoResponse.data, "binary");

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

  // --- Walk / Run / Ride
  drawColumns(
    ["Walk", "Run", "Ride"],
    [totals.Walk.slice(), totals.Run.slice(), totals.Ride.slice()],
    [40, doc.page.width / 2 - 50, doc.page.width - 180],
    true
  );

  // --- Hike / No Activity
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
