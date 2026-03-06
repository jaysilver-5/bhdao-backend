import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ArtifactsService } from './artifacts.service';
import { UploadService } from './upload.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtOptionalGuard } from '../auth/jwt-optional.guard';
import {
  CreateArtifactSchema,
  UpdateArtifactSchema,
  PaginationSchema,
} from './dto';
import { ZodError } from 'zod';

function formatZodError(err: ZodError): string {
  return err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
}

@Controller('artifacts')
export class ArtifactsController {
  constructor(
    private readonly artifacts: ArtifactsService,
    private readonly uploads: UploadService,
  ) {}

  // ─── Submit artifact ───
  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Body() body: any, @Req() req: Request) {
    try {
      var dto = CreateArtifactSchema.parse(body);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(formatZodError(e));
      throw e;
    }
    const user = (req as any).user;
    return this.artifacts.create(dto, user.userId);
  }

  // ─── List artifacts ───
  @UseGuards(JwtOptionalGuard)
  @Get()
  async findAll(@Query() query: any, @Req() req: Request) {
    let pagination;
    try {
      pagination = PaginationSchema.parse(query);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(formatZodError(e));
      throw e;
    }

    const user = (req as any).user;
    const mine = query.mine === 'true';
    const status = query.status;

    if (status && user) {
      if (user.role !== 'EXPERT' && user.role !== 'ADMIN') {
        throw new BadRequestException('Status filter requires EXPERT or ADMIN role');
      }
      return this.artifacts.findAllByStatus(status, pagination);
    }

    return this.artifacts.findAll(pagination, user?.userId, mine);
  }

  // ─── Search artifacts ───
  @UseGuards(JwtOptionalGuard)
  @Get('search')
  async search(@Query() query: any, @Req() req: Request) {
    const q = query.q;
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      throw new BadRequestException('Search query "q" must be at least 2 characters');
    }

    let pagination;
    try {
      pagination = PaginationSchema.parse(query);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(formatZodError(e));
      throw e;
    }

    const user = (req as any).user;
    return this.artifacts.search(q.trim(), pagination, user?.role);
  }

  // ─── Community review feed (public — what's open for voting) ───
  @Get('review')
  async communityReview(@Query() query: any) {
    let pagination;
    try {
      pagination = PaginationSchema.parse(query);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(formatZodError(e));
      throw e;
    }
    return this.artifacts.findCommunityReview(pagination);
  }

  // ─── Get artifact by ID ───
  @UseGuards(JwtOptionalGuard)
  @Get(':id')
  async findById(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    return this.artifacts.findById(id, user?.userId, user?.role);
  }

  // ─── Update artifact ───
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    try {
      var dto = UpdateArtifactSchema.parse(body);
    } catch (e: any) {
      if (e instanceof ZodError) throw new BadRequestException(formatZodError(e));
      throw e;
    }
    const user = (req as any).user;
    return this.artifacts.update(id, dto, user.userId);
  }

  // ─── Withdraw artifact ───
  @UseGuards(JwtAuthGuard)
  @Post(':id/withdraw')
  async withdraw(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    return this.artifacts.withdraw(id, user.userId, user.role);
  }

  // ─── Upload file to Cloudinary staging ───
  // Accepts JSON: { filename: string, data: string (base64), mimetype: string }
  @UseGuards(JwtAuthGuard)
  @Post(':id/upload')
  async uploadFile(@Param('id') id: string, @Body() body: any, @Req() req: Request) {
    const user = (req as any).user;
    const artifact = await this.artifacts.findById(id, user.userId, user.role);

    if (artifact.submittedById !== user.userId) {
      throw new BadRequestException('Only the submitter can upload files');
    }

    if (artifact.status !== 'COMMUNITY_REVIEW' && artifact.status !== 'PENDING') {
      throw new BadRequestException('Can only upload files during review');
    }

    if (!body?.filename || !body?.data || !body?.mimetype) {
      throw new BadRequestException(
        'Send JSON with fields: filename (string), data (base64 string), mimetype (string)',
      );
    }

    const buffer = Buffer.from(body.data, 'base64');

    this.uploads.validateFile(
      { mimetype: body.mimetype, size: buffer.length, originalname: body.filename },
      artifact.type,
    );

    const { url, publicId } = await this.uploads.upload(buffer, artifact.id, artifact.type);
    const updated = await this.artifacts.setFileInfo(artifact.id, url, publicId, user.userId);

    return { ok: true, fileUrl: url, artifact: updated };
  }

  // ─── Activity log ───
  @UseGuards(JwtOptionalGuard)
  @Get(':id/activity')
  async getActivity(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    return this.artifacts.getActivity(id, user?.userId, user?.role);
  }
}
