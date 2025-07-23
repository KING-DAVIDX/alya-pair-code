const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8000;

// Use __dirname instead of process.cwd() for more reliable path resolution
const __path = path.join(__dirname, 'public');

// Import routes
const qrRouter = require('./qr');
const codeRouter = require('./pair');

// Increase event listeners if needed
require('events').EventEmitter.defaultMaxListeners = 500;

// Middleware
app.set('trust proxy', 1);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(__path));

// API routes
app.use('/api/qr', qrRouter);
app.use('/api/code', codeRouter);

// HTML routes
app.get('/pair', (req, res) => {
    res.sendFile(path.join(__path, 'pair.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__path, 'index.html'));
});

// Vercel requires module.exports for serverless functions
if (process.env.VERCEL) {
    module.exports = app;
} else {
    // Local development
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}