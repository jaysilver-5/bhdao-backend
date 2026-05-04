import {
  Controller, Get, Post, Param, Req, UseGuards,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ChainService } from './chain.service';
import { BitcoinService } from './bitcoin.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('chain')
export class ChainController {
  constructor(
    private readonly chain: ChainService,
    private readonly bitcoin: BitcoinService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Anchor to Polkadot ───
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('EXPERT' as any, 'ADMIN' as any)
  @Post('artifacts/:id/anchor')
  async anchor(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    const artifact = await this.prisma.artifact.findUnique({ where: { id } });
    if (!artifact) throw new NotFoundException('Artifact not found');
    if (artifact.status !== 'VERIFIED') throw new BadRequestException('Only VERIFIED artifacts can be anchored');
    if (artifact.chainTxHash) throw new BadRequestException('Already anchored on Polkadot');

    const result = await this.chain.anchorProof(id, user.userId);
    if (!result) throw new BadRequestException('Polkadot anchoring failed');

    return {
      ok: true, chain: 'polkadot', txHash: result.txHash,
      blockNumber: result.blockNumber,
      explorerUrl: `https://paseo.subscan.io/extrinsic/${result.txHash}`,
    };
  }

  // ─── Anchor to Bitcoin ───
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('EXPERT' as any, 'ADMIN' as any)
  @Post('artifacts/:id/anchor-btc')
  async anchorBtc(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    const artifact = await this.prisma.artifact.findUnique({
      where: { id },
      include: {
        submittedBy: { select: { wallet: true } },
        expertReviews: {
          where: { decision: 'APPROVE' },
          include: { expert: { select: { wallet: true } } },
          take: 1,
        },
      },
    });
    if (!artifact) throw new NotFoundException('Artifact not found');
    if (artifact.status !== 'VERIFIED') throw new BadRequestException('Only VERIFIED artifacts can be anchored');
    if (artifact.btcTxHash) throw new BadRequestException('Already anchored on Bitcoin');

    const { hash } = this.chain.buildProofPayload({
      id: artifact.id, title: artifact.title, cid: artifact.cid,
      submittedById: artifact.submittedBy?.wallet ?? '',
      submittedByWallet: artifact.submittedBy?.wallet ?? '',
      expertId: artifact.expertReviews[0]?.expert?.wallet ?? '',
      expertWallet: artifact.expertReviews[0]?.expert?.wallet ?? '',
      verifiedAt: artifact.anchoredAt?.toISOString() ?? new Date().toISOString(),
    });

    const result = await this.bitcoin.anchorProof(id, hash, user.userId);
    if (!result) throw new BadRequestException('Bitcoin anchoring failed — check wallet balance');

    return { ok: true, chain: 'bitcoin', btcTxHash: result.btcTxHash, explorerUrl: result.explorerUrl };
  }

  // ─── Dual-chain proof (Public) ───
  @Get('artifacts/:id/proof')
  async getProof(@Param('id') id: string) {
    const artifact = await this.prisma.artifact.findUnique({
      where: { id },
      include: {
        submittedBy: { select: { wallet: true } },
        expertReviews: {
          where: { decision: 'APPROVE' },
          include: { expert: { select: { wallet: true } } },
          take: 1,
        },
      },
    });
    if (!artifact) throw new NotFoundException('Artifact not found');

    const hasPolkadot = !!artifact.chainTxHash;
    const hasBitcoin = !!artifact.btcTxHash;

    if (!hasPolkadot && !hasBitcoin) {
      return { anchored: false, artifactId: id, status: artifact.status };
    }

    return {
      anchored: true,
      artifactId: id,
      artifact: {
        title: artifact.title, cid: artifact.cid,
        submittedBy: artifact.submittedBy.wallet,
        expertWallet: artifact.expertReviews[0]?.expert?.wallet ?? null,
      },
      polkadot: hasPolkadot ? {
        network: 'paseo', txHash: artifact.chainTxHash,
        blockNumber: artifact.chainBlock, anchoredAt: artifact.anchoredAt,
        explorerUrl: `https://paseo.subscan.io/extrinsic/${artifact.chainTxHash}`,
      } : null,
      bitcoin: hasBitcoin ? {
        txHash: artifact.btcTxHash,
        explorerUrl: `https://mempool.space/testnet/tx/${artifact.btcTxHash}`,
      } : null,
    };
  }
}