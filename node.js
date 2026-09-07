const got = require('got');
const { HttpProxyAgent, HttpsProxyAgent } = require('hpagent');

const proxyUrl = 'http://your_client_id:your_client_secret@dc46-mum-01.algoip.in:443';

got('https://ip64.algoip.in/all?format=json', {
  agent: {
    http: new HttpProxyAgent({ proxy: proxyUrl }),
    https: new HttpsProxyAgent({ proxy: proxyUrl })
  }
})
  .json()
  .then(data => console.log('Got Client verified details:', data))
  .catch(err => console.error(err));