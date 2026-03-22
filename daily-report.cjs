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

function buildMemberLookup(members) {
  const byId = new Map();

  for (const member of members) {
    if (member && member.id != null) {
      byId.set(String(member.id), {
        id: String(member.id),
        name: getMemberName(member)
      });
    }
  }

  return byId;
}

function buildReportData(members, activities, reportIsoDate) {
  const memberLookup = buildMemberLookup(members);

  const allMembers = members
    .map(member => ({
      id: member && member.id != null ? String(member.id) : null,
      name: getMemberName(member)
    }))
    .filter(member => member.id);

  const categories = {
    walk: new Map(),
    run: new Map(),
    ride: new Map(),
    hike: new Map()
  };

  const activeMemberIds = new Set();

  for (const activity of activities) {
    if (!activityMatchesReportDate(activity, reportIsoDate)) {
      continue;
    }

    const category = bucketForSportType(normalizeSportType(activity));
    if (!category) {
      continue;
    }

    const athleteId = activity && activity.athlete && activity.athlete.id != null
      ? String(activity.athlete.id)
      : null;

    if (!athleteId) {
      continue;
    }

    const member = memberLookup.get(athleteId);
    if (!member) {
      continue;
    }

    const miles = metersToMiles(activity.distance);
    activeMemberIds.add(athleteId);

    const current = categories[category].get(athleteId) || {
      id: athleteId,
      name: member.name,
      miles: 0
    };

    current.miles += miles;
    categories[category].set(athleteId, current);
  }

  const walk = Array.from(categories.walk.values())
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const run = Array.from(categories.run.values())
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const ride = Array.from(categories.ride.values())
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const hike = Array.from(categories.hike.values())
    .sort((a, b) => b.miles - a.miles || a.name.localeCompare(b.name));

  const noActivity = allMembers
    .filter(member => !activeMemberIds.has(member.id))
    .map(member => ({ name: member.name, miles: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    walk: walk.map(({ name, miles }) => ({ name, miles })),
    run: run.map(({ name, miles }) => ({ name, miles })),
    ride: ride.map(({ name, miles }) => ({ name, miles })),
    hike: hike.map(({ name, miles }) => ({ name, miles })),
    noActivity
  };
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

function splitIntoChunks(rows, chunkSize) {
  if (chunkSize <= 0) {
    return [rows];
  }

  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }

  return chunks.length ? chunks : [[]];
}

function drawColumn(doc, x, y, width, title, rows) {
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
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(row.name, x, currentY, {
        width: width - 55,
        align: 'left'
      });

    doc
      .font('Helvetica')
      .fontSize(10)
      .text(formatMiles(row.miles), x + width - 55, currentY, {
        width: 55,
        align: 'right'
      });

    currentY += 14;
  }
}

function renderPageHeader(doc, prettyDate, logoBuffer, isFirstPage) {
  const pageWidth = doc.page.width;
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;
  const contentWidth = pageWidth - left - right;

  if (isFirstPage && logoBuffer) {
    try {
      doc.image(logoBuffer, left, 24, {
        fit: [contentWidth, 70],
        align: 'center'
      });
      doc.y = 110;
    } catch (error) {
      console.warn(`Logo rendering failed: ${error.message}`);
      doc.y = 50;
    }
  } else {
    doc.y = 36;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(`Strava Daily Report - ${prettyDate}`, left, doc.y, {
      width: contentWidth,
      align: 'center'
    });

  doc.moveDown(1);

  return {
    left,
    contentWidth,
    startY: doc.y + 8
  };
}

async function createPdf(reportData, prettyDate, outputPath) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 36,
    autoFirstPage: true
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const logoBuffer = await fetchLogoBuffer();

  const firstHeader = renderPageHeader(doc, prettyDate, logoBuffer, true);

  const columnGap = 14;
  const totalGap = columnGap * 3;
  const columnWidth = (firstHeader.contentWidth - totalGap) / 4;
  const rowHeight = 14;
  const titleHeight = 22;
  const bottomLimit = doc.page.height - doc.page.margins.bottom - 10;
  const usableHeight = bottomLimit - (firstHeader.startY + titleHeight);
  const rowsPerPage = Math.max(1, Math.floor(usableHeight / rowHeight));

  const hikeAndNoActivity = [...reportData.hike, ...reportData.noActivity];

  const pageChunks = {
    walk: splitIntoChunks(reportData.walk, rowsPerPage),
    run: splitIntoChunks(reportData.run, rowsPerPage),
    ride: splitIntoChunks(reportData.ride, rowsPerPage),
    hikeNoActivity: splitIntoChunks(hikeAndNoActivity, rowsPerPage)
  };

  const totalPages = Math.max(
    pageChunks.walk.length,
    pageChunks.run.length,
    pageChunks.ride.length,
    pageChunks.hikeNoActivity.length
  );

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    if (pageIndex > 0) {
      doc.addPage();
      renderPageHeader(doc, prettyDate, null, false);
    }

    const startX = doc.page.margins.left;
    const startY = doc.y + 8;

    drawColumn(
      doc,
      startX,
      startY,
      columnWidth,
      pageIndex === 0 ? 'Walk' : 'Walk (cont.)',
      pageChunks.walk[pageIndex] || []
    );

    drawColumn(
      doc,
      startX + columnWidth + columnGap,
      startY,
      columnWidth,
      pageIndex === 0 ? 'Run' : 'Run (cont.)',
      pageChunks.run[pageIndex] || []
    );

    drawColumn(
      doc,
      startX + (columnWidth + columnGap) * 2,
      startY,
      columnWidth,
      pageIndex === 0 ? 'Ride' : 'Ride (cont.)',
      pageChunks.ride[pageIndex] || []
    );

    drawColumn(
      doc,
      startX + (columnWidth + columnGap) * 3,
      startY,
      columnWidth,
      pageIndex === 0 ? 'Hike / No Activity' : 'Hike / No Activity (cont.)',
      pageChunks.hikeNoActivity[pageIndex] || []
    );
  }

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
  const { isoDate, prettyDate } = getPreviousChicagoDayInfo();

  console.log(`Building report for ${prettyDate} (${isoDate})`);

  const accessToken = await getAccessToken();
  const [members, activities] = await Promise.all([
    getClubMembers(accessToken, clubId),
    getClubActivities(accessToken, clubId)
  ]);

  console.log(`Members fetched: ${members.length}`);
  console.log(`Recent club activities fetched: ${activities.length}`);

  const reportData = buildReportData(members, activities, isoDate);

  console.log(`Walk entries: ${reportData.walk.length}`);
  console.log(`Run entries: ${reportData.run.length}`);
  console.log(`Ride entries: ${reportData.ride.length}`);
  console.log(`Hike entries: ${reportData.hike.length}`);
  console.log(`No Activity entries: ${reportData.noActivity.length}`);

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
