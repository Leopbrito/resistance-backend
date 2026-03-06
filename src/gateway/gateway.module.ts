import { Module } from '@nestjs/common';
import { WebsocketGateway } from './websocket.gateway';
import { GameModule } from '../game/game.module';
import { RoomModule } from '../room/room.module';
import { PlayerModule } from '../player/player.module';

@Module({
  imports: [GameModule, RoomModule, PlayerModule],
  providers: [WebsocketGateway],
})
export class GatewayModule {}
