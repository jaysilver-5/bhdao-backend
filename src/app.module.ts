import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { VotesModule } from './votes/votes.module';
import { CronModule } from './cron/cron.module';
import { ExpertModule } from './expert/expert.module';
import { FlagsModule } from './flags/flags.module';
import { CommentsModule } from './comments/comments.module';
import { ChainModule } from './chain/chain.module';
import { IpfsModule } from './ipfs/ipfs.module';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    UsersModule,
    AuthModule,
    AiModule,
    ArtifactsModule,
    VotesModule,
    CronModule,
    ExpertModule,
    FlagsModule,
    CommentsModule,
    ChainModule,
    IpfsModule,
    AdminModule,
  ],
})
export class AppModule {}