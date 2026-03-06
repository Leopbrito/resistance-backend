import { Injectable } from '@nestjs/common';

@Injectable()
export class PlayerService {
  private players: Map<string, string> = new Map(); // socketId -> roomCode

  addPlayer(socketId: string, roomCode: string) {
    this.players.set(socketId, roomCode);
  }

  getRoomCode(socketId: string): string | undefined {
    return this.players.get(socketId);
  }

  removePlayer(socketId: string) {
    const roomCode = this.players.get(socketId);
    this.players.delete(socketId);
    return roomCode;
  }
}
