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
  @UseGuards(JwtAuthGuard)
  @Post(':id/upload')
  async uploadFile(@Param('id') id: string, @Req() req: Request) {
    const user = (req as any).user;
    const artifact = await this.artifacts.findById(id, user.userId, user.role);

    if (artifact.submittedById !== user.userId) {
      throw new BadRequestException('Only the submitter can upload files');
    }

    if (artifact.status !== 'COMMUNITY_REVIEW' && artifact.status !== 'PENDING') {
      throw new BadRequestException('Can only upload files during review');
    }

    // Parse multipart
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks);

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      throw new BadRequestException('Expected multipart/form-data');
    }

    const parts = parseMultipart(rawBody, boundaryMatch[1]);
    const filePart = parts.find((p) => p.name === 'file');

    if (!filePart || !filePart.data.length) {
      throw new BadRequestException('No file provided. Send a "file" field.');
    }

    this.uploads.validateFile(
      { mimetype: filePart.contentType, size: filePart.data.length, originalname: filePart.filename },
      artifact.type,
    );

    const { url, publicId } = await this.uploads.upload(filePart.data, artifact.id, artifact.type);
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

// ─── Minimal multipart parser ───

interface MultipartPart {
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const sepStr = `--${boundary}`;
  const bodyStr = body.toString('binary');

  const segments = bodyStr.split(sepStr).slice(1);

  for (const segment of segments) {
    if (segment.startsWith('--')) break;

    const headerEnd = segment.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerSection = segment.slice(0, headerEnd);
    const dataSection = segment.slice(headerEnd + 4).replace(/\r\n$/, '');

    const nameMatch = headerSection.match(/name="([^"]+)"/);
    const filenameMatch = headerSection.match(/filename="([^"]+)"/);
    const typeMatch = headerSection.match(/Content-Type:\s*(.+)/i);

    if (nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch?.[1] ?? '',
        contentType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
        data: Buffer.from(dataSection, 'binary'),
      });
    }
  }

  return parts;
}
