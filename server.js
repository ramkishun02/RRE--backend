const express = require("express");
const cors = require("cors");
const path = require("path");

let KiteConnect;
try {
  ({ KiteConnect } = require("kiteconnect"));
} catch (e) {
  console.error("kiteconnect package is not installed.");
}

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const env = name => (process.env[name] || "").trim();

function getKite() {
  if (!KiteConnect) throw new Error("kiteconnect package is not installed");
  const apiKey = env("KITE_API_KEY");
  if (!apiKey) throw new Error("KITE_API_KEY is missing");

  const kite = new KiteConnect({ api_key: apiKey });
  if (env("KITE_ACCESS_TOKEN")) kite.setAccessToken(env("KITE_ACCESS_TOKEN"));
  return kite;
}

function esc(v) {
  return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

app.get("/health", (req,res) => res.json({
  ok:true, service:"RRE Node.js Backend", time:new Date().toISOString()
}));

app.get("/api/status", (req,res) => res.json({
  backend:true,
  kitePackage:!!KiteConnect,
  apiKeyConfigured:!!env("KITE_API_KEY"),
  accessTokenConfigured:!!env("KITE_ACCESS_TOKEN")
}));

app.get("/kite/login", (req,res) => {
  try { res.redirect(getKite().getLoginURL()); }
  catch(e) { res.status(500).json({ok:false,message:e.message}); }
});

app.get("/kite/callback", async (req,res) => {
  const requestToken = String(req.query.request_token || "").trim();
  if (!requestToken) return res.status(400).send("<h2>RRE Kite Callback</h2><p>No request_token received.</p>");

  try {
    const apiKey = env("KITE_API_KEY");
    const apiSecret = env("KITE_API_SECRET");
    if (!apiKey || !apiSecret) throw new Error("KITE_API_KEY or KITE_API_SECRET is missing");

    const kite = new KiteConnect({api_key:apiKey});
    const session = await kite.generateSession(requestToken,{api_secret:apiSecret});

    res.send(`<h2>RRE Kite Authentication Successful</h2>
      <p>User: ${esc(session.user_name || session.user_id || "Connected")}</p>
      <p>Access token received by backend. It is not displayed here.</p>
      <p>You can close this page and return to RRE.</p>`);
  } catch(e) {
    res.status(500).send(`<h2>RRE Kite Authentication Failed</h2><p>${esc(e.message)}</p>`);
  }
});

app.get("/api/kite/profile", async (req,res) => {
  try {
    if (!env("KITE_ACCESS_TOKEN")) throw new Error("KITE_ACCESS_TOKEN is not configured");
    const p = await getKite().getProfile();
    res.json({ok:true,connected:true,user_id:p.user_id,user_name:p.user_name,email:p.email});
  } catch(e) {
    res.status(401).json({ok:false,connected:false,message:e.message});
  }
});

app.get("/api/market/search", async (req,res) => {
  const q = String(req.query.q || "").trim().toUpperCase();
  if (!q) return res.json({ok:true,stocks:[],message:"Enter a symbol or company name."});

  try {
    if (!env("KITE_ACCESS_TOKEN")) throw new Error("KITE_ACCESS_TOKEN is not configured");
    const kite = getKite();
    const instruments = await kite.getInstruments("NSE");

    const matches = instruments.filter(x =>
      String(x.tradingsymbol || "").toUpperCase().includes(q) ||
      String(x.name || "").toUpperCase().includes(q)
    ).slice(0,25);

    let quotes = {};
    try {
      if (matches.length) quotes = await kite.getLTP(matches.map(x => `NSE:${x.tradingsymbol}`));
    } catch(e) {
      console.warn("LTP unavailable:",e.message);
    }

    const stocks = matches.map(x => {
      const quote = quotes[`NSE:${x.tradingsymbol}`] || {};
      return {
        exchange:"NSE",
        tradingsymbol:x.tradingsymbol,
        name:x.name || x.tradingsymbol,
        instrument_token:String(x.instrument_token),
        last_price:quote.last_price || null
      };
    });

    res.json({ok:true,stocks,message:`${stocks.length} NSE result(s) found.`});
  } catch(e) {
    res.status(500).json({ok:false,stocks:[],message:e.message});
  }
});

app.get("/api/market/quote", async (req,res) => {
  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ok:false,message:"Symbol is required."});

  try {
    if (!env("KITE_ACCESS_TOKEN")) throw new Error("KITE_ACCESS_TOKEN is not configured");
    const key = `NSE:${symbol}`;
    const data = await getKite().getLTP([key]);
    const quote = data[key];
    if (!quote) return res.status(404).json({ok:false,message:"No quote returned."});
    res.json({ok:true,exchange:"NSE",tradingsymbol:symbol,last_price:quote.last_price,instrument_token:quote.instrument_token});
  } catch(e) {
    res.status(500).json({ok:false,message:e.message});
  }
});

app.post("/api/rre/decision", (req,res) => {
  const symbol = String(req.body?.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ok:false,message:"Symbol is required."});
  res.json({
    ok:true,stage:"DECISION_PENDING",symbol,aiAssist:true,
    userConfirmationRequired:true,userConfirmed:!!req.body?.userConfirmed,
    message:"No order was placed. User confirmation is required."
  });
});

app.use(express.static(path.join(__dirname,"public")));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,"0.0.0.0",()=>console.log(`RRE backend running on port ${PORT}`));
