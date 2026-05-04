import {
  Controller, Post, Get, Param, Req, UseGuards,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AiService } from './ai.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Enrich a single artifact ───
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('EXPERT' as any, 'ADMIN' as any)
  @Post('artifacts/:id/enrich')
  async enrich(@Param('id') id: string) {
    const artifact = await this.prisma.artifact.findUnique({ where: { id } });
    if (!artifact) throw new NotFoundException('Artifact not found');

    const enrichment = await this.ai.enrichArtifact(id);

    return {
      ok: true,
      artifactId: id,
      enrichment,
    };
  }

  // ─── Get enrichment data for an artifact ───
  @Get('artifacts/:id/enrichment')
  async getEnrichment(@Param('id') id: string) {
    const event = await this.prisma.artifactEvent.findFirst({
      where: { artifactId: id, type: 'AI_ENRICHED' },
      orderBy: { createdAt: 'desc' },
    });

    if (!event) {
      return { enriched: false, artifactId: id };
    }

    return {
      enriched: true,
      artifactId: id,
      enrichment: event.payload,
      enrichedAt: event.createdAt,
    };
  }

  // ─── Batch enrich all artifacts (Admin only) ───
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN' as any)
  @Post('batch-enrich')
  async batchEnrich() {
    const results = await this.ai.enrichAll();
    return { ok: true, results };
  }
}