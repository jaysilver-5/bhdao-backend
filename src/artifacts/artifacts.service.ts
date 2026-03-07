import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateArtifactDto, UpdateArtifactDto, PaginationDto } from './dto';

const REVIEW_WINDOW_DAYS = 7;

@Injectable()
export class ArtifactsService {
  constructor(private prisma: PrismaService) {}

  // ─── Create ───

  async create(dto: CreateArtifactDto, userId: string) {
    const reviewEndsAt = new Date();
    reviewEndsAt.setDate(reviewEndsAt.getDate() + REVIEW_WINDOW_DAYS);

    const artifact = await this.prisma.artifact.create({
      data: {
        title: dto.title,
        description: dto.description,
        type: dto.type,
        sourceUrl: dto.sourceUrl,
        language: dto.language,
        license: dto.license,
        tags: dto.tags,
        status: 'COMMUNITY_REVIEW',
        reviewEndsAt,
        submittedById: userId,
      },
    });

    await this.emitEvent(artifact.id, userId, 'SUBMITTED', {
      title: artifact.title,
      type: artifact.type,
    });

    return artifact;
  }

  // ─── List (public = VERIFIED only, mine = own submissions) ───

  async findAll(pagination: PaginationDto, callerId?: string, mine?: boolean) {
    const { page, limit } = pagination;
    const skip = (page - 1) * limit;

    // Own submissions
    if (mine) {
      if (!callerId) {
        return { items: [], total: 0, page, limit };
      }
      const [items, total] = await Promise.all([
        this.prisma.artifact.findMany({
          where: { submittedById: callerId },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          include: {
            submittedBy: { select: { id: true, wallet: true } },
          },
        }),
        this.prisma.artifact.count({ where: { submittedById: callerId } }),
      ]);
      return { items, total, page, limit };
    }

    // Public: VERIFIED only
    const [items, total] = await Promise.all([
      this.prisma.artifact.findMany({
        where: { status: 'VERIFIED' },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          submittedBy: { select: { id: true, wallet: true } },
        },
      }),
      this.prisma.artifact.count({ where: { status: 'VERIFIED' } }),
    ]);
    return { items, total, page, limit };
  }

  // ─── List all artifacts (admin/expert — for dashboard/debug) ───

  // ─── Community review feed (public — shows what's open for voting) ───

  async findCommunityReview(pagination: PaginationDto) {
    const { page, limit } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.artifact.findMany({
        where: {
          status: 'COMMUNITY_REVIEW',
          reviewEndsAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          submittedBy: { select: { id: true, wallet: true } },
          _count: { select: { votes: true, comments: true, flags: true } },
        },
      }),
      this.prisma.artifact.count({
        where: {
          status: 'COMMUNITY_REVIEW',
          reviewEndsAt: { gt: new Date() },
        },
      }),
    ]);
    return { items, total, page, limit };
  }

  // ─── List all artifacts by status (admin/expert) ───

  async findAllByStatus(status: string, pagination: PaginationDto) {
    const { page, limit } = pagination;
    const skip = (page - 1) * limit;

    const where = status === 'ALL' ? {} : { status: status as any };

    const [items, total] = await Promise.all([
      this.prisma.artifact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          submittedBy: { select: { id: true, wallet: true } },
        },
      }),
      this.prisma.artifact.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  // ─── Find by ID (policy-based visibility) ───

  async findById(id: string, callerId?: string, callerRole?: string) {
    const artifact = await this.prisma.artifact.findUnique({
      where: { id },
      include: {
        submittedBy: { select: { id: true, wallet: true } },
      },
    });

    if (!artifact) throw new NotFoundException('Artifact not found');

    // Public statuses — anyone can view
    if (artifact.status === 'VERIFIED' || artifact.status === 'COMMUNITY_REVIEW') {
      return artifact;
    }

    // All other statuses: must be submitter, expert, or admin
    if (!callerId) throw new NotFoundException('Artifact not found');

    const isOwner = artifact.submittedById === callerId;
    const isPrivileged = callerRole === 'EXPERT' || callerRole === 'ADMIN';

    if (!isOwner && !isPrivileged) {
      throw new NotFoundException('Artifact not found');
    }

    return artifact;
  }

  // ─── Update (submitter only, during COMMUNITY_REVIEW, before deadline) ───

  async update(id: string, dto: UpdateArtifactDto, callerId: string) {
    const artifact = await this.prisma.artifact.findUnique({ where: { id } });

    if (!artifact) throw new NotFoundException('Artifact not found');
    if (artifact.submittedById !== callerId) {
      throw new ForbiddenException('Only the submitter can edit');
    }
    if (artifact.status !== 'COMMUNITY_REVIEW') {
      throw new BadRequestException('Artifact can only be edited during community review');
    }
    if (artifact.reviewEndsAt && artifact.reviewEndsAt.getTime() < Date.now()) {
      throw new BadRequestException('Review window has closed');
    }

    const updated = await this.prisma.artifact.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.sourceUrl !== undefined && { sourceUrl: dto.sourceUrl }),
        ...(dto.language !== undefined && { language: dto.language }),
        ...(dto.license !== undefined && { license: dto.license }),
        ...(dto.tags !== undefined && { tags: dto.tags }),
      },
    });

    await this.emitEvent(id, callerId, 'UPDATED', { fields: Object.keys(dto) });

    return updated;
  }

  // ─── Withdraw ───

  async withdraw(id: string, callerId: string, callerRole: string) {
    const artifact = await this.prisma.artifact.findUnique({ where: { id } });

    if (!artifact) throw new NotFoundException('Artifact not found');

    const isOwner = artifact.submittedById === callerId;
    const isAdmin = callerRole === 'ADMIN';

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Only the submitter or an admin can withdraw');
    }

    const nonWithdrawable = ['VERIFIED', 'REJECTED', 'WITHDRAWN'];
    if (nonWithdrawable.includes(artifact.status)) {
      throw new BadRequestException(
        `Cannot withdraw artifact with status ${artifact.status}`,
      );
    }

    const updated = await this.prisma.artifact.update({
      where: { id },
      data: { status: 'WITHDRAWN' },
    });

    await this.emitEvent(id, callerId, 'WITHDRAWN', {
      previousStatus: artifact.status,
    });

    return updated;
  }

  // ─── Activity log ───

  async getActivity(id: string, callerId?: string, callerRole?: string) {
    // First verify the caller can see this artifact
    await this.findById(id, callerId, callerRole);

    return this.prisma.artifactEvent.findMany({
      where: { artifactId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── Set file info after upload ───

  async setFileInfo(id: string, fileUrl: string, fileId: string, actorId: string) {
    const updated = await this.prisma.artifact.update({
      where: { id },
      data: { fileUrl, fileId },
    });

    await this.emitEvent(id, actorId, 'FILE_UPLOADED', { fileUrl, fileId });

    return updated;
  }

  // ─── Audit event helper ───

  private async emitEvent(
    artifactId: string,
    actorId: string,
    type: string,
    payload?: any,
  ) {
    return this.prisma.artifactEvent.create({
      data: {
        artifactId,
        actorId,
        type,
        payload: payload ?? undefined,
      },
    });
  }
}