import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Room, Player } from '../shared/interfaces';
import { GamePhase } from '../shared/enums';

@Injectable()
export class RoomService {
  private rooms: Record<string, Room> = {};

  generateRoomCode(): string {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
    code += '-';
    for (let i = 0; i < 4; i++) code += numbers.charAt(Math.floor(Math.random() * numbers.length));
    
    // Ensure uniqueness
    if (this.rooms[code]) return this.generateRoomCode();
    return code;
  }

  createRoom(hostSocketId: string, hostName: string): Room {
    const code = this.generateRoomCode();
    
    const hostPlayer: Player = {
      socketId: hostSocketId,
      name: hostName,
      isLeader: false,
      isHost: true,
      roomCode: code,
    };

    const newRoom: Room = {
      code,
      hostSocketId,
      gameState: {
        phase: GamePhase.WAITING,
        me: null,
        players: [hostPlayer],
        resistanceWins: 0,
        spyWins: 0,
        rounds: [],
        currentRoundIndex: 0,
        failedTeamsInRow: 0,
      }
    };

    this.rooms[code] = newRoom;
    return newRoom;
  }

  getRoom(code: string): Room {
    const room = this.rooms[code];
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    return room;
  }

  joinRoom(code: string, socketId: string, playerName: string): Room {
    const room = this.getRoom(code);

    if (room.gameState.phase !== GamePhase.WAITING) {
      throw new BadRequestException('Game has already started');
    }

    if (room.gameState.players.some(p => p.socketId === socketId)) {
      throw new BadRequestException('Player already in room');
    }

    // Usually The Resistance limit is 10 players
    if (room.gameState.players.length >= 10) {
      throw new BadRequestException('Room is full (max 10 players)');
    }

    const newPlayer: Player = {
      socketId,
      name: playerName,
      isLeader: false,
      isHost: false,
      roomCode: code,
    };

    room.gameState.players.push(newPlayer);
    return room;
  }

  removePlayer(socketId: string) {
    for (const code in this.rooms) {
      const room = this.rooms[code];
      const playerIndex = room.gameState.players.findIndex(p => p.socketId === socketId);
      
      if (playerIndex !== -1) {
        room.gameState.players.splice(playerIndex, 1);
        
        // If room is empty, delete it
        if (room.gameState.players.length === 0) {
          delete this.rooms[code];
        } else if (room.hostSocketId === socketId) {
          // Reassign host if host leaves
          room.hostSocketId = room.gameState.players[0].socketId;
        }

        return code;
      }
    }
    return null;
  }
}
