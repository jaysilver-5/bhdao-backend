const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');
const ECPair = ECPairFactory(ecc);
const kp = ECPair.makeRandom({ network: { wif: 0xef } });
console.log('WIF:', kp.toWIF());
const { payments, networks } = require('bitcoinjs-lib');
const { address } = payments.p2pkh({ pubkey: Buffer.from(kp.publicKey), network: networks.testnet });
console.log('Address:', address);
console.log('Fund from: https://coinfaucet.eu/en/btc-testnet/');
