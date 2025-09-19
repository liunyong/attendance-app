const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const readline = require('readline');
const cron = require('node-cron');
const TZ = 'Asia/Shanghai';

function ymdInTZ(tz, d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

const app = express();
const port = 3000;
const MONGO_URI_FILE = path.join(__dirname, 'mongoUri.json');
const IPLIST_FILE = path.join(__dirname, 'iplist.json');
const DEFAULT_IPS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

function readAllowedIPs() {
  if (fs.existsSync(IPLIST_FILE)) {
    try {
      const data = fs.readFileSync(IPLIST_FILE, 'utf-8');
      const obj = JSON.parse(data);
      return Object.values(obj);
    } catch (e) {
      return DEFAULT_IPS;
    }
  } else {
    // 파일이 없으면 생성
    const obj = {
      localv4: "127.0.0.1",
      localv6: "::1",
      localv6tov4: "::ffff:127.0.0.1"
    };
    fs.writeFileSync(IPLIST_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    console.log('iplist.json is generated, please add your school IP if needed.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter the IP address (No just Enter): ', (ip) => {
      if (ip && ip.trim()) {
        obj.School = ip.trim();
        fs.writeFileSync(IPLIST_FILE, JSON.stringify(obj, null, 2), 'utf-8');
        console.log('IP is added to iplist.json');
      }
      rl.close();
    });
    return Object.values(obj);
  }
}

const allowedIPs = readAllowedIPs();

app.use((req, res, next) => {
  const clientIP =
    req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

  if (allowedIPs.includes(clientIP)) {
    next(); // allowed IP -> next router
  } else {
    console.log(`Access denied: ${clientIP}`)
    res.status(403).send("Access denied: Your network is not allowed. Please connect to WB Faculty Wifi.");
  }
});

// Session settings
app.use(session({
  secret: 'attendance-secret',
  resave: false,
  saveUninitialized: true
}));



app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 1. Read URI from mongoUri.json
function readMongoUriFromFile() {
  if (fs.existsSync(MONGO_URI_FILE)) {
    try {
      const data = fs.readFileSync(MONGO_URI_FILE, 'utf-8');
      const obj = JSON.parse(data);
      if (obj && obj.uri) return obj.uri;
    } catch (e) {}
  }
  return null;
}

// 2. Save URI to mongoUri.json
function saveMongoUriToFile(uri) {
  fs.writeFileSync(MONGO_URI_FILE, JSON.stringify({ uri }, null, 2), 'utf-8');
}

// 3. Ask MongoDB URI from terminal
function askMongoUri() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter MongoDB connection URI (e.g., mongodb://localhost:27017/attendance): ', (uri) => {
      rl.close();
      resolve(uri);
    });
  });
}

// 4. Try to connect to MongoDB
async function tryConnectMongo(uri) {
  try {
    await mongoose.connect(uri);
    return true;
  } catch (e) {
    return false;
  }
}

// Ensure collections exist
async function ensureCollections(db) {
  const collections = await db.listCollections().toArray();
  const names = collections.map(c => c.name);
  if (!names.includes('teachers')) await db.createCollection('teachers');
  if (!names.includes('admin')) await db.createCollection('admin');
  if (!names.includes('log')) await db.createCollection('log');
}

// Ensure at least one admin exists
async function ensureAdmin(db) {
  const adminCol = db.collection('admin');
  const adminCount = await adminCol.countDocuments();
  if (adminCount === 0) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter admin ID: ', (id) => {
      rl.question('Enter admin password: ', async (pw) => {
        const hash = await bcrypt.hash(pw, 10);
        await adminCol.insertOne({ id, password: hash });
        console.log('Admin account has been created.');
        rl.close();
        startServer();
      });
    });
  } else {
    startServer();
  }
}

// Schemas
const teacherSchema = new mongoose.Schema({
  name: String,
  excused: { type: Boolean, default: false },
  password: String
});
const adminSchema = new mongoose.Schema({
  id: String,
  password: String
});
const logSchema = new mongoose.Schema({
  name: String,
  check_in_time: Date,
  late: Boolean,
  notAttended: Boolean,
  date: String // YYYY-MM-DD
});
const Teacher = mongoose.model('Teacher', teacherSchema, 'teachers');
const Admin = mongoose.model('Admin', adminSchema, 'admin');
const Log = mongoose.model('Log', logSchema, 'log');

// Admin login
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});
app.post('/login', async (req, res) => {
  const { id, password } = req.body;
  const admin = await Admin.findOne({ id });
  if (!admin) return res.render('login', { error: 'Admin does not exist.' });
  const valid = await bcrypt.compare(password, admin.password);
  if (!valid) return res.render('login', { error: 'Incorrect password.' });
  req.session.admin = id;
  res.redirect('/log');
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Teacher check-in
app.post('/checkin', async (req, res) => {
  const { teacher, password } = req.body;
  const teacherObj = await Teacher.findOne({ name: teacher });
  if (!teacherObj) return res.json({ success: false, message: "Invalid teacher." });
  const valid = await bcrypt.compare(password, teacherObj.password);
  if (!valid) return res.json({ success: false, message: "Incorrect password." });

  const currentDate = ymdInTZ(TZ);
  const already = await Log.findOne({ name: teacher, date: currentDate });
  if (already) return res.json({ success: false, message: "Already checked in today." });

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    numberingSystem: 'latn',   // 0-9 보장 (안전)
  });
  const lateLimit = teacherObj.excused ? "07:40" : "07:30";
  const isLate = timeStr > lateLimit;

  await Log.create({
    name: teacher,
    check_in_time: now,
    late: isLate,
    notAttended: false,
    date: currentDate
  });

  res.json({ success: true, message: "Check-in completed!" });
});

// Teacher registration
app.post('/register-teacher', async (req, res) => {
  const { name, excused, password } = req.body;
  if (!name || !password) return res.json({ success: false, message: "Please enter name and password." });

  const exists = await Teacher.findOne({ name });
  if (exists) return res.json({ success: false, message: "This name is already registered." });

  const hash = await bcrypt.hash(password, 10);
  await Teacher.create({ name, excused: !!excused, password: hash }); // !!excused forcing format change to boolean
  res.json({ success: true, message: "Teacher has been registered." });
});

// Admin registration
app.post('/register-admin', async (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.json({ success: false, message: "Please enter ID and password." });
  const exists = await Admin.findOne({ id });
  if (exists) return res.json({ success: false, message: "This ID is already registered." });
  const hash = await bcrypt.hash(password, 10);
  await Admin.create({ id, password: hash });
  res.json({ success: true, message: "Admin has been registered." });
});

// Log page (admin authentication required)
app.get('/log', async (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  const logs = await Log.find({});
  // Accumulate latecomers
  const lateSummary = {};
  logs.forEach(log => {
    if (log.late) {
      if (!lateSummary[log.name]) lateSummary[log.name] = [];
      lateSummary[log.name].push({
        date: log.date,
        time: log.check_in_time ? log.check_in_time.toTimeString().slice(0, 5) : null,
        notAttended: log.notAttended
      });
    }
  });
  const lateList = Object.entries(lateSummary).map(([name, details]) => ({
    name,
    count: details.length,
    details
  }));
  res.render('log', { lateSummary: lateList });
});

// Main page
app.get('/', async (req, res) => {
  const teachers = await Teacher.find({});
  res.render('checkin', { teachers });
});

// Start server
function startServer() {
  app.listen(port, () => {
    console.log(`Attendance app listening at http://localhost:${port}`);
  });
}

// Main execution flow
(async () => {
  let mongoUri = readMongoUriFromFile();
  let connected = false;

  if (mongoUri) {
    process.stdout.write('Trying to connect to DB saved in /attendance_app/mongoUri.json');
    connected = await tryConnectMongo(mongoUri);
    if (connected) {
      console.log('..Success!');
    } else {
      console.log('..Failed!');
    }
  }

  while (!connected) {
    mongoUri = await askMongoUri();
    process.stdout.write('Trying to connect to entered DB ... ');
    connected = await tryConnectMongo(mongoUri);
    if (connected) {
      console.log('..Success!');
      saveMongoUriToFile(mongoUri);
    } else {
      console.log('..Failed!');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const retry = await new Promise(res => {
        rl.question('Connection failed! Try another link? (y/n): ', answer => {
          rl.close();
          res(answer.trim().toLowerCase() === 'y');
        });
      });
      if (!retry) {
        console.log('Exiting program.');
        process.exit(1);
      }
    }
  }

  const db = mongoose.connection.db;
  await ensureCollections(db);
  await ensureAdmin(db);
})();
