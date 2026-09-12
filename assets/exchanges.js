// Exchanges shown in the app. Live numbers come from CoinGecko; these are stable facts
// used when live data can't load. `radar` = listing tracking supported by Firstprint's tracker.

export const EXCHANGES = [
  { id: 'binance', cg: 'binance', name: 'Binance', founded: 2017, url: 'https://www.binance.com', radar: ['Announcements', 'New trading pairs'] },
  { id: 'coinbase', cg: 'gdax', name: 'Coinbase Exchange', founded: 2012, url: 'https://www.coinbase.com', radar: [] },
  { id: 'okx', cg: 'okex', name: 'OKX', founded: 2017, url: 'https://www.okx.com', radar: ['Announcements', 'New trading pairs', 'Listing times'] },
  { id: 'bybit', cg: 'bybit_spot', name: 'Bybit', founded: 2018, url: 'https://www.bybit.com', radar: ['Announcements', 'New trading pairs'] },
  { id: 'upbit', cg: 'upbit', name: 'Upbit', founded: 2017, url: 'https://upbit.com', radar: [] },
  { id: 'bitget', cg: 'bitget', name: 'Bitget', founded: 2018, url: 'https://www.bitget.com', radar: ['Announcements', 'New trading pairs'] },
  { id: 'gate', cg: 'gate', name: 'Gate', founded: 2013, url: 'https://www.gate.com', radar: ['New trading pairs', 'Listing times'] },
  { id: 'kucoin', cg: 'kucoin', name: 'KuCoin', founded: 2017, url: 'https://www.kucoin.com', radar: ['Announcements', 'New trading pairs'] },
  { id: 'mexc', cg: 'mxc', name: 'MEXC', founded: 2018, url: 'https://www.mexc.com', radar: ['New trading pairs'] },
  { id: 'kraken', cg: 'kraken', name: 'Kraken', founded: 2011, url: 'https://www.kraken.com', radar: [] },
  { id: 'htx', cg: 'huobi', name: 'HTX', founded: 2013, url: 'https://www.htx.com', radar: [] },
  { id: 'cryptocom', cg: 'crypto_com', name: 'Crypto.com Exchange', founded: 2016, url: 'https://crypto.com/exchange', radar: [] },
  { id: 'bitfinex', cg: 'bitfinex', name: 'Bitfinex', founded: 2012, url: 'https://www.bitfinex.com', radar: [] },
];
