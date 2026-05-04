import { Module } from '@nestjs/common';
import { ChainController } from './chain.controller';
import { ChainService } from './chain.service';
import { BitcoinService } from './bitcoin.service';

@Module({
  controllers: [ChainController],
  providers: [ChainService, BitcoinService],
  exports: [ChainService, BitcoinService],
})
export class ChainModule {}