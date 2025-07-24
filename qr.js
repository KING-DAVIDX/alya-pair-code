const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require("pino");
const { Mutex } = require("async-mutex");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay,
    makeCacheableSignalKeyStore
} = require("baileys");
const { v4: uuidv4 } = require("uuid");
const QRCode = require('qrcode');
const Mega = require('megajs');
const archiver = require('archiver');

let router = express.Router();
const lock = new Mutex();

// Mega account credentials
const MEGA_EMAIL = 'ajayid340@gmail.com';
const MEGA_PASSWORD = 'Toram2006#';

// Configuration
const config = {
    PREFIX: 'ALYA-',
    IMAGE: 'https://files.catbox.moe/55f24l.jpg',
    MESSAGE: 'Thank you for choosing QUEEN ALYA\n> Made with ❤️',
};

// MegaJS upload function
async function uploadSessionToMega(sessionId) {
    const release = await lock.acquire();
    try {
        const sessionDir = path.join('/tmp', sessionId);
        if (!fs.existsSync(sessionDir)) throw new Error("Session directory not found.");

        // Create a zip file
        const zipPath = path.join('/tmp', `${sessionId}.zip`);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        return new Promise((resolve, reject) => {
            output.on('close', async () => {
                try {
                    const storage = await new Mega({
                        email: MEGA_EMAIL,
                        password: MEGA_PASSWORD,
                        autologin: false
                    }).login();

                    const folder = await storage.root.mkdir('WhatsApp_Sessions');
                    const file = await folder.upload(zipPath, { name: `${config.PREFIX}${sessionId}.zip` });
                    const link = await file.link();
                    
                    fs.unlinkSync(zipPath);
                    resolve(link);
                } catch (error) {
                    reject(error);
                }
            });

            archive.on('error', (err) => reject(err));
            archive.pipe(output);
            archive.directory(sessionDir, false);
            archive.finalize();
        });
    } catch (error) {
        throw error;
    } finally {
        release();
    }
}

function removeFile(FilePath) {
    if (!fs.existsSync(FilePath)) return false;
    fs.rmSync(FilePath, { recursive: true, force: true });
}

// WhatsApp QR Code Pairing Endpoint
router.get('/', async (req, res) => {
    const id = uuidv4();
    let responseSent = false;

    async function generateQRCode() {
        const sessionDir = path.join('/tmp', id);
        
        // Ensure directory exists
        if (!fs.existsSync('/tmp')) {
            fs.mkdirSync('/tmp', { recursive: true });
        }
        
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        try {
            const socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.macOS("Safari")
            });

            socket.ev.on('creds.update', saveCreds);
            socket.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr && !responseSent) {
                    responseSent = true;
                    return res.end(await QRCode.toBuffer(qr));
                }

                if (connection === "open") {
                    await delay(5000);

                    try {
                        const sessionLink = await uploadSessionToMega(id);
                        const sID = config.PREFIX + id;

                        await socket.sendMessage(socket.user.id, {
                            image: { url: config.IMAGE },
                            caption: `✅ Your session has been created!\n\nSession ID: \`${sID}\`\nDownload Link: ${sessionLink}\n\n${config.MESSAGE}`,
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
                    }

                    await delay(100);
                    await socket.ws.close();
                    removeFile(sessionDir);
                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode != 401) {
                    console.error("❌ Connection closed with error:", lastDisconnect.error);
                    await delay(10000);
                    generateQRCode();
                }
            });
        } catch (err) {
            console.error("❌ Error in generateQRCode:", err);
            removeFile(sessionDir);
            if (!responseSent) {
                res.status(503).json({ code: "Service Unavailable" });
                responseSent = true;
            }
        }
    }

    return await generateQRCode();
});

module.exports = router;