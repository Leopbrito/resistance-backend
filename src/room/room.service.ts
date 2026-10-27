import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { GamePhase } from '../shared/enums';
import { Player, Room } from '../shared/interfaces';

const ROOM_TTL_SECONDS = 7200; // 2 horas

@Injectable()
export class RoomService {
  constructor(private readonly redisService: RedisService) {}

  private getRoomKey(code: string): string {
    return `room:${code.toUpperCase()}`;
  }

  public async getRoom(code: string): Promise<Room> {
    const room = await this.redisService.getJson<Room>(this.getRoomKey(code));
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    // Renova TTL no acesso
    await this.redisService.expire(this.getRoomKey(code), ROOM_TTL_SECONDS);
    return room;
  }

  public async saveRoom(room: Room): Promise<void> {
    await this.redisService.setJson(this.getRoomKey(room.code), room, ROOM_TTL_SECONDS);
  }

  public async deleteRoom(code: string): Promise<void> {
    await this.redisService.del(this.getRoomKey(code));
  }

  public async createRoom(hostPlayer: Player): Promise<Room> {
    const code = await this.generateRoomCode();
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

    await this.saveRoom(newRoom);
    return newRoom;
  }

  public async joinRoom(player: Player): Promise<Room> {
    const room = await this.getRoom(player.roomCode!);

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
    await this.saveRoom(room);
    return room;
  }

  public async removePlayer(id: string, roomCode?: string): Promise<void> {
    if (roomCode) {
      try {
        const room = await this.getRoom(roomCode);
        await this.removePlayerFromRoom(room, id);
      } catch {
        // Sala já inexistente
      }
      return;
    }

    // Caso roomCode não seja fornecido, busca em todas as chaves de salas
    const roomKeys = await this.redisService.keys('room:*');
    for (const key of roomKeys) {
      const room = await this.redisService.getJson<Room>(key);
      if (room) {
        await this.removePlayerFromRoom(room, id);
      }
    }
  }

  private async removePlayerFromRoom(room: Room, playerId: string): Promise<void> {
    const playerIndex = room.gameState.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return;

    room.gameState.players.splice(playerIndex, 1);

    if (room.gameState.players.length === 0) {
      await this.deleteRoom(room.code);
    } else {
      if (room.hostId === playerId) {
        room.hostId = room.gameState.players[0].id;
      }
      await this.saveRoom(room);
    }
  }

  private async generateRoomCode(): Promise<string> {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
    code += '-';
    for (let i = 0; i < 4; i++) code += numbers.charAt(Math.floor(Math.random() * numbers.length));

    const exists = await this.redisService.exists(this.getRoomKey(code));
    if (exists) return this.generateRoomCode();
    return code;
  }
}
