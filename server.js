require('dotenv').config();
const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 8080;

// Google Apps Script web app that owns the traffic spreadsheet.
// See apps-script/Code.gs for the endpoint this talks to.
const SHEETS_WEBAPP_URL = process.env.SHEETS_WEBAPP_URL;
const SHEETS_TOKEN = process.env.SHEETS_TOKEN;

// Ensure Express trusts the proxy so req.ip returns the correct IP
app.set('trust proxy', true);

// Middleware to parse JSON bodies from incoming requests
app.use(express.json());

// ---------------------------------------------------------------------------
// Google Sheets traffic log
// ---------------------------------------------------------------------------

// Every page load asks for the count, and a round trip to Apps Script is
// 300-800ms. Serving a slightly stale number is fine for a visitor counter.
const COUNT_TTL_MS = 30 * 1000;
let countCache = { value: null, at: 0 };

function sheetsConfigured() {
  return Boolean(SHEETS_WEBAPP_URL && SHEETS_TOKEN);
}

/**
 * Appends one visit to the traffic sheet.
 *
 * Apps Script answers a POST to /exec with a 302 to googleusercontent.com;
 * fetch follows it as a GET and receives the already-computed JSON body, which
 * is why this works without any redirect handling of its own.
 */
async function logVisit(visit) {
  if (!sheetsConfigured()) {
    throw new Error('SHEETS_WEBAPP_URL / SHEETS_TOKEN are not set');
  }

  const response = await fetch(SHEETS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: SHEETS_TOKEN, ...visit }),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Apps Script responded ${response.status}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.error || 'Apps Script rejected the write');
  }

  // The append response carries the fresh count, so take it instead of paying
  // for a second round trip on the /get-count that follows.
  if (typeof result.count === 'number') {
    countCache = { value: result.count, at: Date.now() };
  }
  return result;
}

async function fetchCount() {
  if (countCache.value !== null && Date.now() - countCache.at < COUNT_TTL_MS) {
    return countCache.value;
  }
  if (!sheetsConfigured()) {
    throw new Error('SHEETS_WEBAPP_URL / SHEETS_TOKEN are not set');
  }

  const response = await fetch(SHEETS_WEBAPP_URL, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Apps Script responded ${response.status}`);
  }

  const result = await response.json();
  countCache = { value: result.count, at: Date.now() };
  return result.count;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Middleware to track the source of the request
const trackSource = (req, res, next) => {
  req.requestSource = req.query.source || 'direct';
  next();
};

// /home route: redirect to the base URL with a query parameter indicating redirection
app.get('/home', (req, res) => {
  res.redirect('/?source=home');
});

app.get('/', trackSource, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Emails a single visit. Previously this re-read the last line of the CSV;
 * the row is already in hand here, so it goes straight into the message.
 */
function sendVisitEmail(visit, callback) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_RECIPIENT,
    subject: 'Most Recent User Data Entry Logged',
    text:
      'The most recent visit logged to the traffic sheet:\n' +
      `Date:       ${visit.timestamp}\n` +
      `IP:         ${visit.ip}\n` +
      `User Agent: ${visit.userAgent}\n` +
      `Path:       ${visit.path}\n` +
      `Referrer:   ${visit.referrer || '(none)'}\n` +
      `Source:     ${visit.source}\n`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) return callback(error);
    console.log('Email sent:', info.response);
    callback(null);
  });
}

// /update-ip: receives the public IP from the client and logs the visit
app.post('/update-ip', async (req, res) => {
  const publicIp = req.body.ip;
  if (!publicIp) {
    return res.status(400).send('No IP provided');
  }

  const visit = {
    timestamp: new Date().toISOString(),
    ip: publicIp,
    userAgent: req.get('User-Agent') || '',
    path: req.body.path || '/',
    referrer: req.body.referrer || '',
    source: req.query.source || 'direct',
  };

  try {
    await logVisit(visit);
  } catch (err) {
    // A failed write must not break the page. The counter falls back to the
    // last cached value and the visit is simply not recorded.
    console.error('Error writing to traffic sheet:', err);
    return res.status(500).send('Error logging data');
  }

  if (req.query.source === 'home') {
    return sendVisitEmail(visit, (emailErr) => {
      if (emailErr) console.error('Error sending email:', emailErr);
      res.send('IP updated successfully and email sent');
    });
  }

  res.send('IP updated successfully');
});

// Visitor count for the site's WATCHERS readout
app.get('/get-count', async (req, res) => {
  try {
    const count = await fetchCount();
    res.json({ count });
  } catch (err) {
    console.error('Error reading count from traffic sheet:', err);
    if (countCache.value !== null) {
      return res.json({ count: countCache.value, stale: true });
    }
    res.status(500).json({ error: 'Error reading data' });
  }
});

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Listen on all network interfaces for Azure Web Apps
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
  if (!sheetsConfigured()) {
    console.warn('SHEETS_WEBAPP_URL / SHEETS_TOKEN are unset — traffic logging is disabled.');
  }
});
