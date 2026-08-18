from flask import Flask,jsonify,request,send_from_directory
import os,uuid
from datetime import datetime
app=Flask(__name__)
try:
 from kiteconnect import KiteConnect
except ImportError: KiteConnect=None
def kite():
 key=os.getenv('KITE_API_KEY','').strip(); token=os.getenv('KITE_ACCESS_TOKEN','').strip()
 if not KiteConnect or not key or not token:return None
 k=KiteConnect(api_key=key);k.set_access_token(token);return k
@app.get('/')
def root():return send_from_directory('.', 'index.html')
@app.get('/api/rre/status')
def status():
 k=kite();return jsonify(connected=bool(k),message='Real market connected' if k else 'Backend not connected')
@app.get('/api/rre/stocks')
def stocks():
 capital=float(request.args.get('capital',820));query=request.args.get('query','').strip().upper();k=kite()
 if not k:return jsonify(connected=False,message='Kite backend not connected. Configure KITE_API_KEY and KITE_ACCESS_TOKEN.',stocks=[],ai=[]),503
 try:
  ins=k.instruments('NSE');matches=[]
  for x in ins:
   sym=(x.get('tradingsymbol') or '').upper();name=(x.get('name') or '').upper()
   if query and query not in sym and query not in name:continue
   matches.append(x)
   if len(matches)>=100:break
  keys=[f"NSE:{x['tradingsymbol']}" for x in matches];quotes=k.ltp(keys) if keys else {};result=[]
  for x in matches:
   p=float(quotes.get(f"NSE:{x['tradingsymbol']}",{}).get('last_price') or 0)
   if p>0:result.append({'exchange':'NSE','tradingsymbol':x['tradingsymbol'],'instrument_token':str(x['instrument_token']),'name':x.get('name') or x['tradingsymbol'],'last_price':p})
  ai=[dict(x,ai_score=None,ai_view='AI model pending',risk='—') for x in result if int(capital/x['last_price'])>0][:6]
  return jsonify(connected=True,message=f'{len(result)} real NSE result(s) loaded.',ai_message='Real market connected. AI can analyze these candidates next.',stocks=result,ai=ai)
 except Exception as e:return jsonify(connected=False,message=str(e),stocks=[],ai=[]),502
@app.post('/api/rre/paper-order')
def paper():
 x=request.get_json(force=True);x['trade_id']=str(uuid.uuid4());x['mode']='PAPER';x['started_at']=datetime.now().isoformat();x['current_price']=x.get('entry_price');x['stop_loss']=x.get('entry_price');return jsonify(ok=True,trade=x)
if __name__=='__main__':app.run(host='127.0.0.1',port=5000,debug=False)
