from flask import Flask, jsonify, request, send_from_directory
import os

app = Flask(__name__, static_folder=".")

try:
    from kiteconnect import KiteConnect
except ImportError:
    KiteConnect = None

def get_kite():
    api_key = os.getenv("KITE_API_KEY", "").strip()
    access_token = os.getenv("KITE_ACCESS_TOKEN", "").strip()
    if not KiteConnect:
        raise RuntimeError("kiteconnect is not installed. Run: pip install kiteconnect")
    if not api_key:
        raise RuntimeError("KITE_API_KEY is missing")
    if not access_token:
        raise RuntimeError("KITE_ACCESS_TOKEN is missing")
    kite = KiteConnect(api_key=api_key)
    kite.set_access_token(access_token)
    return kite

@app.get("/")
def home():
    return send_from_directory(".", "market_test.html")

@app.get("/api/market/status")
def market_status():
    try:
        kite = get_kite()
        profile = kite.profile()
        return jsonify(connected=True, status="LIVE",
                       user=profile.get("user_name") or profile.get("user_id"),
                       message="Kite connection and market API are working.")
    except Exception as e:
        return jsonify(connected=False, status="OFFLINE", message=str(e)), 503

@app.get("/api/market/search")
def market_search():
    query = request.args.get("q", "").strip().upper()
    if not query:
        return jsonify(connected=True, stocks=[], message="Enter a symbol or company name.")
    try:
        kite = get_kite()
        matches = []
        for item in kite.instruments("NSE"):
            symbol = str(item.get("tradingsymbol") or "").upper()
            name = str(item.get("name") or "").upper()
            if query in symbol or query in name:
                matches.append({
                    "exchange":"NSE",
                    "tradingsymbol":item["tradingsymbol"],
                    "name":item.get("name") or item["tradingsymbol"],
                    "instrument_token":str(item["instrument_token"])
                })
            if len(matches) >= 25:
                break

        keys = [f"NSE:{x['tradingsymbol']}" for x in matches]
        quotes = kite.ltp(keys) if keys else {}
        stocks = []
        for item in matches:
            q = quotes.get(f"NSE:{item['tradingsymbol']}", {})
            price = float(q.get("last_price") or 0)
            if price > 0:
                item["last_price"] = price
                stocks.append(item)

        return jsonify(connected=True, stocks=stocks,
                       message=f"{len(stocks)} live NSE result(s) found.")
    except Exception as e:
        return jsonify(connected=False, stocks=[], message=str(e)), 503

if __name__ == "__main__":
    print("RRE MARKET CONNECTION TEST")
    print("Open http://127.0.0.1:5000/")
    app.run(host="127.0.0.1", port=5000, debug=False)
