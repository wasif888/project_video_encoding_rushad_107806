const express = require('express');
const fileUpload = require('express-fileupload');
const jwt = require('jsonwebtoken');
const ffmpeg = require('fluent-ffmpeg');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const SECRET_KEY = 'your_secret_key_here'; 

// MySQL connection setup
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'video_transcoder',
};

// Middleware setup
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  fileUpload({
    limits: { fileSize: 100 * 1024 * 1024 }, 
    abortOnLimit: true,
  })
);
app.use(express.static('public'));

// Ensure the 'videos' directory exists
if (!fs.existsSync('videos')) {
  fs.mkdirSync('videos', { recursive: true });
}

// Helper function to get a database connection
async function getDbConnection() {
  return await mysql.createConnection(dbConfig);
}

// Check if the database is connected
async function checkDbConnection() {
  try {
    const connection = await getDbConnection();
    await connection.query('SELECT 1'); // Test query to ensure connection is established
    await connection.end();
    console.log('Database connection successful');
  } catch (error) {
    console.error('Database connection failed:', error.message);
  }
}

// Check database connection on startup
checkDbConnection();

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login Endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const connection = await getDbConnection();
    const [rows] = await connection.execute(
      'SELECT * FROM users WHERE username = ? AND password = ?',
      [username, password]
    );

    if (rows.length > 0) {
      const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: '1h' });
      res.json({ success: true, token });
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    await connection.end();
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  console.log('Token received:', token); 

  if (!token) {
    console.log("No token provided");
    return res.sendStatus(403);
  }

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      console.log("Token verification failed:", err.message);
      return res.sendStatus(403);
    }
    req.user = user;
    next();
  });
}

// Upload Video Endpoint
app.post('/upload', authenticateToken, async (req, res) => {
  if (!req.files || !req.files.video) {
    return res.status(400).send('No video uploaded');
  }

  const video = req.files.video;
  const videoId = Date.now();
  const videoPath = path.join(__dirname, 'videos', `${videoId}_${video.name}`);

  try {
    // Move the video file
    await video.mv(videoPath);

    const connection = await getDbConnection();
    await connection.execute(
      'INSERT INTO videos (videoId, path, owner) VALUES (?, ?, ?)',
      [videoId, videoPath, req.user.username]
    );

    await connection.end();
    res.send('Video uploaded successfully');
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).send('Server error during file upload');
  }
});

// List Videos Endpoint
app.get('/videos', authenticateToken, async (req, res) => {
  try {
    const connection = await getDbConnection();
    const [rows] = await connection.execute(
      'SELECT * FROM videos WHERE owner = ?',
      [req.user.username]
    );

    await connection.end();
    res.json(rows);
  } catch (err) {
    console.error('List videos error:', err.message);
    res.status(500).send('Server error');
  }
});

// Transcode Video Endpoint
app.post('/transcode', authenticateToken, async (req, res) => {
  const { videoId, format } = req.body;

  try {
    const connection = await getDbConnection();
    const [rows] = await connection.execute(
      'SELECT * FROM videos WHERE videoId = ? AND owner = ?',
      [videoId, req.user.username]
    );

    if (rows.length === 0) {
      return res.status(404).send('Video not found');
    }

    const video = rows[0];
    const outputFormat = format || 'mp4';
    const outputVideo = path.join(__dirname, 'videos', `${videoId}_transcoded.${outputFormat}`);

    ffmpeg(video.path)
      .toFormat(outputFormat)
      .save(outputVideo)
      .on('end', async () => {
        // Save the transcoded video to the database if needed
        await connection.execute(
          'INSERT INTO videos (videoId, path, owner) VALUES (?, ?, ?)',
          [Date.now(), outputVideo, req.user.username] 
        );
        await connection.end();
        res.send(`Video transcoded successfully to ${outputFormat}`);
      })
      .on('error', (err) => {
        console.error('Transcoding error:', err.message);
        res.status(500).send(`Error during transcoding: ${err.message}`);
      });
  } catch (err) {
    console.error('Transcode error:', err.message);
    res.status(500).send('Server error during transcoding');
  }
});

// Download Video Endpoint
app.get('/download/:videoId', authenticateToken, async (req, res) => {
  try {
    const connection = await getDbConnection();
    const [rows] = await connection.execute(
      'SELECT * FROM videos WHERE videoId = ? AND owner = ?',
      [req.params.videoId, req.user.username]
    );

    if (rows.length === 0) {
      return res.status(404).send('Video not found');
    }

    const video = rows[0];
    res.download(video.path, (err) => {
      if (err) {
        console.error('Download error:', err.message);
        res.status(500).send('Error during download');
      }
    });

    await connection.end();
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).send('Server error during download');
  }
});

// Database status check endpoint
app.get('/db-status', async (req, res) => {
  try {
    const connection = await getDbConnection();
    await connection.query('SELECT 1'); 
    await connection.end();
    res.send('Database connection successful');
  } catch (err) {
    console.error('DB status check error:', err.message);
    res.status(500).send('Database connection failed: ' + err.message);
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
