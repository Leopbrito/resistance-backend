import { Module } from '@nestjs/common';
import { GatewayModule } from './gateway/gateway.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [RedisModule, GatewayModule],
})
export class AppModule {}
