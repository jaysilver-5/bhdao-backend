import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
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
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);

  onModuleInit() {
    const cloud_name = "ddj0bvhqb";
    const api_key = "276742595942948";
    const api_secret = "ik76U9d-ioa6xUFeu6SYPoBZm98";

    this.logger.log(`Cloudinary init — cloud: ${cloud_name ?? 'MISSING'}, key: ${api_key ? '✓ set' : 'MISSING'}, secret: ${api_secret ? '✓ set' : 'MISSING'}`);

    if (cloud_name && api_key && api_secret) {
      cloudinary.config({ cloud_name, api_key, api_secret });
      this.logger.log('Cloudinary configured successfully');
    } else {
      this.logger.warn('Cloudinary NOT configured — uploads will fail');
    }
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
    const resourceType = RESOURCE_TYPE[artifactType] ?? 'raw';
    await cloudinary.uploader
      .destroy(publicId, { resource_type: resourceType as any })
      .catch(() => null);
  }
}