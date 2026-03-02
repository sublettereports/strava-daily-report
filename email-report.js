import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

function need(name) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

need("EMAIL_HOST");
need("EMAIL_PORT");
need("EMAIL_USER");
need("EMAIL_PASS");
need("EMAIL_BCC");

const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_BCC } = process.env;

function loadReportDate() {
  const raw = fs.readFileSync("report-data.json", "utf8");
  const data = JSON.parse(raw);
  if (!data.reportDate) throw new Error("reportDate missing in report-data.json");
  return data.reportDate;
}

const reportDate = loadReportDate();
const pdfPath = path.join("output", `strava-daily-report-${reportDate}.pdf`);

if (!fs.existsSync(pdfPath)) {
  console.error("PDF not found:", pdfPath);
  process.exit(1);
}
const size = fs.statSync(pdfPath).size;
if (size < 1200) {
  console.error("PDF too small/corrupt:", pdfPath, `(size=${size})`);
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: EMAIL_HOST,
  port: Number(EMAIL_PORT),
  secure: Number(EMAIL_PORT) === 465,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

await transporter.sendMail({
  from: EMAIL_USER,
  // BCC-only pattern: send to yourself, BCC the list
  to: EMAIL_USER,
  bcc: EMAIL_BCC,
  subject: `Strava Daily Report — ${reportDate}`,
  text: `Attached is the Strava Daily Report for ${reportDate}.`,
  attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
});

console.log("Email sent OK (BCC only).");
