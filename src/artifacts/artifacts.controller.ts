import {
  Controller, Get, Post, Patch, Param, Body, Query,
  Req, UseGuards, BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ArtifactsService } from './artifacts.service';
import { AiService, ArtifactEnrichment } from '../ai/ai.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtOptionalGuard } from '../auth/jwt-optional.guard';
import { CreateArtifactSchema, UpdateArtifactSchema, PaginationSchema } from './dto';
import { ZodError } from 'zod';

function fmtZod(err: ZodError): string {
  return err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
}

@Controller('artifacts')
export class ArtifactsController {
  constructor(
    private readonly artifacts: ArtifactsService,
    private readonly ai: AiService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Body() body: any, @Req() req: Request) {
    try {
      var dto = CreateArtifactSchema.parse(body);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(fmtZod(e));
      throw e;
    }

    const artifact = await this.artifacts.create(dto, (req as any).user.userId);

    // Auto-enrich with AI (non-blocking — don't fail submission if AI fails)
    let enrichment: ArtifactEnrichment | null = null;
    try {
      enrichment = await this.ai.enrichArtifact(artifact.id);
    } catch (e: any) {
      // Silently fail — enrichment is optional
    }

    // Return artifact with fresh data (tags may have been updated by AI)
    const updated = await this.artifacts.findById(artifact.id, (req as any).user.userId, (req as any).user.role);

    return { ...updated, aiEnrichment: enrichment };
  }

  @UseGuards(JwtOptionalGuard)
  @Get()
  async findAll(@Query() query: any, @Req() req: Request) {
    try {
      var pagination = PaginationSchema.parse(query);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(fmtZod(e));
      throw e;
    }
    const user = (req as any).user;
    if (query.status && user) {
      if (user.role !== 'EXPERT' && user.role !== 'ADMIN') {
        throw new BadRequestException('Status filter requires EXPERT or ADMIN role');
      }
      return this.artifacts.findAllByStatus(query.status, pagination);
    }
    return this.artifacts.findAll(pagination, user?.userId, query.mine === 'true');
  }

  @Get('review')
  async communityReview(@Query() query: any) {
    try {
      var pagination = PaginationSchema.parse(query);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(fmtZod(e));
      throw e;
    }
    return this.artifacts.findCommunityReview(pagination);
  }

  @UseGuards(JwtOptionalGuard)
  @Get(':id')
  async findById(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    return this.artifacts.findById(id, user?.userId, user?.role);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request) {
    try {
      var dto = UpdateArtifactSchema.parse(body);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(fmtZod(e));
      throw e;
    }
    return this.artifacts.update(id, dto, (req as any).user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/withdraw')
  async withdraw(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    return this.artifacts.withdraw(id, user.userId, user.role);
  }

  @UseGuards(JwtOptionalGuard)
  @Get(':id/activity')
  async getActivity(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    return this.artifacts.getActivity(id, user?.userId, user?.role);
  }
}