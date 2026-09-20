// Exchanges shown in the app. Live numbers come from CoinGecko; these are stable facts
// used when live data can't load. `radar` = listing tracking supported by Firstprint's tracker.

export const EXCHANGES = [
  { id: 'binance', liveData: true, logo: 'https://cdn.simpleicons.org/binance/F0B90B', cg: 'binance', name: 'Binance', founded: 2017, url: 'https://www.binance.com', radar: ['Announcements', 'New trading pairs'] },
  { id: 'coinbase', logo: 'https://cdn.simpleicons.org/coinbase/0052FF', cg: 'gdax', name: 'Coinbase Exchange', founded: 2012, url: 'https://www.coinbase.com', radar: [] },
  { id: 'okx', logo: 'https://cdn.simpleicons.org/okx/FFFFFF', cg: 'okex', name: 'OKX', founded: 2017, url: 'https://www.okx.com', radar: ['Announcements', 'New trading pairs', 'Listing times'] },
  { id: 'bybit', liveData: true, logo: 'https://cdn.simpleicons.org/bybit/F7A600', cg: 'bybit_spot', name: 'Bybit', founded: 2018, url: 'https://www.bybit.com', radar: ['Announcements', 'New trading pairs'] },
  { id: 'upbit', logo: 'https://cdn.simpleicons.org/upbit/093687', cg: 'upbit', name: 'Upbit', founded: 2017, url: 'https://upbit.com', radar: [] },
  { id: 'bitget', logo: 'https://cdn.simpleicons.org/bitget/00F0B5', cg: 'bitget', name: 'Bitget', founded: 2018, url: 'https://www.bitget.com', radar: ['Announcements', 'New trading pairs'] },
  { id: 'gate', logo: 'https://cdn.simpleicons.org/gateio/2354E6', cg: 'gate', name: 'Gate', founded: 2013, url: 'https://www.gate.com', radar: ['New trading pairs', 'Listing times'] },
  { id: 'kucoin', logo: 'https://cdn.simpleicons.org/kucoin/23AF91', cg: 'kucoin', name: 'KuCoin', founded: 2017, url: 'https://www.kucoin.com', radar: ['Announcements', 'New trading pairs'] },
  { id: 'mexc', liveData: true, logo: 'https://cdn.simpleicons.org/mexc/00A4DB', cg: 'mxc', name: 'MEXC', founded: 2018, url: 'https://www.mexc.com', radar: ['New trading pairs'] },
  { id: 'kraken', logo: 'https://cdn.simpleicons.org/kraken/5741D9', cg: 'kraken', name: 'Kraken', founded: 2011, url: 'https://www.kraken.com', radar: [] },
  { id: 'htx', logo: 'https://cdn.simpleicons.org/htx/2A5ADA', cg: 'huobi', name: 'HTX', founded: 2013, url: 'https://www.htx.com', radar: [] },
  { id: 'cryptocom', logo: 'https://cdn.simpleicons.org/cryptocom/1199FA', cg: 'crypto_com', name: 'Crypto.com Exchange', founded: 2016, url: 'https://crypto.com/exchange', radar: [] },
  { id: 'bitfinex', logo: 'https://cdn.simpleicons.org/bitfinex/16B157', cg: 'bitfinex', name: 'Bitfinex', founded: 2012, url: 'https://www.bitfinex.com', radar: [] },
];
