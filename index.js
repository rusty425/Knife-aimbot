require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL_ID = '1524377599533645866';
const DB_FILE = path.join(__dirname, 'flag_db.json');

let flagDb = {};
if (fs.existsSync(DB_FILE)) {
    try { flagDb = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { flagDb = {}; }
}

function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(flagDb, null, 2));
}

function getRawBufferHash(buffer) {
    let hash = 0;
    const step = Math.max(1, Math.floor(buffer.length / 500));
    for (let i = 0; i < buffer.length; i += step) {
        hash = ((hash << 5) - hash) + buffer[i];
        hash |= 0;
    }
    return 'h_' + Math.abs(hash);
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

function postJson(url, data) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const payload = JSON.stringify(data);
        const req = https.request(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function sendDiscordMessage(ws, channelId, content) {
    // Send message directly over gateway/http API for max speed
    const payload = JSON.stringify({
        op: 4, // Custom handling or simple REST fallback
        d: { channel_id: channelId, content: content, nonce: Date.now() }
    });
    // REST API is often faster for text delivery in raw scripts:
    const req = https.request(`https://discord.com/api/v9/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': TOKEN,
            'Content-Type': 'application/json'
        }
    });
    req.write(JSON.stringify({ content: content }));
    req.end();
}

function connectGateway() {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
    let heartbeatInterval = null;

    ws.on('open', () => {
        console.log('[RAW GATEWAY] Connected to WebSocket socket...');
    });

    ws.on('message', async (data) => {
        const packet = JSON.parse(data);
        const { t, s, op, d } = packet;

        // Opcode 10: Hello -> Start Heartbeat & Identify
        if (op === 10) {
            heartbeatInterval = setInterval(() => {
                ws.send(JSON.stringify({ op: 1, d: s }));
            }, d.heartbeat_interval);

            // Identify as selfbot
            ws.send(JSON.stringify({
                op: 2,
                d: {
                    token: TOKEN,
                    properties: { os: 'linux', browser: 'chrome', device: 'chrome' },
                    intents: 512 // GUILD_MESSAGES
                }
            }));
            console.log('[RAW GATEWAY] Authenticated & Identified.');
        }

        // Catch incoming messages instantly
        if (t === 'MESSAGE_CREATE') {
            if (d.channel_id !== TARGET_CHANNEL_ID) return;
            if (d.author.id === TOKEN) return; // Ignore self

            let imageUrl = null;
            let isDrawingPhase = false;

            const content = d.content || '';
            if (content.toLowerCase().includes('try to guess the drawing') || content.toLowerCase().includes('level')) {
                isDrawingPhase = true;
            }

            if (d.embeds && d.embeds.length > 0) {
                for (const embed of d.embeds) {
                    const embedText = (embed.description || '') + (embed.title || '') + JSON.stringify(embed.fields || '');
                    if (embedText.includes('TEAM RANKING') || embedText.includes('FINISHED')) continue;
                    if (embedText.includes('Level') || embedText.includes('guess') || embed.image) {
                        isDrawingPhase = true;
                        if (embed.image) imageUrl = embed.image.url || embed.image.proxy_url;
                    }
                }
            }

            if (!imageUrl && d.attachments && d.attachments.length > 0) {
                const att = d.attachments[0];
                if (att.content_type && att.content_type.includes('image')) {
                    imageUrl = att.url;
                    isDrawingPhase = true;
                }
            }

            if (imageUrl && isDrawingPhase) {
                try {
                    let fastUrl = imageUrl.replace(/\.gif(\?|$)/i, '.png$1');
                    if (fastUrl.includes("cdn.discordapp.com")) fastUrl = fastUrl.replace("cdn.discordapp.com", "media.discordapp.net");
                    if (!fastUrl.includes("width=")) fastUrl += (fastUrl.includes("?") ? "&" : "?") + "width=128";

                    const imageBuffer = await fetchBuffer(fastUrl);
                    const rawHash = getRawBufferHash(imageBuffer);

                    // 1. INSTANT HASH CHECK (< 1ms)
                    if (flagDb[rawHash]) {
                        const answer = flagDb[rawHash];
                        console.log(`⚡ [RAW INSTANT]: ${answer}`);
                        sendDiscordMessage(ws, TARGET_CHANNEL_ID, answer);
                        return;
                    }

                    // 2. FALLBACK TO AI
                    const base64Image = imageBuffer.toString('base64');
                    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;
                    
                    const result = await postJson(apiUrl, {
                        contents: [{
                            parts: [
                                { text: "Country name or object. Max 3 words. No 'The'." },
                                { inline_data: { mime_type: "image/png", data: base64Image } }
                            ]
                        }],
                        generationConfig: { temperature: 0.0, maxOutputTokens: 12 }
                    });

                    const parts = result.candidates?.[0]?.content?.parts;
                    if (!parts || parts.length === 0) return;

                    let guess = parts[0].text.trim()
                                 .replace(/\bflag\b/gi, '')
                                 .replace(/^the\s+/gi, '')
                                 .replace(/[^a-zA-Z\s]/g, '')
                                 .trim();

                    const words = guess.split(/\s+/);
                    guess = words.slice(0, 3).join(' ');

                    if (guess && guess.length >= 2) {
                        flagDb[rawHash] = guess;
                        saveDb();
                        console.log(`🤖 [RAW AI LEARNED]: ${guess}`);
                        sendDiscordMessage(ws, TARGET_CHANNEL_ID, guess);
                    }

                } catch (err) {}
            }
        }
    });

    ws.on('close', () => {
        clearInterval(heartbeatInterval);
        setTimeout(connectGateway, 3000); // Auto-reconnect
    });
}

connectGateway();
