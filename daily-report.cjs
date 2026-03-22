const axios = require('axios');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const REQUIRED_ENV_VARS = [
  'STRAVA_CLIENT_ID',
  'STRAVA_CLIENT_SECRET',
  'STRAVA_REFRESH_TOKEN',
  'STRAVA_CLUB_ID',
  'EMAIL_HOST',
  'EMAIL_PORT',
  'EMAIL_USER',
  'EMAIL_PASS',
  'EMAIL_BCC'
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function validateEnv() {
  for (const name of REQUIRED_ENV_VARS) {
    requireEnv(name);
  }
}

async function getAccessToken() {
  const response = await axios.post(
    'https://www.strava.com/oauth/token',
    null,
    {
      params: {
        client_id: requireEnv('STRAVA_CLIENT_ID'),
        client_secret: requireEnv('STRAVA_CLIENT_SECRET'),
        refresh_token: requireEnv('STRAVA_REFRESH_TOKEN'),
        grant_type: 'refresh_token'
      },
      timeout: 30000
    }
  );

  if (!response.data || !response.data.access_token) {
    throw new Error('Strava did not return an access token.');
  }

  return response.data.access_token;
}

async function fetchAllPages(url, accessToken) {
  const all = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        page,
        per_page: perPage
      },
      timeout: 30000
    });

    const rows = Array.isArray(response.data) ? response.data : [];
    all.push(...rows);

    if (rows.length < perPage) {
      break;
    }

    page += 1;
  }

  return all;
}

async function getClubMembers(accessToken, clubId) {
  return fetchAllPages(`https://www.strava.com/api/v3/clubs/${clubId}/members`, accessToken);
}

async function getClubActivities(accessToken, clubId) {
  return fetchAllPages(`https://www.strava.com/api/v3/clubs/${clubId}/activities`, accessToken);
}

function getChicagoReportDateInfo() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const day = Number(parts.find(p => p.type === 'day').value);

  const chicagoMidnightUtc = new Date(Date.UTC(year, month - 1, day));
  const yesterdayUtc = new Date(chicagoMidnightUtc.getTime() - 24 * 60 * 60 * 1000);

  const y = yesterdayUtc.getUTCFullYear();
  const m = String(yesterdayUtc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(yesterdayUtc.getUTCDate()).padStart(2, '0');

  const isoDate = `${y}-${m}-${d}`;

  const prettyDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(yesterdayUtc);

  return {
    isoDate,
    prettyDate
  };
}

function metersToMiles(meters) {
  return Number(meters || 0) * 0.000621371;
}

function formatMiles(miles) {
  return `${miles.toFixed(2)} mi`;
}

function getMemberName(member) {
  const first = (member.firstname || '').trim();
  const last = (member.lastname || '').trim();
  const full = `${first} ${last}`.trim();
  return full || 'Unnamed Athlete';
}

function getActivityName(activity) {
  const athlete = activity.athlete || {};
  const first = (athlete.firstname || '').trim();
  const last = (athlete.lastname || '').trim();
  const full = `${first} ${last}`.trim();
  return full || 'Unnamed Athlete';
}

function normalizeSportType(activity) {
  return String(activity.sport_type || activity.type || '').trim();
}

function bucketForSportType(sportType) {
  const value = String(sportType || '').toLowerCase();

  if (value.includes('walk')) return 'walk';
  if (value.includes('run')) return 'run';
  if (value.includes('ride') || value.includes('bike') || value.includes('cycling')) return 'ride';
  if (value.includes('hike')) return 'hike';

  return null;
}

function activityMatchesReportDate(activity, isoDate) {
  const local = String(activity.start_date_local || '');
  return local.startsWith(isoDate);
}

function buildReportData(members, activities, reportIsoDate) {
  const memberNames = members.map(getMemberName);

  const categories = {
    walk: new Map(),
    run: new Map(),
    ride: new Map(),
    hike: new Map()
  };

  const activeNames = new Set();

  for (const activity of activities) {
    if (!activityMatchesReportDate(activity, reportIsoDate)) {
      continue;
    }

    const category = bucketForSportType(normalizeSportType(activity));
    if (!category) {
      continue;
    }

    const athleteName = getActivityName(activity);
    const miles = metersToMiles(activity.distance);

    activeNames.add(athleteName);

    const current = categories[category].get(athleteName) || 0;
    categories[category].set(athleteName, current + miles);
  }

  const walk = Array.from(categories.walk.entries())
    .map(([name, miles]) => ({ name, miles }))
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const run = Array.from(categories.run.entries())
    .map(([name, miles]) => ({ name, miles }))
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const ride = Array.from(categories.ride.entries())
    .map(([name, miles]) => ({ name, miles }))
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const hike = Array.from(categories.hike.entries())
    .map(([name, miles]) => ({ name, miles }))
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const noActivity = memberNames
    .filter(name => !activeNames.has(name))
    .map(name => ({ name, miles: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { walk, run, ride, hike, noActivity };
}

async function fetchLogoBuffer() {
  const logoUrl = (process.env.STRAVA_LOGO_URL || '').trim();
  if (!logoUrl) {
    return null;
  }

  try {
    const response = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.warn(`Logo download failed: ${error.message}`);
    return null;
  }
}

function drawColumn(doc, x, y, width, title, rows, pageHeightBottomLimit) {
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(title, x, y, { width, align: 'left' });

  let currentY = y + 22;

  if (!rows.length) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .text('None', x, currentY, { width, align: 'left' });
    return;
  }

  for (const row of rows) {
    if (currentY > pageHeightBottomLimit) {
      doc
        .font('Helvetica')
        .fontSize(10)
        .text('...', x, currentY, { width, align: 'left' });
      break;
    }

    doc
      .font('Helvetica')
      .fontSize(10)
      .text(row.name, x, currentY, { width: width - 55, align: 'left' });

    doc
      .font('Helvetica')
      .fontSize(10)
      .text(formatMiles(row.miles), x + width - 55, currentY, { width: 55, align: 'right' });

    currentY += 14;
  }
}

async function createPdf(reportData, prettyDate, outputPath) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 36
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const logoBuffer = await fetchLogoBuffer();

  const pageWidth = doc.page.width;
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;
  const contentWidth = pageWidth - left - right;

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, left, 24, {
        fit: [contentWidth, 70],
        align: 'center'
      });
      doc.moveDown(4);
    } catch (error) {
      console.warn(`Logo rendering failed: ${error.message}`);
      doc.moveDown(1);
    }
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(`Strava Daily Report - ${prettyDate}`, left, doc.y, {
      width: contentWidth,
      align: 'center'
    });

  doc.moveDown(1);

  const columnGap = 14;
  const totalGap = columnGap * 3;
  const columnWidth = (contentWidth - totalGap) / 4;
  const startX = left;
  const startY = doc.y + 8;
  const bottomLimit = doc.page.height - doc.page.margins.bottom - 10;

  drawColumn(doc, startX, startY, columnWidth, 'Walk', reportData.walk, bottomLimit);
  drawColumn(doc, startX + columnWidth + columnGap, startY, columnWidth, 'Run', reportData.run, bottomLimit);
  drawColumn(doc, startX + (columnWidth + columnGap) * 2, startY, columnWidth, 'Ride', reportData.ride, bottomLimit);
  drawColumn(
    doc,
    startX + (columnWidth + columnGap) * 3,
    startY,
    columnWidth,
    'Hike / No Activity',
    [...reportData.hike, ...reportData.noActivity],
    bottomLimit
  );

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function sendEmailWithAttachment(filePath, prettyDate) {
  const transporter = nodemailer.createTransport({
    host: requireEnv('EMAIL_HOST'),
    port: Number(requireEnv('EMAIL_PORT')),
    secure: Number(requireEnv('EMAIL_PORT')) === 465,
    auth: {
      user: requireEnv('EMAIL_USER'),
      pass: requireEnv('EMAIL_PASS')
    }
  });

  const fileName = path.basename(filePath);

  await transporter.sendMail({
    from: requireEnv('EMAIL_USER'),
    to: requireEnv('EMAIL_USER'),
    bcc: requireEnv('EMAIL_BCC'),
    subject: `Strava Daily Report - ${prettyDate}`,
    text: `Attached is the Strava Daily Report for ${prettyDate}.`,
    attachments: [
      {
        filename: fileName,
        path: filePath
      }
    ]
  });
}

async function runReport() {
  validateEnv();

  const clubId = requireEnv('STRAVA_CLUB_ID');
  const { isoDate, prettyDate } = getChicagoReportDateInfo();

  console.log(`Building report for ${prettyDate} (${isoDate})`);

  const accessToken = await getAccessToken();
  const [members, activities] = await Promise.all([
    getClubMembers(accessToken, clubId),
    getClubActivities(accessToken, clubId)
  ]);

  console.log(`Members fetched: ${members.length}`);
  console.log(`Recent club activities fetched: ${activities.length}`);

  const reportData = buildReportData(members, activities, isoDate);

  const outputFile = path.join(process.cwd(), `strava-daily-report-${isoDate}.pdf`);

  await createPdf(reportData, prettyDate, outputFile);
  console.log(`PDF created: ${outputFile}`);

  await sendEmailWithAttachment(outputFile, prettyDate);
  console.log('Email sent successfully');
}

runReport().catch(error => {
  if (error.response) {
    console.error('Strava/API error response:', error.response.status, error.response.data);
  } else {
    console.error(error);
  }
  process.exit(1);
});
