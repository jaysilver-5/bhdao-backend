import {
  Injectable, NotFoundException, BadRequestException,
  ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChainService } from '../chain/chain.service';
import { BitcoinService } from '../chain/bitcoin.service';
import { IpfsService } from '../ipfs/ipfs.service';
import { ExpertDecision } from '../generated/prisma/client';

@Injectable()
export class ExpertService {
  private readonly logger = new Logger(ExpertService.name);

  constructor(
    private prisma: PrismaService,
    private chain: ChainService,
    private bitcoin: BitcoinService,
    private ipfs: IpfsService,
  ) {}

  async getQueue(page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.artifact.findMany({
        where: { status: 'EXPERT_REVIEW' },
        orderBy: { createdAt: 'asc' },
        skip, take: limit,
        include: {
          submittedBy: { select: { id: true, wallet: true } },
          votes: { select: { value: true } },
          flags: { select: { reason: true } },
        },
      }),
      this.prisma.artifact.count({ where: { status: 'EXPERT_REVIEW' } }),
    ]);

    const enriched = items.map((a) => {
      const approves = a.votes.filter((v) => v.value === 'APPROVE').length;
      const { votes, ...rest } = a;
      return {
        ...rest,
        voteSummary: { approve: approves, reject: votes.length - approves, total: votes.length },
        flagCount: a.flags.length,
      };
    });
    return { items: enriched, total, page, limit };
  }

  async submitDecision(
    artifactId: string,
    expertId: string,
    decision: ExpertDecision,
    notes?: string,
    checklist?: Record<string, boolean>,
  ) {
    const artifact = await this.prisma.artifact.findUnique({ where: { id: artifactId } });
    if (!artifact) throw new NotFoundException('Artifact not found');
    if (artifact.status !== 'EXPERT_REVIEW') {
      throw new BadRequestException(`Artifact is in ${artifact.status}, not EXPERT_REVIEW`);
    }

    const existing = await this.prisma.expertReview.findUnique({
      where: { artifactId_expertId: { artifactId, expertId } },
    });
    if (existing) throw new ConflictException('You have already reviewed this artifact');

    const review = await this.prisma.expertReview.create({
      data: { artifactId, expertId, decision, notes, checklist: checklist ?? undefined },
    });

    const newStatus = decision === 'APPROVE' ? 'VERIFIED' : 'REJECTED';

    await this.prisma.artifact.update({ where: { id: artifactId }, data: { status: newStatus } });

    await this.prisma.artifactEvent.create({
      data: { artifactId, actorId: expertId, type: 'EXPERT_REVIEWED', payload: { decision, notes } },
    });
    await this.prisma.artifactEvent.create({
      data: { artifactId, actorId: expertId, type: 'STATUS_CHANGE', payload: { from: 'EXPERT_REVIEW', to: newStatus } },
    });

    // ─── Auto-pin + dual-chain anchor on VERIFIED ───

    let anchor: { txHash: string; blockNumber: number } | null = null;
    let btcAnchor: { btcTxHash: string; explorerUrl: string } | null = null;
    let pin: { cid: string; gatewayUrl: string } | null = null;

    if (newStatus === 'VERIFIED') {
      // 1. IPFS pin
      try {
        pin = await this.ipfs.pinArtifact(artifactId, expertId);
        this.logger.log(`Pinned ${artifactId}: ${pin.cid}`);
      } catch (e: any) {
        this.logger.error(`Pin failed: ${e?.message}`);
      }

      // 2. Polkadot anchor
      try {
        anchor = await this.chain.anchorProof(artifactId, expertId);
        if (anchor) this.logger.log(`Polkadot anchored ${artifactId}: ${anchor.txHash}`);
      } catch (e: any) {
        this.logger.error(`Polkadot failed: ${e?.message}`);
      }

      // 3. Bitcoin anchor
      try {
        const a = await this.prisma.artifact.findUnique({
          where: { id: artifactId },
          include: {
            submittedBy: { select: { wallet: true } },
            expertReviews: {
              where: { decision: 'APPROVE' },
              include: { expert: { select: { wallet: true } } },
              take: 1,
            },
          },
        });

        if (a) {
          const { hash } = this.chain.buildProofPayload({
            id: a.id, title: a.title, cid: a.cid,
            submittedById: a.submittedBy.wallet,
            submittedByWallet: a.submittedBy.wallet,
            expertId: a.expertReviews[0]?.expert?.wallet ?? '',
            expertWallet: a.expertReviews[0]?.expert?.wallet ?? '',
            verifiedAt: new Date().toISOString(),
          });
          btcAnchor = await this.bitcoin.anchorProof(artifactId, hash, expertId);
          if (btcAnchor) this.logger.log(`Bitcoin anchored ${artifactId}: ${btcAnchor.btcTxHash}`);
        }
      } catch (e: any) {
        this.logger.error(`Bitcoin failed: ${e?.message}`);
      }
    }

    return {
      review,
      newStatus,
      pin: pin ? { cid: pin.cid, gatewayUrl: pin.gatewayUrl } : null,
      anchor: anchor ? {
        chain: 'polkadot', txHash: anchor.txHash,
        blockNumber: anchor.blockNumber,
        explorerUrl: `https://paseo.subscan.io/extrinsic/${anchor.txHash}`,
      } : null,
      btcAnchor: btcAnchor ? {
        chain: 'bitcoin', btcTxHash: btcAnchor.btcTxHash,
        explorerUrl: btcAnchor.explorerUrl,
      } : null,
    };
  }

  async getReviews(artifactId: string) {
    const artifact = await this.prisma.artifact.findUnique({ where: { id: artifactId } });
    if (!artifact) throw new NotFoundException('Artifact not found');
    return this.prisma.expertReview.findMany({
      where: { artifactId },
      include: { expert: { select: { id: true, wallet: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}