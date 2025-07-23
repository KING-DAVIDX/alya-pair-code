const express = require('express');
const bodyParser = require("body-parser");
const app = express();
const PORT = process.env.PORT || 8000;

__path = process.cwd();

let server = require('./qr');
let code = require('./pair');

require('events').EventEmitter.defaultMaxListeners = 500;

// Fix for express-rate-limit issue
app.set('trust proxy', 1); 

// Move bodyParser before routes
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Define routes after middleware
app.use('/qr', server);
app.use('/code', code);

// Ensure only one response per request
app.use('/pair', (req, res) => {
    if (!res.headersSent) res.sendFile(__path + '/public/pair.html');
});

app.use('/', (req, res) => {
    if (!res.headersSent) res.sendFile(__path + '/public/index.html');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
module.exports = app;