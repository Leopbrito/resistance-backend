import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { UsePipes, ValidationPipe, Logger } from '@nestjs/common';
import { RoomService } from '../room/room.service';
import { GameService } from '../game/game.service';
import { PlayerService } from '../player/player.service';
import { CreateRoomDto, JoinRoomDto, SelectTeamDto, VoteTeamDto, MissionVoteDto } from '../shared/dtos';
import { Room } from '../shared/interfaces';
import { MissionVoteAction, Role } from 'src/shared/enums';

@WebSocketGateway({ 
  cors: { origin: '*' },
  transports: ['websocket'],
})
export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger: Logger = new Logger('WebsocketGateway');

  constructor(
    private readonly roomService: RoomService,
    private readonly gameService: GameService,
    private readonly playerService: PlayerService,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    const roomCode = this.playerService.removePlayer(client.id);

    if (roomCode) {
      try {
        const room = this.roomService.getRoom(roomCode);
        this.roomService.removePlayer(client.id);
        
        // Notify others
        this.emitGameStateAsync(room);

      } catch (e) {
        // Room may have been deleted if it was empty
        this.logger.error(`Error handling disconnect for room ${roomCode}`);
      }
    }
  }

  // --- ROOM EVENTS ---

  @UsePipes(new ValidationPipe())
  @SubscribeMessage('createRoom')
  handleCreateRoom(
    @MessageBody() dto: CreateRoomDto,
    @ConnectedSocket() client: Socket,
  ) {
    const room = this.roomService.createRoom(client.id, dto.playerName);
    this.playerService.addPlayer(client.id, room.code);
    client.join(room.code);
    
    this.logger.log(`Room created: ${room.code} by ${client.id}`);
    this.emitGameStateAsync(room);
    return room.code; // Return early to client
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    @MessageBody() dto: JoinRoomDto,
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const roomCode = dto.roomCode.toUpperCase();
      const room = this.roomService.joinRoom(roomCode, client.id, dto.playerName);
      this.playerService.addPlayer(client.id, room.code);
      client.join(room.code);
      
      this.logger.log(`Player ${client.id} joined room ${room.code}`);
      this.emitGameStateAsync(room);
      return { success: true };
    } catch (e) {
      // Return error to the specific client
      client.emit('error', e.message);
      return { success: false, error: e.message };
    }
  }

  // --- GAME EVENTS ---

  @SubscribeMessage('startGame')
  handleStartGame(@ConnectedSocket() client: Socket) {
    const roomCode = this.playerService.getRoomCode(client.id);
    if (!roomCode) return;

    try {
      const room = this.gameService.startGame(roomCode, client.id);
      this.logger.log(`Game started in room ${room.code}`);
      this.emitGameStateAsync(room, true);
      return { success: true };
    } catch (e) {
      client.emit('error', e.message);
      return { success: false, error: e.message };
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage('selectMissionTeam')
  handleSelectTeam(
    @MessageBody() dto: SelectTeamDto,
    @ConnectedSocket() client: Socket,
  ) {
    const roomCode = this.playerService.getRoomCode(client.id);
    if (!roomCode) return;

    try {
      const room = this.gameService.selectTeam(roomCode, client.id, dto.selectedPlayers);
      this.emitGameStateAsync(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage('submitSelectedMissionTeam')
  handleSubmitSelectedMissionTeam(
    @MessageBody() dto: SelectTeamDto,
    @ConnectedSocket() client: Socket,
  ) {
    const roomCode = this.playerService.getRoomCode(client.id);
    if (!roomCode) return;

    try {
      const room = this.gameService.submitSelectedMissionTeam(roomCode, client.id, dto.selectedPlayers);
      this.emitGameStateAsync(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage('voteTeamApproval')
  handleVoteTeam(
    @MessageBody() dto: VoteTeamDto,
    @ConnectedSocket() client: Socket,
  ) {
    const roomCode = this.playerService.getRoomCode(client.id);
    if (!roomCode) return;

    try {
      const room = this.gameService.voteTeam(roomCode, client.id, dto.vote);
      this.emitGameStateAsync(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage('submitMissionVote')
  handleSubmitMissionVote(
    @MessageBody() dto: MissionVoteDto,
    @ConnectedSocket() client: Socket,
  ) {
    const roomCode = this.playerService.getRoomCode(client.id);
    if (!roomCode) return;

    try {
      const room = this.gameService.submitMissionVote(roomCode, client.id, dto.vote);
      this.emitGameStateAsync(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }


  private emitGameStateAsync(room: Room, revealRolesStep: boolean = false) {
    room.gameState.players.forEach(player => {
      const privateState = { ...room.gameState };
      
      if (player.role === Role.RESISTANCE) {
        if (privateState.players) {
          privateState.players = privateState.players.map(p => ({
            ...p,
            role: undefined,
          }));
        }
      } 

      if (privateState.rounds.length > 0) {
        privateState.rounds = privateState.rounds.map(round => {
          const secretMissionVotes = {
            ...round.missionVotes,
          }

          Object.keys(secretMissionVotes).forEach(socketId => {
              secretMissionVotes[socketId] = "secret" as MissionVoteAction;
          });

          return {
            ...round,
            missionVotes: secretMissionVotes,
          }
        });
      }
      
      this.server.to(player.socketId).emit('gameStateUpdate', {
        ...privateState,
        me: {
          ...player
        },
        revealRolesStep,
      });
    });
  }
}
