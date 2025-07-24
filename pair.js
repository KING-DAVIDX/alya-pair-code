require("dotenv").config();
const express = require("express");
const { Mutex } = require("async-mutex");
const fs = require("fs");
const path = require("path");
const { delay } = require("baileys");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const pino = require("pino");
const { useMultiFileAuthState, makeCacheableSignalKeyStore, default: makeWASocket, Browsers } = require("baileys");
const router = express.Router();
const lock = new Mutex();
const Mega = require('megajs');

// Mega account credentials
const MEGA_EMAIL = 'ajayid340@gmail.com';
const MEGA_PASSWORD = 'Toram2006#';

// Configuration
const config = {
    PREFIX: 'ALYA-',
    IMAGE: 'https://files.catbox.moe/55f24l.jpg',
    MESSAGE: 'Thank you for choosing QUEEN ALYA\n> Made with ❤️',
};

// Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { status: false, message: "Too many requests, try again later." },
});
router.use(apiLimiter);

// MegaJS upload function
async function uploadSessionToMega(sessionId) {
    const release = await lock.acquire();
    try {
        const sessionDir = path.join('/tmp', sessionId);
        if (!fs.existsSync(sessionDir)) throw new Error("Session directory not found.");

        const storage = await new Mega({
            email: MEGA_EMAIL,
            password: MEGA_PASSWORD,
            autologin: false
        }).login();

        const folder = await storage.root.mkdir('WhatsApp_Sessions').catch(() => storage.root.children.find(c => c.name === 'WhatsApp_Sessions'));
        const sessionFolder = await folder.mkdir(`${config.PREFIX}${sessionId}`);
        
        const files = fs.readdirSync(sessionDir);
        
        for (const file of files) {
            const filePath = path.join(sessionDir, file);
            await sessionFolder.upload(filePath, { name: file });
        }

        const link = await sessionFolder.link();
        return link;
    } catch (error) {
        throw error;
    } finally {
        release();
    }
}

// WhatsApp Pairing Endpoint
router.get('/', async (req, res) => {
    const id = uuidv4();
    let num = req.query.number;
    let responseSent = false;
    let socket = null;
    let retryCount = 0;
    const maxRetries = 3;

    // Validate phone number
    if (!num || !num.match(/^[0-9]+$/)) {
        return res.status(400).json({ status: false, message: "Invalid phone number" });
    }

    const sessionDir = path.join('/tmp', id);
    
    // Ensure directory exists
    if (!fs.existsSync('/tmp')) {
        fs.mkdirSync('/tmp', { recursive: true });
    }
    
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const cleanup = async () => {
        try {
            if (socket && !socket.ws.closed) {
                await socket.ws.close();
            }
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        } catch (cleanupError) {
            console.error("Cleanup error:", cleanupError);
        }
    };

    const generatePairingCode = async () => {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.macOS("Safari"),
                connectTimeoutMs: 30000,
                keepAliveIntervalMs: 15000
            });

            socket.ev.on('creds.update', saveCreds);

            // Handle pairing code generation with retry logic
            if (!socket.authState.creds.registered) {
                while (retryCount < maxRetries) {
                    try {
                        const code = await socket.requestPairingCode(num);
                        if (!responseSent) {
                            res.json({ code });
                            responseSent = true;
                        }
                        return true;
                    } catch (pairError) {
                        retryCount++;
                        console.error(`❌ Pairing Error (Attempt ${retryCount}/${maxRetries}):`, pairError);
                        
                        if (retryCount < maxRetries) {
                            await delay(2000); // Wait before retrying
                        } else {
                            throw pairError;
                        }
                    }
                }
            }
            return false;
        } catch (error) {
            throw error;
        }
    };

    try {
        const pairingSuccess = await generatePairingCode();
        if (!pairingSuccess) return;

        socket.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === "open") {
                try {
                    await delay(5000); // Give more time for the connection to stabilize
                    
                    const sessionLink = await uploadSessionToMega(id);
                    const sID = config.PREFIX + id;

                    await socket.sendMessage(socket.user.id, {
                        image: { url: config.IMAGE },
                        caption: `✅ Your session has been created!\n\nSession ID: \`${sID}\`\nDownload Link: ${sessionLink}`,
                    });

                    if (!responseSent) {
                        res.json({
                            status: true,
                            session_file_id: sID,
                            download_link: sessionLink,
                            message: "Session successfully stored in Mega cloud."
                        });
                        responseSent = true;
                    }
                } catch (uploadError) {
                    console.error("❌ Mega Upload Error:", uploadError);
                    if (!responseSent) {
                        res.status(500).json({ status: false, message: "Failed to upload session to Mega." });
                        responseSent = true;
                    }
                } finally {
                    await cleanup();
                }
            } else if (connection === "close") {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401; // don't reconnect on authentication error
                if (lastDisconnect?.error) {
                    console.error("❌ Connection closed with error:", lastDisconnect.error);
                }
                
                if (!responseSent) {
                    if (shouldReconnect && retryCount < maxRetries) {
                        retryCount++;
                        console.log(`Attempting reconnect (${retryCount}/${maxRetries})`);
                        await delay(2000);
                        await generatePairingCode();
                    } else {
                        res.status(503).json({ 
                            status: false, 
                            message: "Connection closed before completion" 
                        });
                        responseSent = true;
                        await cleanup();
                    }
                }
            }
        });

    } catch (err) {
        console.error("❌ Error in generatePairCode:", err);
        if (!responseSent) {
            res.status(500).json({ 
                status: false, 
                message: "Internal server error during pairing",
                error: err.message 
            });
            responseSent = true;
        }
        await cleanup();
    }
});

module.exports = router;