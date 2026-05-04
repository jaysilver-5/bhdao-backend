import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import OpenAI from 'openai';

export interface ArtifactEnrichment {
  tags: string[];
  summary: string;
  timePeriod: string | null;
  region: string | null;
  entities: {
    people: string[];
    places: string[];
    events: string[];
    organizations: string[];
  };
  historicalSignificance: 'low' | 'medium' | 'high' | 'critical';
  suggestedCategory: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: OpenAI | null = null;
  private readonly model: string;

  constructor(
    private prisma: PrismaService,
    private cfg: ConfigService,
  ) {
    const apiKey = this.cfg.get<string>('OPENAI_API_KEY');
    this.model = this.cfg.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';

    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY not set — AI enrichment disabled');
    } else {
      this.client = new OpenAI({ apiKey });
      this.logger.log(`AI enrichment enabled (model: ${this.model})`);
    }
  }

  async enrichArtifact(artifactId: string): Promise<ArtifactEnrichment | null> {
    if (!this.client) {
      this.logger.warn('OpenAI not configured — skipping enrichment');
      return null;
    }

    const artifact = await this.prisma.artifact.findUnique({
      where: { id: artifactId },
    });

    if (!artifact) {
      this.logger.error(`Artifact ${artifactId} not found`);
      return null;
    }

    const prompt = `You are an expert archivist specializing in Black history and African diaspora history. Analyze the following artifact submission and provide structured enrichment data.

ARTIFACT:
Title: ${artifact.title}
Description: ${artifact.description}
Type: ${artifact.type}
Source URL: ${artifact.sourceUrl ?? 'Not provided'}
Language: ${artifact.language}
Existing tags: ${artifact.tags.length > 0 ? artifact.tags.join(', ') : 'None'}

Respond with ONLY valid JSON (no markdown, no backticks, no explanation) in this exact format:
{
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "summary": "A 2-3 sentence summary of this artifact's historical significance",
  "timePeriod": "e.g. 1960s, 1863, Pre-colonial, or null if unclear",
  "region": "e.g. United States - Alabama, West Africa - Ghana, Caribbean, or null if unclear",
  "entities": {
    "people": ["Named individuals mentioned or depicted"],
    "places": ["Specific locations"],
    "events": ["Historical events referenced"],
    "organizations": ["Organizations, institutions, movements"]
  },
  "historicalSignificance": "low|medium|high|critical",
  "suggestedCategory": "One of: civil-rights, slavery-era, reconstruction, harlem-renaissance, black-arts, african-kingdoms, diaspora, activism, education, religion, music, literature, science, politics, military, sports, other"
}

Guidelines:
- Tags should be specific and useful for search (5-10 tags)
- Summary should explain WHY this matters to Black history
- Be accurate — if something is unclear, use null
- Historical significance: critical = foundational events/figures, high = significant historical value, medium = notable, low = general interest`;

    try {
      this.logger.log(`Enriching artifact ${artifactId}...`);

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        this.logger.error('Empty response from OpenAI');
        return null;
      }

      // Parse JSON (strip markdown fences if present)
      const cleaned = content.replace(/```json\n?|```\n?/g, '').trim();
      const enrichment: ArtifactEnrichment = JSON.parse(cleaned);

      // Merge AI tags with existing tags (dedupe)
      const allTags = [...new Set([...artifact.tags, ...enrichment.tags])];

      // Update artifact with enrichment
      await this.prisma.artifact.update({
        where: { id: artifactId },
        data: {
          tags: allTags,
        },
      });

      // Store full enrichment as an audit event
      await this.prisma.artifactEvent.create({
        data: {
          artifactId,
          actorId: artifact.submittedById, // attributed to submitter
          type: 'AI_ENRICHED',
          payload: enrichment as any,
        },
      });

      this.logger.log(`Enriched ${artifactId}: ${allTags.length} tags, significance=${enrichment.historicalSignificance}`);

      return enrichment;
    } catch (e: any) {
      this.logger.error(`AI enrichment failed for ${artifactId}: ${e?.message ?? e}`);
      return null;
    }
  }

  // ─── Batch enrich (for seeding) ───

  async enrichAll(status?: string) {
    const where = status ? { status: status as any } : {};
    const artifacts = await this.prisma.artifact.findMany({
      where,
      select: { id: true },
    });

    this.logger.log(`Batch enriching ${artifacts.length} artifacts...`);

    const results: { id: string; enriched: boolean }[] = [];
    for (const artifact of artifacts) {
      const enrichment = await this.enrichArtifact(artifact.id);
      results.push({ id: artifact.id, enriched: !!enrichment });
      // Rate limit: wait 500ms between calls
      await new Promise((r) => setTimeout(r, 500));
    }

    return results;
  }
}