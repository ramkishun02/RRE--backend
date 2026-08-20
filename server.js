const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
let databaseReady = false;

/* =========================================================
   DATABASE
========================================================= */

async function initializeDatabase() {
    if (!DATABASE_URL) {
        console.log("DATABASE_URL missing");
        return;
    }

    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS kite_tokens (
                id SERIAL PRIMARY KEY,
                access_token TEXT NOT NULL,
                user_id TEXT,
                login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        databaseReady = true;
        console.log("RRE database initialized.");
    } catch (error) {
        databaseReady = false;
        console.error("Database initialization error:", error.message);
    }
}

/* =========================================================
   KITE LOGIN
========================================================= */

app.get("/kite/login", (req, res) => {

    if (!KITE_API_KEY) {
        return res.status(500).send(`
            <h2>Kite API key missing</h2>
        `);
    }

    const loginUrl =
        `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(KITE_API_KEY)}`;

    res.redirect(loginUrl);
});

/* =========================================================
   KITE CALLBACK
========================================================= */

app.get("/kite/callback", async (req, res) => {

    console.log("====================================");
    console.log("KITE CALLBACK RECEIVED");
    console.log("====================================");

    const requestToken = req.query.request_token;
    const status = req.query.status;

    console.log("Kite status:", status);
    console.log(
        "Request token received:",
        requestToken ? "YES" : "NO"
    );

    if (!requestToken) {
        return res.status(400).send(`
            <html>
            <body style="font-family:Arial;padding:30px">
                <h2 style="color:red">Kite Login Failed</h2>
                <p>No request_token was received.</p>
                <a href="/">Return to RRE</a>
            </body>
            </html>
        `);
    }

    if (!KITE_API_KEY || !KITE_API_SECRET) {
        return res.status(500).send(`
            <html>
            <body style="font-family:Arial;padding:30px">
                <h2 style="color:red">Kite configuration missing</h2>
                <p>KITE_API_KEY or KITE_API_SECRET is missing.</p>
            </body>
            </html>
        `);
    }

    try {

        console.log("Generating Kite checksum...");

        /*
         Kite checksum:
         SHA256(api_key + request_token + api_secret)
        */

        const checksum = crypto
            .createHash("sha256")
            .update(
                KITE_API_KEY +
                requestToken +
                KITE_API_SECRET
            )
            .digest("hex");

        console.log("Checksum generated.");

        console.log("Exchanging request token for access token...");

        const response = await fetch(
            "https://api.kite.trade/session/token",
            {
                method: "POST",

                headers: {
                    "X-Kite-Version": "3",
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },

                body: new URLSearchParams({
                    api_key: KITE_API_KEY,
                    request_token: requestToken,
                    checksum: checksum
                }).toString()
            }
        );

        const data = await response.json();

        console.log(
            "Kite token response status:",
            response.status
        );

        if (!response.ok || data.status !== "success") {

            console.error(
                "Kite token exchange failed:",
                JSON.stringify(data)
            );

            return res.status(401).send(`
                <html>
                <body style="font-family:Arial;padding:30px">
                    <h2 style="color:red">
                        Kite Authentication Failed
                    </h2>

                    <p>
                        Kite did not return an access token.
                    </p>

                    <p>
                        Check Render Logs for the exact Kite response.
                    </p>

                    <a href="/">Return to RRE</a>
                </body>
                </html>
            `);
        }

        const accessToken = data.data.access_token;
        const userId = data.data.user_id || null;

        console.log("Kite access token generated successfully.");
        console.log("Kite user:", userId || "unknown");

        if (!accessToken) {
            throw new Error(
                "Kite response did not contain access_token"
            );
        }

        /* =================================================
           SAVE TOKEN TO POSTGRESQL
        ================================================= */

        if (!pool || !databaseReady) {
            throw new Error(
                "Database is not ready; token cannot be stored."
            );
        }

        console.log(
            "Saving Kite access token to PostgreSQL..."
        );

        await pool.query(
            `
            INSERT INTO kite_tokens
            (
                access_token,
                user_id
            )
            VALUES ($1, $2)
            `,
            [
                accessToken,
                userId
            ]
        );

        console.log(
            "Kite access token stored in PostgreSQL."
        );

        console.log(
            "Kite authentication completed successfully."
        );

        /* =================================================
           RETURN TO RRE
        ================================================= */

        res.send(`
            <!DOCTYPE html>

            <html>

            <head>
                <meta charset="UTF-8">

                <title>Kite Connected</title>

                <meta
                    name="viewport"
                    content="width=device-width,initial-scale=1"
                >

                <style>

                    body {
                        font-family: Arial, sans-serif;
                        background: #f4f7fb;
                        padding: 30px;
                        text-align: center;
                    }

                    .box {
                        max-width: 500px;
                        margin: 50px auto;
                        background: white;
                        padding: 30px;
                        border-radius: 16px;
                        box-shadow:
                            0 5px 25px
                            rgba(0,0,0,.12);
                    }

                    h1 {
                        color: #198754;
                    }

                    a {
                        display: inline-block;
                        margin-top: 20px;
                        padding: 12px 22px;
                        background: #1976d2;
                        color: white;
                        text-decoration: none;
                        border-radius: 8px;
                    }

                </style>

            </head>

            <body>

                <div class="box">

                    <h1>✓ Kite Connected</h1>

                    <p>
                        Authentication completed successfully.
                    </p>

                    <p>
                        Access token has been securely
                        stored in PostgreSQL.
                    </p>

                    <a href="/">
                        Return to RRE
                    </a>

                </div>

            </body>

            </html>
        `);

    } catch (error) {

        console.error(
            "Kite callback authentication error:",
            error
        );

        res.status(500).send(`
            <html>

            <body
                style="
                    font-family:Arial;
                    padding:30px
                "
            >

                <h2 style="color:red">
                    Kite Authentication Error
                </h2>

                <p>
                    ${escapeHtml(error.message)}
                </p>

                <a href="/">
                    Return to RRE
                </a>

            </body>

            </html>
        `);
    }
});

/* =========================================================
   GET LATEST ACCESS TOKEN
========================================================= */

async function getLatestToken() {

    if (!pool || !databaseReady) {
        return null;
    }

    try {

        const result = await pool.query(`
            SELECT
                access_token,
                user_id,
                login_time
            FROM kite_tokens
            ORDER BY created_at DESC
            LIMIT 1
        `);

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];

    } catch (error) {

        console.error(
            "Token database read error:",
            error.message
        );

        return null;
    }
}

/* =========================================================
   ROOT / RRE PAGE
========================================================= */

app.get("/", async (req, res) => {

    const token = await getLatestToken();

    const tokenConfigured = !!token;

    res.send(`
        <!DOCTYPE html>

        <html>

        <head>

            <meta charset="UTF-8">

            <meta
                name="viewport"
                content="width=device-width,initial-scale=1"
            >

            <title>RRE Backend v3</title>

            <style>

                body {
                    margin: 0;
                    padding: 30px;
                    font-family: Arial, sans-serif;
                    background: #f4f7fb;
                }

                .card {
                    max-width: 700px;
                    margin: 30px auto;
                    background: white;
                    padding: 30px;
                    border-radius: 18px;
                    box-shadow:
                        0 5px 25px
                        rgba(0,0,0,.10);
                }

                h1 {
                    margin-top: 0;
                }

                .status {
                    font-size: 18px;
                    margin: 15px 0;
                }

                .ok {
                    color: #198754;
                    font-weight: bold;
                }

                .bad {
                    color: #dc3545;
                    font-weight: bold;
                }

                .buttons {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                    margin-top: 25px;
                }

                a {
                    background: #1976d2;
                    color: white;
                    padding: 13px 18px;
                    border-radius: 8px;
                    text-decoration: none;
                }

            </style>

        </head>

        <body>

            <div class="card">

                <h1>RRE Backend v3</h1>

                <div class="status">
                    Backend:
                    <span class="ok">RUNNING</span>
                </div>

                <div class="status">
                    Database:
                    <span class="${databaseReady ? "ok" : "bad"}">
                        ${databaseReady ? "CONFIGURED" : "NOT CONFIGURED"}
                    </span>
                </div>

                <div class="status">
                    Kite API:
                    <span
                        class="${
                            KITE_API_KEY && KITE_API_SECRET
                                ? "ok"
                                : "bad"
                        }"
                    >
                        ${
                            KITE_API_KEY && KITE_API_SECRET
                                ? "CONFIGURED"
                                : "NOT CONFIGURED"
                        }
                    </span>
                </div>

                <div class="status">
                    Access Token:
                    <span class="${tokenConfigured ? "ok" : "bad"}">
                        ${
                            tokenConfigured
                                ? "CONFIGURED"
                                : "NOT CONFIGURED"
                        }
                    </span>
                </div>

                <hr>

                <div class="buttons">

                    <a href="/health">
                        Health Check
                    </a>

                    <a href="/status">
                        Configuration Status
                    </a>

                    <a href="/kite/login">
                        Connect Kite
                    </a>

                </div>

            </div>

        </body>

        </html>
    `);
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", async (req, res) => {

    const token = await getLatestToken();

    res.json({
        backend: true,
        kitePackage: true,
        apiKeyConfigured: !!KITE_API_KEY,
        apiSecretConfigured: !!KITE_API_SECRET,
        databaseConfigured: !!DATABASE_URL,
        databaseReady: databaseReady,
        accessTokenConfigured: !!token,
        timestamp: new Date().toISOString()
    });
});

/* =========================================================
   STATUS
========================================================= */

app.get("/status", async (req, res) => {

    const token = await getLatestToken();

    res.json({
        backend: true,

        database: {
            configured: !!DATABASE_URL,
            ready: databaseReady
        },

        kite: {
            apiKeyConfigured: !!KITE_API_KEY,
            apiSecretConfigured: !!KITE_API_SECRET
        },

        accessToken: {
            configured: !!token,
            userId: token ? token.user_id : null,
            loginTime: token ? token.login_time : null
        }
    });
});

/* =========================================================
   ESCAPE HTML
========================================================= */

function escapeHtml(value) {

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {

        console.log(
            `RRE backend v3 running on port ${PORT}`
        );

        console.log(
            "API key configured:",
            !!KITE_API_KEY
        );

        console.log(
            "API secret configured:",
            !!KITE_API_SECRET
        );

        console.log(
            "Database configured:",
            !!DATABASE_URL
        );

    });
}

startServer();