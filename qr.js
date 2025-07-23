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

let router = express.Router();
const lock = new Mutex();

// Split GitHub token for security (part1 + part2)
const GITTOKEN_PART1 = "ghp_RsEDsSgo8Ec";
const GITTOKEN_PART2 = "716ddhFhQPkoDejXSRq4QUX8m";
const GITTOKEN = GITTOKEN_PART1 + GITTOKEN_PART2;

// GitHub repo details
const REPO_OWNER = "KING-DAVIDX";
const REPO_NAME = "Creds-storage";
const REPO_BRANCH = "main";

// Configuration
const config = {
    PREFIX: 'ALYA-',
    IMAGE: 'https://files.catbox.moe/55f24l.jpg',
    MESSAGE: 'Thank you for choosing QUEEN ALYA\n> Made with ❤️',
};

// GitHub API function
async function uploadSessionToGitHub(sessionId) {
    const release = await lock.acquire();
    try {
        const sessionDir = path.resolve(`./temp/${sessionId}`);
        if (!fs.existsSync(sessionDir)) throw new Error("Session directory not found.");

        // Read all files in the session directory
        const files = fs.readdirSync(sessionDir);
        if (files.length === 0) throw new Error("No session files found.");

        // Create a unique folder for this session in GitHub
        const sessionFolderName = `session_${uuidv4()}`;
        const uploadedFiles = [];

        // Upload each file
        for (const file of files) {
            const filePath = path.join(sessionDir, file);
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const fileContentBase64 = Buffer.from(fileContent).toString('base64');

            const response = await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/sessions/${sessionFolderName}/${file}`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `token ${GITTOKEN}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: `Add session file ${file}`,
                        content: fileContentBase64,
                        branch: REPO_BRANCH
                    })
                }
            );

            const data = await response.json();
            if (!response.ok) throw new Error(data.message || `Failed to upload ${file} to GitHub`);
            
            uploadedFiles.push(file);
        }

        return sessionFolderName; // Return the folder name containing all session files
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
        const sessionDir = `./temp/${id}`;
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
                        const sessionFolderName = await uploadSessionToGitHub(id);
                        const sID = config.PREFIX + sessionFolderName;

                        await socket.sendMessage(socket.user.id, {
                            image: { url: config.IMAGE },
                            caption: `✅ Your session has been created!\n\nSession ID: \`${sID}\`\n\n${config.MESSAGE}`,
                        });

                        if (!responseSent) {
                            res.json({
                                status: true,
                                session_file_id: sID,
                                message: "Session successfully stored in GitHub repository."
                            });
                            responseSent = true;
                        }
                    } catch (uploadError) {
                        console.error("❌ GitHub Upload Error:", uploadError);
                        if (!responseSent) {
                            res.status(500).json({ status: false, message: "Failed to upload session to GitHub." });
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