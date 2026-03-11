import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Room, Player } from '../shared/interfaces';
import { GamePhase } from '../shared/enums';

@Injectable()
export class RoomService {
  private rooms: Record<string, Room> = {};

  createRoom(hostPlayer: Player): Room {
    const code = this.generateRoomCode();
    hostPlayer.roomCode = code;

    const newRoom: Room = {
      code,
      hostId: hostPlayer.id,
      gameState: {
        phase: GamePhase.WAITING,
        me: hostPlayer,
        players: [hostPlayer],
        resistanceWins: 0,
        spyWins: 0,
        rounds: [],
        currentRoundIndex: 0,
        failedTeamsInRow: 0,
      },
    };

    this.rooms[code] = newRoom;
    return newRoom;
  }

  public getRoom(code: string): Room {
    const room = this.rooms[code];
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    return room;
  }

  public joinRoom(player: Player): Room {
    const room = this.getRoom(player.roomCode!);

    if (room.gameState.phase !== GamePhase.WAITING) {
      throw new BadRequestException('Game has already started');
    }

    if (room.gameState.players.some((p) => p.id === player.id)) {
      throw new BadRequestException('Player already in room');
    }

    if (room.gameState.players.some((p) => p.name.toLowerCase() === player.name.toLowerCase())) {
      throw new BadRequestException('A player with this name is already in the room');
    }

    if (room.gameState.players.length >= 10) {
      throw new BadRequestException('Room is full (max 10 players)');
    }

    room.gameState.players.push(player);
    return room;
  }

  public removePlayer(id: string) {
    for (const code in this.rooms) {
      const room = this.rooms[code];
      const playerIndex = room.gameState.players.findIndex((p) => p.id === id);

      if (playerIndex !== -1) {
        room.gameState.players.splice(playerIndex, 1);

        if (room.gameState.players.length === 0) {
          delete this.rooms[code];
        } else if (room.hostId === id) {
          room.hostId = room.gameState.players[0].socketId;
        }
      }
    }
  }

  private generateRoomCode(): string {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
    code += '-';
    for (let i = 0; i < 4; i++) code += numbers.charAt(Math.floor(Math.random() * numbers.length));

    if (this.rooms[code]) return this.generateRoomCode();
    return code;
  }
}
