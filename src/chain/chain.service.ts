import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { createHash } from 'crypto';

@Injectable()
export class ChainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChainService.name);
  private api: ApiPromise | null = null;
  private signer: any = null;
  private contract: any = null; // ContractPromise when Level 2 is active

  private readonly rpcUrl: string;
  private readonly seed: string;
  private readonly contractAddress: string;
  private readonly contractAbi: any;
  private useContract = false;

  constructor(
    private prisma: PrismaService,
    private cfg: ConfigService,
  ) {
    this.rpcUrl = this.cfg.get<string>('POLKADOT_RPC') ?? 'wss://rpc.ibp.network/paseo';
    this.seed = this.cfg.get<string>('ANCHOR_SEED') ?? '//Alice';
    this.contractAddress = this.cfg.get<string>('INK_CONTRACT_ADDRESS') ?? '';
  }

  async onModuleInit() {
    try {
      const provider = new WsProvider(this.rpcUrl);
      this.api = await ApiPromise.create({ provider });

      const keyring = new Keyring({ type: 'sr25519' });
      this.signer = keyring.addFromUri(this.seed);

      this.logger.log(`Connected to ${this.rpcUrl}`);
      this.logger.log(`Anchor wallet: ${this.signer.address}`);

      // If contract address is configured, try to load contract
      if (this.contractAddress) {
        try {
          const { ContractPromise } = await import('@polkadot/api-contract');
          const fs = await import('fs');
          const path = await import('path');

          const abiPath = path.join(process.cwd(), 'contracts', 'bhdao_registry.json');
          if (fs.existsSync(abiPath)) {
            const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            this.contract = new ContractPromise(this.api as any, abi, this.contractAddress);
            this.useContract = true;
            this.logger.log(`Level 2: ink! contract loaded at ${this.contractAddress}`);
          } else {
            this.logger.warn(`Contract ABI not found at ${abiPath} — using Level 1 (remark)`);
          }
        } catch (e) {
          this.logger.warn(`Could not load ink! contract — using Level 1 (remark): ${e}`);
        }
      } else {
        this.logger.log('No INK_CONTRACT_ADDRESS set — using Level 1 (system.remark)');
      }
    } catch (e) {
      this.logger.error(`Polkadot connection failed: ${e}`);
    }
  }

  async onModuleDestroy() {
    if (this.api) await this.api.disconnect();
  }

  // ─── Build proof hash ───

  buildProofPayload(artifact: {
    id: string;
    title: string;
    cid?: string | null;
    submittedById: string;
    submittedByWallet: string;
    expertId: string;
    expertWallet: string;
    verifiedAt: string;
  }) {
    const canonical = JSON.stringify({
      artifactId: artifact.id,
      title: artifact.title,
      cid: artifact.cid || null,
      submittedBy: artifact.submittedByWallet,
      verifiedAt: artifact.verifiedAt,
      expertWallet: artifact.expertWallet,
    });
    const hash = createHash('sha256').update(canonical).digest('hex');
    return { canonical, hash };
  }

  // ─── Anchor proof (auto-selects Level 1 or Level 2) ───

  async anchorProof(
    artifactId: string,
    expertId: string,
  ): Promise<{ txHash: string; blockNumber: number } | null> {
    if (!this.api || !this.signer) {
      this.logger.warn('Chain not connected — skipping anchor');
      return null;
    }

    const artifact = await this.prisma.artifact.findUnique({
      where: { id: artifactId },
      include: { submittedBy: { select: { id: true, wallet: true } } },
    });
    if (!artifact) return null;

    const expert = await this.prisma.user.findUnique({ where: { id: expertId } });
    if (!expert) return null;

    const now = new Date().toISOString();
    const { canonical, hash } = this.buildProofPayload({
      id: artifact.id,
      title: artifact.title,
      cid: artifact.cid,
      submittedById: artifact.submittedBy.id,
      submittedByWallet: artifact.submittedBy.wallet,
      expertId: expert.id,
      expertWallet: expert.wallet,
      verifiedAt: now,
    });

    this.logger.log(`Anchoring ${artifactId} (${this.useContract ? 'Level 2: contract' : 'Level 1: remark'})`);

    try {
      let result: { txHash: string; blockNumber: number };

      if (this.useContract && this.contract) {
        result = await this.anchorViaContract(artifactId, artifact, expert, hash);
      } else {
        result = await this.anchorViaRemark(hash);
      }

      // Update artifact
      await this.prisma.artifact.update({
        where: { id: artifactId },
        data: {
          chainTxHash: result.txHash,
          chainBlock: result.blockNumber,
          anchoredAt: new Date(now),
        },
      });

      // Emit event
      await this.prisma.artifactEvent.create({
        data: {
          artifactId,
          actorId: expertId,
          type: 'ANCHORED',
          payload: {
            txHash: result.txHash,
            blockNumber: result.blockNumber,
            proofHash: hash,
            canonical,
            network: 'paseo',
            level: this.useContract ? 2 : 1,
          },
        },
      });

      this.logger.log(`Anchored: tx=${result.txHash} block=${result.blockNumber}`);
      return result;
    } catch (e: any) {
      this.logger.error(`Anchor failed: ${e?.message ?? e}`);
      return null;
    }
  }

  // ─── Level 1: system.remark ───

  private async anchorViaRemark(hash: string): Promise<{ txHash: string; blockNumber: number }> {
    const remark = `BHDAO:v1:${hash}`;

    return new Promise((resolve, reject) => {
      this.api!.tx.system
        .remark(remark)
        .signAndSend(this.signer, ({ status, txHash }) => {
          if (status.isInBlock) {
            this.api!.rpc.chain
              .getHeader(status.asInBlock as any)
              .then((header) => {
                resolve({
                  txHash: txHash.toString(),
                  blockNumber: header.number.toNumber(),
                });
              })
              .catch(reject);
          } else if (status.isDropped || status.isInvalid) {
            reject(new Error(`Transaction failed: ${status.type}`));
          }
        })
        .catch(reject);
    });
  }

  // ─── Level 2: ink! contract call ───

  private async anchorViaContract(
    artifactId: string,
    artifact: any,
    expert: any,
    proofHash: string,
  ): Promise<{ txHash: string; blockNumber: number }> {
    // Convert artifact UUID to bytes32 hash
    const artifactHash = Array.from(
      Buffer.from(createHash('sha256').update(artifactId).digest('hex').slice(0, 64), 'hex'),
    );

    const metadataHash = Array.from(
      Buffer.from(proofHash.slice(0, 64), 'hex'),
    );

    // Dry run to estimate gas
    const { gasRequired } = await this.contract.query.registerArtifact(
      this.signer.address,
      { gasLimit: this.api!.registry.createType('WeightV2', { refTime: 100_000_000_000, proofSize: 1_000_000 }) as any },
      artifactHash,
      artifact.cid ?? '',
      artifact.submittedBy.wallet,
      expert.wallet,
      metadataHash,
    );

    // Execute with estimated gas + buffer
    return new Promise((resolve, reject) => {
      this.contract.tx
        .registerArtifact(
          { gasLimit: gasRequired as any },
          artifactHash,
          artifact.cid ?? '',
          artifact.submittedBy.wallet,
          expert.wallet,
          metadataHash,
        )
        .signAndSend(this.signer, ({ status, txHash }: any) => {
          if (status.isInBlock) {
            this.api!.rpc.chain
              .getHeader(status.asInBlock)
              .then((header: any) => {
                resolve({
                  txHash: txHash.toString(),
                  blockNumber: header.number.toNumber(),
                });
              })
              .catch(reject);
          } else if (status.isDropped || status.isInvalid) {
            reject(new Error(`Contract tx failed: ${status.type}`));
          }
        })
        .catch(reject);
    });
  }
}