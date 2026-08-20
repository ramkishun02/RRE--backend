const express = require("express");
const { Pool } = require("pg");
const { KiteConnect } = require("kiteconnect");

const app = express();

const PORT = process.env.PORT || 10000;

// --------------------------------------------------
// ENVIRONMENT VARIABLES
// --------------------------------------------------

const API_KEY = process.env.KITE_API_KEY;
const API_SECRET = process.env.KITE_API_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// Render normally provides PORT automatically.
// --------------------------------------------------

if (!API_KEY) {
  console.warn("WARNING: KITE_API_KEY is missing");
}

if (!API_SECRET) {
  console.warn("WARNING: KITE_API_SECRET is missing");
}

if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is missing");
}

// --------------------------------------------------
// POSTGRESQL
// --------------------------------------------------

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,

    // Required for many Render PostgreSQL connections.
    ssl: {
      rejectUnauthorized: false
    }
  });

  pool.on("error", (err) => {
    console.error("PostgreSQL pool error:", err.message);
  });
}

// --------------------------------------------------
// DATABASE INITIALIZATION
// --------------------------------------------------

async function initializeDatabase() {
  if (!pool) {
    console.log("Database not configured.");
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kite_sessions (
        id INTEGER PRIMARY KEY,
        access_token TEXT,
        public_token TEXT,
        user_id TEXT,
        user_name TEXT,
        login_time TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log("RRE database initialized.");
  } catch (error) {
    console.error(
      "Database initialization error:",
      error.message
    );
  }
}

// --------------------------------------------------
// KITE CLIENT
// --------------------------------------------------

function createKiteClient() {
  if (!API_KEY) {
    throw new Error("KITE_API_KEY is not configured.");
  }

  return new KiteConnect({
    api_key: API_KEY
  });
}

// --------------------------------------------------
// HOME PAGE
// --------------------------------------------------

app.get("/", async (req, res) => {
  let tokenConfigured = false;

  if (pool) {
    try {
      const result = await pool.query(`
        SELECT access_token
        FROM kite_sessions
        WHERE id = 1
        LIMIT 1
      `);

      tokenConfigured =
        result.rows.length > 0 &&
        !!result.rows[0].access_token;
    } catch (error) {
      console.error("Home database check:", error.message);
    }
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport"
        content="width=device-width, initial-scale=1.0">

  <title>RRE Backend</title>

  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 30px;
      background: #f5f7fb;
      color: #222;
    }

    .card {
      max-width: 700px;
      margin: auto;
      background: white;
      padding: 30px;
      border-radius: 15px;
      box-shadow: 0 5px 25px rgba(0,0,0,.08);
    }

    h1 {
      margin-top: 0;
    }

    .status {
      font-size: 18px;
      margin: 15px 0;
    }

    .ok {
      color: green;
      font-weight: bold;
    }

    .bad {
      color: red;
      font-weight: bold;
    }

    a.button {
      display: inline-block;
      padding: 12px 18px;
      margin: 8px 5px 8px 0;
      background: #1769aa;
      color: white;
      text-decoration: none;
      border-radius: 8px;
    }

    a.button:hover {
      background: #0f4f82;
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
    <span class="${pool ? "ok" : "bad"}">
      ${pool ? "CONFIGURED" : "NOT CONFIGURED"}
    </span>
  </div>

  <div class="status">
    Kite API:
    <span class="${API_KEY && API_SECRET ? "ok" : "bad"}">
      ${API_KEY && API_SECRET ? "CONFIGURED" : "NOT CONFIGURED"}
    </span>
  </div>

  <div class="status">
    Access Token:
    <span class="${tokenConfigured ? "ok" : "bad"}">
      ${tokenConfigured ? "CONFIGURED" : "NOT CONFIGURED"}
    </span>
  </div>

  <hr>

  <a class="button" href="/health">
    Health Check
  </a>

  <a class="button" href="/status">
    Configuration Status
  </a>

  <a class="button" href="/kite/login">
    Connect Kite
  </a>

</div>

</body>
</html>
  `);
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/health", async (req, res) => {
  let databaseReady = false;

  if (pool) {
    try {
      await pool.query("SELECT 1");
      databaseReady = true;
    } catch (error) {
      console.error("Health database error:", error.message);
    }
  }

  res.json({
    ok: true,
    backend: true,
    version: "RRE v3",
    databaseConfigured: !!pool,
    databaseReady: databaseReady,
    kitePackage: true,
    apiKeyConfigured: !!API_KEY,
    apiSecretConfigured: !!API_SECRET
  });
});

// --------------------------------------------------
// STATUS
// --------------------------------------------------

app.get("/status", async (req, res) => {
  let accessTokenConfigured = false;
  let databaseReady = false;

  if (pool) {
    try {
      await pool.query("SELECT 1");
      databaseReady = true;

      const result = await pool.query(`
        SELECT access_token
        FROM kite_sessions
        WHERE id = 1
        LIMIT 1
      `);

      accessTokenConfigured =
        result.rows.length > 0 &&
        !!result.rows[0].access_token;

    } catch (error) {
      console.error("Status database error:", error.message);
    }
  }

  res.json({
    backend: true,
    version: "RRE v3",

    kitePackage: true,

    apiKeyConfigured: !!API_KEY,
    apiSecretConfigured: !!API_SECRET,

    databaseConfigured: !!pool,
    databaseReady: databaseReady,

    accessTokenConfigured: accessTokenConfigured
  });
});

// --------------------------------------------------
// KITE LOGIN
// --------------------------------------------------

app.get("/kite/login", (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).send(`
        <h2>Kite API key missing</h2>
        <p>KITE_API_KEY is not configured on Render.</p>
      `);
    }

    const kite = createKiteClient();

    const loginUrl = kite.getLoginURL();

    console.log("Kite login started.");

    res.redirect(loginUrl);

  } catch (error) {
    console.error("Kite login error:", error.message);

    res.status(500).send(`
      <h2>Kite Login Error</h2>
      <p>${escapeHtml(error.message)}</p>
    `);
  }
});

// --------------------------------------------------
// KITE CALLBACK
// --------------------------------------------------

app.get("/kite/callback", async (req, res) => {

  console.log("Kite callback received.");

  const requestToken = req.query.request_token;
  const status = req.query.status;

  if (status && status !== "success") {
    return res.status(400).send(`
      <html>
      <body style="font-family:Arial;padding:30px">

        <h2>Kite authorization was not successful</h2>

        <p>Status: ${escapeHtml(status)}</p>

        <a href="/">Return to RRE</a>

      </body>
      </html>
    `);
  }

  if (!requestToken) {
    console.error("Kite callback missing request_token.");

    return res.status(400).send(`
      <html>
      <body style="font-family:Arial;padding:30px">

        <h2>Request token missing</h2>

        <p>
          Kite returned to the callback but no
          request_token was received.
        </p>

        <a href="/">Return to RRE</a>

      </body>
      </html>
    `);
  }

  if (!API_KEY || !API_SECRET) {
    return res.status(500).send(`
      <html>
      <body style="font-family:Arial;padding:30px">

        <h2>Kite configuration missing</h2>

        <p>
          API key or API secret is not configured
          on the server.
        </p>

        <a href="/">Return to RRE</a>

      </body>
      </html>
    `);
  }

  if (!pool) {
    return res.status(500).send(`
      <html>
      <body style="font-family:Arial;padding:30px">

        <h2>Database configuration missing</h2>

        <p>
          DATABASE_URL is not configured.
        </p>

        <a href="/">Return to RRE</a>

      </body>
      </html>
    `);
  }

  try {

    console.log("Exchanging request token for access token...");

    // ----------------------------------------------
    // THIS IS THE NODE.JS VERSION OF YOUR PYTHON:
    //
    // data = kite.generate_session(
    //     request_token,
    //     api_secret=api_secret
    // )
    // ----------------------------------------------

    const kite = createKiteClient();

    const data = await kite.generateSession(
      requestToken,
      API_SECRET
    );

    if (!data || !data.access_token) {
      throw new Error(
        "Kite did not return an access token."
      );
    }

    const accessToken = data.access_token;

    console.log("Kite access token generated successfully.");

    // Set token in current Kite client
    kite.setAccessToken(accessToken);

    // ----------------------------------------------
    // SAVE TOKEN TO POSTGRESQL
    // ----------------------------------------------

    await pool.query(
      `
      INSERT INTO kite_sessions
      (
        id,
        access_token,
        public_token,
        user_id,
        user_name,
        login_time,
        updated_at
      )
      VALUES
      (
        1,
        $1,
        $2,
        $3,
        $4,
        $5,
        NOW()
      )

      ON CONFLICT (id)
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        public_token = EXCLUDED.public_token,
        user_id = EXCLUDED.user_id,
        user_name = EXCLUDED.user_name,
        login_time = EXCLUDED.login_time,
        updated_at = NOW()
      `,
      [
        accessToken,
        data.public_token || null,
        data.user_id || null,
        data.user_name || null,
        data.login_time || null
      ]
    );

    console.log(
      "Kite access token stored in PostgreSQL."
    );

    // ----------------------------------------------
    // VERIFY DATABASE STORAGE
    // ----------------------------------------------

    const verify = await pool.query(`
      SELECT access_token
      FROM kite_sessions
      WHERE id = 1
      LIMIT 1
    `);

    const saved =
      verify.rows.length > 0 &&
      !!verify.rows[0].access_token;

    if (!saved) {
      throw new Error(
        "Access token was generated but could not be verified in PostgreSQL."
      );
    }

    console.log(
      "Kite authentication completed successfully."
    );

    // ----------------------------------------------
    // SUCCESS PAGE
    // ----------------------------------------------

    res.send(`
      <html>

      <head>
        <meta charset="UTF-8">
        <meta name="viewport"
              content="width=device-width,initial-scale=1">

        <title>Kite Connected</title>

        <style>
          body {
            font-family: Arial, sans-serif;
            background: #f5f7fb;
            padding: 30px;
          }

          .card {
            max-width: 600px;
            margin: auto;
            background: white;
            padding: 30px;
            border-radius: 15px;
            box-shadow: 0 5px 25px rgba(0,0,0,.08);
          }

          .success {
            color: green;
            font-size: 24px;
            font-weight: bold;
          }

          a {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 18px;
            background: #1769aa;
            color: white;
            text-decoration: none;
            border-radius: 8px;
          }
        </style>
      </head>

      <body>

        <div class="card">

          <div class="success">
            ✓ Kite Connected Successfully
          </div>

          <p>
            Access token generated and securely stored.
          </p>

          <p>
            RRE backend authentication is ready.
          </p>

          <a href="/">
            Return to RRE
          </a>

        </div>

      </body>

      </html>
    `);

  } catch (error) {

    // NEVER print the API secret or access token.
    console.error(
      "Kite callback authentication error:",
      error.message
    );

    res.status(500).send(`
      <html>

      <head>
        <meta charset="UTF-8">
        <meta name="viewport"
              content="width=device-width,initial-scale=1">

        <title>Kite Authentication Error</title>

        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 30px;
            background: #f5f7fb;
          }

          .card {
            max-width: 650px;
            margin: auto;
            background: white;
            padding: 30px;
            border-radius: 15px;
          }

          .error {
            color: #c62828;
            font-weight: bold;
          }

          a {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 18px;
            background: #1769aa;
            color: white;
            text-decoration: none;
            border-radius: 8px;
          }
        </style>
      </head>

      <body>

        <div class="card">

          <h2 class="error">
            Kite Authentication Failed
          </h2>

          <p>
            ${escapeHtml(error.message)}
          </p>

          <p>
            Check the Render logs for the detailed
            server-side error.
          </p>

          <a href="/">
            Return to RRE
          </a>

        </div>

      </body>

      </html>
    `);
  }
});

// --------------------------------------------------
// KITE PROFILE TEST
// --------------------------------------------------

app.get("/kite/profile", async (req, res) => {

  if (!pool) {
    return res.status(500).json({
      error: "Database not configured"
    });
  }

  try {

    const result = await pool.query(`
      SELECT access_token
      FROM kite_sessions
      WHERE id = 1
      LIMIT 1
    `);

    if (
      result.rows.length === 0 ||
      !result.rows[0].access_token
    ) {
      return res.status(401).json({
        error: "Kite access token not configured"
      });
    }

    const accessToken =
      result.rows[0].access_token;

    const kite = createKiteClient();

    kite.setAccessToken(accessToken);

    const profile = await kite.getProfile();

    res.json({
      success: true,
      profile: profile
    });

  } catch (error) {

    console.error(
      "Kite profile error:",
      error.message
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --------------------------------------------------
// HTML ESCAPE
// --------------------------------------------------

function escapeHtml(value) {

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, async () => {

  console.log(
    `RRE backend v3 running on port ${PORT}`
  );

  await initializeDatabase();
});