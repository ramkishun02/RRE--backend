# RRE Node.js Backend

Cloud-ready Node.js/Express backend for RRE + Kite Connect.

## Render
Build command:
npm install

Start command:
npm start

## Environment variables
Set these in Render:
KITE_API_KEY
KITE_API_SECRET
KITE_ACCESS_TOKEN

Never commit real credentials to GitHub.

## Endpoints
GET /health
GET /api/status
GET /kite/login
GET /kite/callback
GET /api/kite/profile
GET /api/market/search?q=RELIANCE
GET /api/market/quote?symbol=RELIANCE
POST /api/rre/decision

## Kite redirect
After Render deployment:
https://YOUR-SERVICE.onrender.com/kite/callback

The decision endpoint does NOT place orders. Order execution will be added only after authentication, market data, and user-confirmation flow are verified.
