import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { Player, PlayerSession } from '../shared/interfaces';

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

  // Renova o TTL no acesso, como na sala, para partidas longas não expirarem o jogador
  public async getPlayer(playerId: string): Promise<PlayerSession | null> {
    const player = await this.redisService.getJson<PlayerSession>(this.getPlayerKey(playerId));
    if (player) {
      await Promise.all([
        this.redisService.expire(this.getPlayerKey(playerId), PLAYER_TTL_SECONDS),
        this.redisService.expire(this.getSocketKey(player.socketId), PLAYER_TTL_SECONDS),
      ]);
    }
    return player;
  }

  public async getPlayerBySocketId(socketId: string): Promise<PlayerSession | null> {
    const playerId = await this.redisService.get(this.getSocketKey(socketId));
    if (!playerId) return null;
    return this.getPlayer(playerId);
  }

  public async savePlayer(player: PlayerSession): Promise<void> {
    const session: PlayerSession = {
      id: player.id,
      socketId: player.socketId,
      name: player.name,
      roomCode: player.roomCode,
    };

    await Promise.all([
      this.redisService.setJson(this.getPlayerKey(player.id), session, PLAYER_TTL_SECONDS),
      this.redisService.set(this.getSocketKey(player.socketId), player.id, PLAYER_TTL_SECONDS),
    ]);
  }

  public async releaseSocket(socketId: string): Promise<void> {
    await this.redisService.del(this.getSocketKey(socketId));
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
