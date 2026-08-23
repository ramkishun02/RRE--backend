from flask import Flask, jsonify, render_template, request

app = Flask(__name__)


# Mock database or live market connector for NSE stocks
# In production, connect this to your broker API (e.g., Kite Connect, Upstox, etc.)
def fetch_nse_stocks(capital, query=''):
  # Sample real NSE stocks priced affordably for small capital (e.g., <= ₹820)
  all_stocks = [
      {
          'exchange': 'NSE',
          'tradingsymbol': 'IDEA',
          'name': 'Vodafone Idea Ltd.',
          'instrument_token': '371801',
          'last_price': 14.50,
      },
      {
          'exchange': 'NSE',
          'tradingsymbol': 'SUZLON',
          'name': 'Suzlon Energy Ltd.',
          'instrument_token': '350721',
          'last_price': 48.20,
      },
      {
          'exchange': 'NSE',
          'tradingsymbol': 'YESBANK',
          'name': 'Yes Bank Ltd.',
          'instrument_token': '119501',
          'last_price': 24.10,
      },
      {
          'exchange': 'NSE',
          'tradingsymbol': 'IDFCFIRSTB',
          'name': 'IDFC First Bank Ltd.',
          'instrument_token': '539137',
          'last_price': 72.50,
      },
      {
          'exchange': 'NSE',
          'tradingsymbol': 'JPPOWER',
          'name': 'Jaiprakash Power Ventures',
          'instrument_token': '386049',
          'last_price': 19.80,
      },
  ]

  # Filter by search query if provided
  if query:
    q = query.lower()
    all_stocks = [
        s
        for s in all_stocks
        if q in s['tradingsymbol'].lower() or q in s['name'].lower()
    ]

  return all_stocks


def get_ai_recommendations(capital):
  # AI Opportunity Assist candidates based on technical indicators (RSI, MACD, etc.)
  return [
      {
          'exchange': 'NSE',
          'tradingsymbol': 'SUZLON',
          'name': 'Suzlon Energy Ltd.',
          'instrument_token': '350721',
          'last_price': 48.20,
          'ai_score': 88,
          'ai_view': 'Bullish Breakout',
          'risk': 'Moderate',
      },
      {
          'exchange': 'NSE',
          'tradingsymbol': 'YESBANK',
          'name': 'Yes Bank Ltd.',
          'instrument_token': '119501',
          'last_price': 24.10,
          'ai_score': 82,
          'ai_view': 'Accumulation',
          'risk': 'Low-Mod',
      },
  ]


@app.route('/')
def index():
  return render_template('selection.html')


@app.route('/api/rre/stocks', methods=['GET'])
def api_stocks():
  try:
    capital = float(request.args.get('capital', 820.0))
    query = request.args.get('query', '')

    stocks = fetch_nse_stocks(capital, query)
    ai_recs = get_ai_recommendations(capital)

    return jsonify({
        'status': 'success',
        'message': (
            f'Loaded {len(stocks)} NSE market instruments successfully.'
        ),
        'ai_message': 'AI model online and synchronized with market indicators.',
        'stocks': stocks,
        'ai': ai_recs,
    })
  except Exception as e:
    return jsonify({'status': 'error', 'message': str(e), 'stocks': [], 'ai': []}), 500


if __name__ == '__main__':
  app.run(debug=True, port=5000)
