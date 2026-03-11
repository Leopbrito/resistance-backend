import { Injectable } from '@nestjs/common';
import { Player } from 'src/shared/interfaces';
import { randomUUID } from 'crypto';

@Injectable()
export class PlayerService {
  private players: Map<string, Player> = new Map();

  public createPlayer(value: Omit<Player, 'id' | 'role' | 'isLeader'>): Player {
    const player: Player = {
      id: randomUUID(),
      socketId: value.socketId,
      name: value.name,
      isHost: value.isHost,
      roomCode: value.roomCode,
      connected: true,
    };
    this.players.set(player.id, player);
    return player;
  }

  public getPlayer(playerId: string): Player | undefined {
    return this.players.get(playerId);
  }

  public getPlayerBySocketId(socketId: string): Player | undefined {
    let player;
    this.players.forEach((p) => {
      if (p.socketId === socketId) {
        player = p;
      }
    });
    return player;
  }

  public removePlayer(playerId: string) {
    this.players.delete(playerId);
  }
}
