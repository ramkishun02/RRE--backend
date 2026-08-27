"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = 5000;
const HOST = "0.0.0.0";
const ROOT = __dirname;

/*
  Put your real values here temporarily.
  Do not share this file publicly after adding your secret.
*/
const KITE_API_KEY = "YOUR_KITE_API_KEY";
const KITE_API_SECRET = "YOUR_KITE_API_SECRET";
const KITE_REDIRECT_URL =
  "http://localhost:5000/auth/kite/callback";

/*
  Temporary in-memory session.
  For one-user local testing, this is enough.
*/
let accessToken = "";
let userId = "";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function kiteRequest(method, requestPath, body, callback) {
  const postData = body
    ? new URLSearchParams(body).toString()
    : null;

  const options = {
    hostname: "api.kite.trade",
    path: requestPath,
    method,
    headers: {
      "X-Kite-Version": "3"
    }
  };

  if (accessToken) {
    options.headers.Authorization =
      `token ${KITE_API_KEY}:${accessToken}`;
  }

  if (postData) {
    options.headers["Content-Type"] =
      "application/x-www-form-urlencoded";
    options.headers["Content-Length"] =
      Buffer.byteLength(postData);
  }

  const request = https.request(options, (response) => {
    let responseBody = "";

    response.on("data", (chunk) => {
      responseBody += chunk;
    });

    response.on("end", () => {
      let data;

      try {
        data = JSON.parse(responseBody);
      } catch {
        data = responseBody;
      }

      callback(null, response.statusCode, data);
    });
  });

  request.on("error", (error) => {
    callback(error);
  });

  if (postData) {
    request.write(postData);
  }

  request.end();
}

function serveStaticFile(req, res) {
  let pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const safePath = path.normalize(pathname).replace(/^(..[/\\])+/, "");
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  fs.readFile(filePath, (error, file) => {
    if (error) {
      if (error.code === "ENOENT") {
        return sendJson(res, 404, { error: "File not found" });
      }

      console.error(error);
      return sendJson(res, 500, { error: "Cannot read file" });
    }

    const extension = path.extname(filePath).toLowerCase();

    res.writeHead(200, {
      "Content-Type":
        MIME_TYPES[extension] || "application/octet-stream"
    });

    res.end(file);
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const pathname = requestUrl.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });

    return res.end();
  }

  /*
    Start Kite login
  */
  if (req.method === "GET" && pathname === "/auth/kite/login") {
    const loginUrl =
      "https://kite.zerodha.com/connect/login?v=3" +
      `&api_key=${encodeURIComponent(KITE_API_KEY)}`;

    return redirect(res, loginUrl);
  }

  /*
    Kite callback after successful login
  */
  if (
    req.method === "GET" &&
    pathname === "/auth/kite/callback"
  ) {
    const status = requestUrl.searchParams.get("status");
    const requestToken =
      requestUrl.searchParams.get("request_token");

    if (status !== "success" || !requestToken) {
      return sendJson(res, 400, {
        error: "Kite login was not completed"
      });
    }

    const checksum = crypto
      .createHash("sha256")
      .update(
        KITE_API_KEY +
          requestToken +
          KITE_API_SECRET
      )
      .digest("hex");

    return kiteRequest(
      "POST",
      "/session/token",
      {
        api_key: KITE_API_KEY,
        request_token: requestToken,
        checksum
      },
      (error, statusCode, data) => {
        if (error) {
          console.error(error);
          return sendJson(res, 500, {
            error: "Could not connect to Kite"
          });
        }

        if (
          statusCode < 200 ||
          statusCode >= 300 ||
          !data.data
        ) {
          return sendJson(res, statusCode || 500, {
            error: data.message || "Kite authentication failed",
            details: data
          });
        }

        accessToken = data.data.access_token;
        userId = data.data.user_id || "";

        console.log("Kite authentication completed");

        redirect(res, "/?kite=connected");
      }
    );
  }

  /*
    Authentication status
  */
  if (
    req.method === "GET" &&
    pathname === "/api/auth/status"
  ) {
    return sendJson(res, 200, {
      connected: Boolean(accessToken),
      userId: userId || null
    });
  }

  /*
    Logout
  */
  if (
    req.method === "POST" &&
    pathname === "/api/auth/logout"
  ) {
    accessToken = "";
    userId = "";

    return sendJson(res, 200, {
      success: true
    });
  }

  /*
    Stock search
    This version searches Kite instruments directly.
  */
  if (
    req.method === "GET" &&
    pathname === "/api/stocks/search"
  ) {
    if (!accessToken) {
      return sendJson(res, 401, {
        error: "Please connect Kite first"
      });
    }

    const query = (
      requestUrl.searchParams.get("q") || ""
    ).trim().toUpperCase();

    if (!query) {
      return sendJson(res, 200, []);
    }

    return kiteRequest(
      "GET",
      "/instruments",
      null,
      (error, statusCode, data) => {
        if (error) {
          console.error(error);
          return sendJson(res, 500, {
            error: "Could not download Kite instruments"
          });
        }

        if (statusCode < 200 || statusCode >= 300) {
          return sendJson(res, statusCode, {
            error: data.message || "Kite instruments request failed"
          });
        }

        const lines = String(data).split("");
    const headings = lines.shift().split(",");

        const symbolIndex =
          headings.indexOf("tradingsymbol");
        const nameIndex = headings.indexOf("name");
        const exchangeIndex =
          headings.indexOf("exchange");
        const tokenIndex =
          headings.indexOf("instrument_token");

        const results = [];

        for (const line of lines) {
          if (!line.trim()) continue;

          const columns = line.split(",");
          const symbol = columns[symbolIndex] || "";
          const name = columns[nameIndex] || "";
          const exchange = columns[exchangeIndex] || "";

          if (
            symbol.toUpperCase().includes(query) ||
            name.toUpperCase().includes(query)
          ) {
            results.push({
              symbol,
              name,
              exchange,
              instrumentToken: columns[tokenIndex] || null
            });
          }

          if (results.length >= 20) break;
        }

        sendJson(res, 200, results);
      }
    );
  }

  /*
    Quote endpoint
    Example:
    /api/stocks/quote?instrument=NSE:INFY
  */
  if (
    req.method === "GET" &&
    pathname === "/api/stocks/quote"
  ) {
    if (!accessToken) {
      return sendJson(res, 401, {
        error: "Please connect Kite first"
      });
    }

    const instrument =
      requestUrl.searchParams.get("instrument");

    if (!instrument) {
      return sendJson(res, 400, {
        error: "Missing instrument, example NSE:INFY"
      });
    }

    const kitePath =
      "/quote?i=" +
      encodeURIComponent(instrument);

    return kiteRequest(
      "GET",
      kitePath,
      null,
      (error, statusCode, data) => {
        if (error) {
          return sendJson(res, 500, {
            error: "Could not connect to Kite"
          });
        }

        sendJson(res, statusCode, data);
      }
    );
  }

  /*
    Serve index.html, app.js, style.css and images
  */
  serveStaticFile(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Kite callback: ${KITE_REDIRECT_URL}`);
});