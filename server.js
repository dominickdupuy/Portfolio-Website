require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 8080;

// Ensure Express trusts the proxy so req.ip returns the correct IP
app.set('trust proxy', true);

// Middleware to parse JSON bodies from incoming requests
app.use(express.json());

// Utility function: Append a CSV row to user_data.csv (creates header if needed)
function appendToUserData(csvRow, callback) {
  const csvFilePath = path.join(__dirname, 'user_data.csv');
  if (!fs.existsSync(csvFilePath)) {
    fs.writeFileSync(csvFilePath, "Date,User Agent,IP\n");
  }
  fs.appendFile(csvFilePath, csvRow, callback);
}

// Middleware to track the source of the request
const trackSource = (req, res, next) => {
  // Store the source in the request object
  req.requestSource = req.query.source || 'direct';
  next();
};

// /home route: simply redirect to the base URL with a query parameter indicating redirection
app.get('/home', (req, res) => {
  // Redirect with a specific source parameter
  res.redirect('/?source=home');
});

// Apply the trackSource middleware to the root route
app.get('/', trackSource, (req, res, next) => {
  // Serve the index.html file
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Utility function to send the last IP email
function sendLastIpEmail(callback) {
  const csvFilePath = path.join(__dirname, 'user_data.csv');

  if (!fs.existsSync(csvFilePath)) {
    return callback(new Error("No user data found"));
  }

  fs.readFile(csvFilePath, "utf8", (err, data) => {
    if (err) {
      return callback(err);
    }
    
    // Split file content into lines and remove empty lines
    const lines = data.split("\n").filter(line => line.trim() !== "");
    if (lines.length <= 1) { // Only header exists
      return callback(new Error("No entries found"));
    }
    const lastEntry = lines[lines.length - 1];

    // Set up Nodemailer transporter using SMTP configuration from your .env file
    let transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    let mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_RECIPIENT,
      subject: 'Most Recent User Data Entry Logged',
      text: `The most recent entry from user_data.csv:\n${lastEntry}`
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return callback(error);
      }
      console.log("Email sent:", info.response);
      callback(null);
    });
  });
}

// /update-ip endpoint: receives the public IP from the client, logs it, then responds
app.post('/update-ip', (req, res) => {
  const publicIp = req.body.ip;
  if (!publicIp) {
    return res.status(400).send("No IP provided");
  }
  const date = new Date().toISOString();
  const userAgent = req.get('User-Agent');
  const csvRow = `${date},"${userAgent}",${publicIp}\n`;
  
  appendToUserData(csvRow, (err) => {
    if (err) {
      console.error("Error appending to user_data.csv:", err);
      return res.status(500).send("Error logging data");
    }
    
    // If this is a 'home' source request, send the email
    if (req.query.source === 'home') {
      sendLastIpEmail((emailErr) => {
        if (emailErr) {
          console.error("Error sending email:", emailErr);
        }
        res.send("IP updated successfully and email sent");
      });
    } else {
      res.send("IP updated successfully");
    }
  });
});

// New endpoint: Get the visitor count 
app.get('/get-count', (req, res) => {
  const csvFilePath = path.join(__dirname, 'user_data.csv');
  if (!fs.existsSync(csvFilePath)) {
    return res.json({ count: 0 });
  }
  fs.readFile(csvFilePath, "utf8", (err, data) => {
    if (err) {
      console.error("Error reading user_data.csv:", err);
      return res.status(500).json({ error: "Error reading data" });
    }
    // Split into lines, ignoring empty lines.
    const lines = data.split("\n").filter(line => line.trim() !== "");
    // Exclude header (first line), if present.
    let entryCount = lines.length > 0 ? lines.length + 5120 : 0;
    res.json({ count: entryCount });
  });
});

// POST /log-click endpoint (for other logging purposes)
app.post('/log-click', (req, res) => {
  const { csvData } = req.body;
  if (!csvData) {
    return res.status(400).send("No data received");
  }
  appendToUserData(csvData, (err) => {
    if (err) {
      console.error("Error writing to user_data.csv:", err);
      return res.status(500).send("Error logging data");
    }
    res.send("Data logged successfully");
  });
});

// GET /get-data endpoint (to retrieve the CSV)
app.get('/get-data', (req, res) => {
  const csvFilePath = path.join(__dirname, 'user_data.csv');
  if (fs.existsSync(csvFilePath)) {
    fs.readFile(csvFilePath, "utf8", (err, data) => {
      if (err) {
        console.error("Error reading CSV file:", err);
        return res.status(500).send("Error retrieving data");
      }
      res.type("text/csv").send(data);
    });
  } else {
    res.status(404).send("No data found");
  }
});

// Serve static files (e.g., index.html, about.html) from the 'public' directory
app.use(express.static("public"));

// Listen on all network interfaces for Azure Web Apps
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});