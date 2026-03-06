import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

const ALLOWED_MIMES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'],
  video: ['video/mp4', 'video/webm', 'video/ogg'],
  document: ['application/pdf'],
  text: ['text/plain', 'text/markdown'],
};

const RESOURCE_TYPE: Record<string, string> = {
  image: 'image',
  audio: 'video',
  video: 'video',
  document: 'raw',
  text: 'raw',
};

const MAX_SIZE = 50 * 1024 * 1024;

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private configured = false;

  constructor(private cfg: ConfigService) {}

  // Configure lazily — ensures env vars are available
  private ensureConfig() {
    if (this.configured) return;

    const cloud_name = this.cfg.get<string>('CLOUDINARY_CLOUD_NAME') || process.env.CLOUDINARY_CLOUD_NAME;
    const api_key = this.cfg.get<string>('CLOUDINARY_API_KEY') || process.env.CLOUDINARY_API_KEY;
    const api_secret = this.cfg.get<string>('CLOUDINARY_API_SECRET') || process.env.CLOUDINARY_API_SECRET;

    this.logger.log(`Cloudinary config — cloud: ${cloud_name ? '✓' : '✗'}, key: ${api_key ? '✓' : '✗'}, secret: ${api_secret ? '✓' : '✗'}`);

    if (!cloud_name || !api_key || !api_secret) {
      throw new BadRequestException('Cloudinary not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.');
    }

    cloudinary.config({ cloud_name, api_key, api_secret });
    this.configured = true;
  }

  validateFile(
    file: { mimetype: string; size: number; originalname: string },
    artifactType: string,
  ) {
    if (file.size > MAX_SIZE) {
      throw new BadRequestException(`File too large. Max ${MAX_SIZE / 1024 / 1024}MB.`);
    }

    const allowed = ALLOWED_MIMES[artifactType];
    if (allowed && !allowed.includes(file.mimetype)) {
      throw new BadRequestException(
        `Invalid file type "${file.mimetype}" for artifact type "${artifactType}". Allowed: ${allowed.join(', ')}`,
      );
    }
  }

  async upload(
    buffer: Buffer,
    artifactId: string,
    artifactType: string,
  ): Promise<{ url: string; publicId: string }> {
    this.ensureConfig();

    const resourceType = RESOURCE_TYPE[artifactType] ?? 'raw';

    const result: UploadApiResponse = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'bhdao/staging',
          public_id: artifactId,
          resource_type: resourceType as any,
          overwrite: true,
        },
        (err, res) => {
          if (err || !res) return reject(err ?? new Error('Upload failed'));
          resolve(res);
        },
      );
      stream.end(buffer);
    });

    return {
      url: result.secure_url,
      publicId: result.public_id,
    };
  }

  async remove(publicId: string, artifactType: string): Promise<void> {
    this.ensureConfig();

    const resourceType = RESOURCE_TYPE[artifactType] ?? 'raw';
    await cloudinary.uploader
      .destroy(publicId, { resource_type: resourceType as any })
      .catch(() => null);
  }
}