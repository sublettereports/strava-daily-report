import nodemailer from "nodemailer";
import fs from "fs";

const {
  EMAIL_HOST,
  EMAIL_PORT,
  EMAIL_USER,
  EMAIL_PASS,
  EMAIL_BCC
} = process.env;

// Report date
const reportDate = new Date(Date.now() - 86400000);
const options = { year: "numeric", month: "long", day: "numeric" };
const dateLabel = reportDate.toLocaleDateString("en-US", options);

const fileName = `strava-daily-report-${reportDate.toISOString().split("T")[0]}.pdf`;

async function sendEmail() {
  const transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });

  await transporter.sendMail({
    from: EMAIL_USER,
    bcc: EMAIL_BCC,
    subject: `Strava Daily Report — ${dateLabel}`,
    text: `This is all the club activities for ${dateLabel}.`,
    attachments: [{ filename: fileName, path: fileName }]
  });
}

sendEmail();
