import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

const TESTNET_API = 'https://blockstream.info/testnet/api';
const MAINNET_API = 'https://blockstream.info/api';
const MEMPOOL_TESTNET = 'https://mempool.space/testnet';
const MEMPOOL_MAINNET = 'https://mempool.space';

@Injectable()
export class BitcoinService {
  private readonly logger = new Logger(BitcoinService.name);
  private readonly network: 'testnet' | 'mainnet';
  private readonly wif: string;
  private readonly apiBase: string;
  private readonly explorerBase: string;

  constructor(
    private prisma: PrismaService,
    private cfg: ConfigService,
  ) {
    this.network = (this.cfg.get<string>('BTC_NETWORK') ?? 'testnet') as any;
    this.wif = this.cfg.get<string>('BTC_WIF') ?? '';
    this.apiBase = this.network === 'mainnet' ? MAINNET_API : TESTNET_API;
    this.explorerBase = this.network === 'mainnet' ? MEMPOOL_MAINNET : MEMPOOL_TESTNET;

    if (!this.wif) {
      this.logger.warn('BTC_WIF not set — Bitcoin anchoring disabled');
    } else {
      this.logger.log(`Bitcoin anchoring enabled (${this.network})`);
    }
  }

  async anchorProof(
    artifactId: string,
    proofHash: string,
    actorId: string,
  ): Promise<{ btcTxHash: string; explorerUrl: string } | null> {
    if (!this.wif) {
      this.logger.warn('Bitcoin not configured — skipping anchor');
      return null;
    }

    try {
      const bitcoin = await import('bitcoinjs-lib');
      const ecc = await import('tiny-secp256k1');
      const { ECPairFactory } = await import('ecpair');

      const ECPair = ECPairFactory(ecc);
      const btcNetwork =
        this.network === 'mainnet'
          ? bitcoin.networks.bitcoin
          : bitcoin.networks.testnet;

      const opReturnData = Buffer.from(`BHDAO:v1:${proofHash}`, 'utf8');
      if (opReturnData.length > 80) {
        this.logger.error('OP_RETURN data exceeds 80 bytes');
        return null;
      }

      const keyPair = ECPair.fromWIF(this.wif, btcNetwork);
      const { address } = bitcoin.payments.p2pkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network: btcNetwork,
      });

      if (!address) {
        this.logger.error('Could not derive BTC address');
        return null;
      }

      this.logger.log(`BTC anchor wallet: ${address}`);

      // Fetch UTXOs
      const utxosRes = await fetch(`${this.apiBase}/address/${address}/utxo`);
      if (!utxosRes.ok) {
        this.logger.error(`Failed to fetch UTXOs: ${utxosRes.status}`);
        return null;
      }

      const utxos: any[] = await utxosRes.json();
      if (utxos.length === 0) {
        this.logger.error('No UTXOs — fund the BTC wallet');
        return null;
      }

      const utxo = utxos.sort((a: any, b: any) => b.value - a.value)[0];

      // Fetch raw tx
      const rawTxRes = await fetch(`${this.apiBase}/tx/${utxo.txid}/hex`);
      if (!rawTxRes.ok) {
        this.logger.error(`Failed to fetch raw tx: ${rawTxRes.status}`);
        return null;
      }
      const rawTxHex = await rawTxRes.text();

      const fee = 1000n; // bigint
      const changeAmount = BigInt(utxo.value) - fee;
      if (changeAmount < 546n) {
        this.logger.error(`Insufficient funds: ${utxo.value} sats`);
        return null;
      }

      const psbt = new bitcoin.Psbt({ network: btcNetwork });

      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(rawTxHex, 'hex'),
      });

      const opReturnScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_RETURN,
        opReturnData,
      ]);

      psbt.addOutput({ script: opReturnScript, value: 0n });
      psbt.addOutput({ address, value: changeAmount });

      psbt.signInput(0, keyPair);
      psbt.finalizeAllInputs();

      const txHex = psbt.extractTransaction().toHex();

      // Broadcast
      const broadcastRes = await fetch(`${this.apiBase}/tx`, {
        method: 'POST',
        body: txHex,
      });

      if (!broadcastRes.ok) {
        const err = await broadcastRes.text();
        this.logger.error(`Broadcast failed: ${err}`);
        return null;
      }

      const confirmedTxId = await broadcastRes.text();
      const explorerUrl = `${this.explorerBase}/tx/${confirmedTxId}`;

      // Store on artifact
      await this.prisma.artifact.update({
        where: { id: artifactId },
        data: { btcTxHash: confirmedTxId },
      });

      // Emit audit event
      await this.prisma.artifactEvent.create({
        data: {
          artifactId,
          actorId,
          type: 'BTC_ANCHORED',
          payload: { btcTxHash: confirmedTxId, proofHash, network: this.network, explorerUrl },
        },
      });

      this.logger.log(`BTC anchored: ${confirmedTxId}`);
      return { btcTxHash: confirmedTxId, explorerUrl };
    } catch (e: any) {
      this.logger.error(`BTC anchor failed: ${e?.message ?? e}`);
      return null;
    }
  }
}