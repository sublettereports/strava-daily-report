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

/**
 * 🔥 UPDATED: Only fetch latest 100 (no pagination)
 */
async function fetchAllPages(url, accessToken) {
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    params: {
      page: 1,
      per_page: 100
    },
    timeout: 30000
  });

  const rows = Array.isArray(response.data) ? response.data : [];
  return rows;
}

async function getClubMembers(accessToken, clubId) {
  return fetchAllPages(`https://www.strava.com/api/v3/clubs/${clubId}/members`, accessToken);
}

async function getClubActivities(accessToken, clubId) {
  return fetchAllPages(`https://www.strava.com/api/v3/clubs/${clubId}/activities`, accessToken);
}

function getPreviousChicagoDayInfo() {
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

  const chicagoTodayUtc = new Date(Date.UTC(year, month - 1, day));
  const chicagoYesterdayUtc = new Date(chicagoTodayUtc.getTime() - 24 * 60 * 60 * 1000);

  const reportYear = chicagoYesterdayUtc.getUTCFullYear();
  const reportMonth = chicagoYesterdayUtc.getUTCMonth() + 1;
  const reportDay = chicagoYesterdayUtc.getUTCDate();

  const isoDate = `${reportYear}-${String(reportMonth).padStart(2, '0')}-${String(reportDay).padStart(2, '0')}`;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const prettyDate = `${monthNames[reportMonth - 1]} ${reportDay}, ${reportYear}`;

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

function getActivityAthleteName(activity) {
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

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildMemberKey(member) {
  if (member && member.id != null) {
    return `id:${String(member.id)}`;
  }

  const name = getMemberName(member);
  return `name:${normalizeName(name)}`;
}

function buildActivityKey(activity) {
  if (activity && activity.athlete && activity.athlete.id != null) {
    return `id:${String(activity.athlete.id)}`;
  }

  const name = getActivityAthleteName(activity);
  return `name:${normalizeName(name)}`;
}

function buildReportData(members, activities) {
  const memberMap = new Map();

  for (const member of members) {
    const key = buildMemberKey(member);
    const name = getMemberName(member);

    if (!memberMap.has(key)) {
      memberMap.set(key, {
        key,
        name
      });
    }
  }

  const categories = {
    walk: new Map(),
    run: new Map(),
    ride: new Map(),
    hike: new Map()
  };

  const activeKeys = new Set();

  for (const activity of activities) {
    const category = bucketForSportType(normalizeSportType(activity));
    if (!category) continue;

    const activityKey = buildActivityKey(activity);
    let member = memberMap.get(activityKey);

    if (!member) {
      const fallbackNameKey = `name:${normalizeName(getActivityAthleteName(activity))}`;
      member = memberMap.get(fallbackNameKey);
    }

    if (!member) continue;

    const miles = metersToMiles(activity.distance);
    activeKeys.add(member.key);

    const current = categories[category].get(member.key) || {
      name: member.name,
      miles: 0
    };

    current.miles += miles;
    categories[category].set(member.key, current);
  }

  const walk = Array.from(categories.walk.values()).sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));
  const run = Array.from(categories.run.values()).sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));
  const ride = Array.from(categories.ride.values()).sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));
  const hike = Array.from(categories.hike.values()).sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const noActivity = Array.from(memberMap.values())
    .filter(member => !activeKeys.has(member.key))
    .map(member => ({ name: member.name, miles: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { walk, run, ride, hike, noActivity };
}

async function fetchLogoBuffer() {
  const logoUrl = (process.env.STRAVA_LOGO_URL || '').trim();
  if (!logoUrl) return null;

  try {
    const response = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    return Buffer.from(response.data);
  } catch {
    return null;
  }
}

function splitIntoChunks(rows, chunkSize) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  return chunks.length ? chunks : [[]];
}

function drawColumn(doc, x, y, width, title, rows) {
  doc.font('Helvetica-Bold').fontSize(14).text(title, x, y, { width });

  let currentY = y + 22;

  if (!rows.length) {
    doc.font('Helvetica').fontSize(10).text('None', x, currentY, { width });
    return;
  }

  for (const row of rows) {
    doc.font('Helvetica').fontSize(10).text(row.name, x, currentY, { width: width - 55 });
    doc.font('Helvetica').fontSize(10).text(formatMiles(row.miles), x + width - 55, currentY, { width: 55, align: 'right' });
    currentY += 14;
  }
}

async function createPdf(reportData, prettyDate, outputPath) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  doc.fontSize(20).text(`Strava Daily Report - ${prettyDate}`, { align: 'center' });
  doc.moveDown();

  const columnWidth = (doc.page.width - 72 - 42) / 4;
  const startX = 36;
  const startY = doc.y;

  drawColumn(doc, startX, startY, columnWidth, 'Walk', reportData.walk);
  drawColumn(doc, startX + columnWidth + 14, startY, columnWidth, 'Run', reportData.run);
  drawColumn(doc, startX + (columnWidth + 14) * 2, startY, columnWidth, 'Ride', reportData.ride);
  drawColumn(doc, startX + (columnWidth + 14) * 3, startY, columnWidth, 'Hike / No Activity', [...reportData.hike, ...reportData.noActivity]);

  doc.end();

  await new Promise(resolve => stream.on('finish', resolve));
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

  await transporter.sendMail({
    from: requireEnv('EMAIL_USER'),
    to: requireEnv('EMAIL_USER'),
    bcc: requireEnv('EMAIL_BCC'),
    subject: `Strava Daily Report - ${prettyDate}`,
    text: `Attached is the Strava Daily Report for ${prettyDate}.`,
    attachments: [{ filename: path.basename(filePath), path: filePath }]
  });
}

async function runReport() {
  validateEnv();

  const clubId = requireEnv('STRAVA_CLUB_ID');
  const { isoDate, prettyDate } = getPreviousChicagoDayInfo();

  const accessToken = await getAccessToken();

  const [members, activities] = await Promise.all([
    getClubMembers(accessToken, clubId),
    getClubActivities(accessToken, clubId)
  ]);

  console.log(`Members: ${members.length}`);
  console.log(`Activities (last 100): ${activities.length}`);

  const reportData = buildReportData(members, activities);

  const outputFile = path.join(process.cwd(), `strava-daily-report-${isoDate}.pdf`);

  await createPdf(reportData, prettyDate, outputFile);
  await sendEmailWithAttachment(outputFile, prettyDate);
}

runReport().catch(err => {
  console.error(err);
  process.exit(1);
});
