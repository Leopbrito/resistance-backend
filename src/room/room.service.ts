import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { GamePhase } from '../shared/enums';
import { Player, Room } from '../shared/interfaces';
import { ErrorCode, errorPayload } from '../shared/error-codes';

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
      throw new NotFoundException(errorPayload(ErrorCode.ROOM_NOT_FOUND));
    }
    // Renova TTL no acesso
    await this.redisService.expire(this.getRoomKey(code), ROOM_TTL_SECONDS);
    return room;
  }

  public async saveRoom(room: Room): Promise<void> {
    await this.redisService.setJson(this.getRoomKey(room.code), room, ROOM_TTL_SECONDS);
  }

  /** Atualiza o jogador na sala (única fonte do estado de jogo do jogador) e persiste. */
  public async updatePlayer(roomCode: string, playerId: string, patch: Partial<Player>): Promise<Room> {
    const room = await this.getRoom(roomCode);
    const roomPlayer = room.gameState.players.find((p) => p.id === playerId);
    if (roomPlayer) {
      Object.assign(roomPlayer, patch);
      await this.saveRoom(room);
    }
    return room;
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
      throw new BadRequestException(errorPayload(ErrorCode.GAME_ALREADY_STARTED));
    }

    if (room.gameState.players.some((p) => p.id === player.id)) {
      throw new BadRequestException(errorPayload(ErrorCode.PLAYER_ALREADY_IN_ROOM));
    }

    if (room.gameState.players.some((p) => p.name.toLowerCase() === player.name.toLowerCase())) {
      throw new BadRequestException(errorPayload(ErrorCode.PLAYER_NAME_TAKEN));
    }

    if (room.gameState.players.length >= 10) {
      throw new BadRequestException(errorPayload(ErrorCode.ROOM_FULL, { max: 10 }));
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

  /** Passa o host para outro jogador conectado quando o host atual está offline. */
  public async migrateHostIfOffline(room: Room): Promise<boolean> {
    const { players } = room.gameState;
    const host = players.find((p) => p.id === room.hostId);
    if (!host || host.connected !== false) return false;

    const nextHost = players.find((p) => p.id !== host.id && p.connected !== false);
    if (!nextHost) return false;

    host.isHost = false;
    nextHost.isHost = true;
    room.hostId = nextHost.id;
    await this.saveRoom(room);
    return true;
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
