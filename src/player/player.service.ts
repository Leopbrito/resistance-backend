import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { Player } from '../shared/interfaces';

const PLAYER_TTL_SECONDS = 7200; // 2 horas

@Injectable()
export class PlayerService {
  constructor(private readonly redisService: RedisService) {}

  private getPlayerKey(playerId: string): string {
    return `player:${playerId}`;
  }

  private getSocketKey(socketId: string): string {
    return `socket_player:${socketId}`;
  }

  public async createPlayer(value: Omit<Player, 'id' | 'role' | 'isLeader'>): Promise<Player> {
    const player: Player = {
      id: randomUUID(),
      socketId: value.socketId,
      name: value.name,
      isHost: value.isHost,
      roomCode: value.roomCode,
      connected: true,
    };

    await this.savePlayer(player);
    return player;
  }

  public async getPlayer(playerId: string): Promise<Player | null> {
    return this.redisService.getJson<Player>(this.getPlayerKey(playerId));
  }

  public async getPlayerBySocketId(socketId: string): Promise<Player | null> {
    const playerId = await this.redisService.get(this.getSocketKey(socketId));
    if (!playerId) return null;
    return this.getPlayer(playerId);
  }

  public async savePlayer(player: Player): Promise<void> {
    await Promise.all([
      this.redisService.setJson(this.getPlayerKey(player.id), player, PLAYER_TTL_SECONDS),
      this.redisService.set(this.getSocketKey(player.socketId), player.id, PLAYER_TTL_SECONDS),
    ]);
  }

  public async removePlayer(playerId: string): Promise<void> {
    const player = await this.getPlayer(playerId);
    const keysToDelete: string[] = [this.getPlayerKey(playerId)];
    if (player?.socketId) {
      keysToDelete.push(this.getSocketKey(player.socketId));
    }
    await this.redisService.del(...keysToDelete);
  }
}
