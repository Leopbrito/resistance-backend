import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MissionVoteAction, Role, SocketEvent } from 'src/shared/enums';
import { GameService } from '../game/game.service';
import { PlayerService } from '../player/player.service';
import { RoomService } from '../room/room.service';
import { CreateRoomDto, JoinRoomDto, MissionVoteDto, SelectTeamDto, VoteTeamDto } from '../shared/dtos';
import { GameState, Room } from '../shared/interfaces';

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket'],
})
export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() public server: Server;

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
  @SubscribeMessage(SocketEvent.CREATE_ROOM)
  handleCreateRoom(@MessageBody() dto: CreateRoomDto, @ConnectedSocket() client: Socket) {
    const room = this.roomService.createRoom(client.id, dto.playerName);
    this.playerService.addPlayer(client.id, room.code);
    client.join(room.code);

    this.logger.log(`Room created: ${room.code} by ${client.id}`);
    this.emitGameStateAsync(room);
    return room.code;
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage(SocketEvent.JOIN_ROOM)
  handleJoinRoom(@MessageBody() dto: JoinRoomDto, @ConnectedSocket() client: Socket) {
    try {
      const roomCode = dto.roomCode.toUpperCase();
      const room = this.roomService.joinRoom(roomCode, client.id, dto.playerName);
      this.playerService.addPlayer(client.id, room.code);
      client.join(room.code);

      this.logger.log(`Player ${client.id} joined room ${room.code}`);
      this.emitGameStateAsync(room);
      return { success: true };
    } catch (error) {
      client.emit(SocketEvent.ERROR, error.message);
      return { success: false, error: error.message };
    }
  }

  // --- GAME EVENTS ---

  @SubscribeMessage(SocketEvent.START_GAME)
  handleStartGame(@ConnectedSocket() client: Socket) {
    const roomCode = this.playerService.getRoomCode(client.id);
    if (!roomCode) return;

    try {
      const room = this.gameService.startGame(roomCode, client.id);
      this.logger.log(`Game started in room ${room.code}`);
      this.emitGameStateAsync(room);
      this.emitRevealRoles(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage('selectMissionTeam')
  handleSelectTeam(@MessageBody() dto: SelectTeamDto, @ConnectedSocket() client: Socket) {
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
  handleSubmitSelectedMissionTeam(@MessageBody() dto: SelectTeamDto, @ConnectedSocket() client: Socket) {
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
  handleVoteTeam(@MessageBody() dto: VoteTeamDto, @ConnectedSocket() client: Socket) {
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
  handleSubmitMissionVote(@MessageBody() dto: MissionVoteDto, @ConnectedSocket() client: Socket) {
    const roomCode = this.playerService.getRoomCode(client.id);
    if (!roomCode) return;

    try {
      let resolveResultMission = false;
      const room = this.gameService.submitMissionVote(roomCode, client.id, dto.vote, () => {
        resolveResultMission = true;
      });
      this.emitGameStateAsync(room);
      if (resolveResultMission) {
        this.emitRevealMissionResult(roomCode);
      }
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  private emitRevealRoles(room: Room) {
    this.server.to(room.code).emit(SocketEvent.REVEAL_ROLES);
  }

  private emitRevealMissionResult(roomCode: string) {
    this.server.to(roomCode).emit(SocketEvent.REVEAL_MISSION_RESULT);
  }

  private emitGameStateAsync(room: Room) {
    room.gameState.players.forEach((player) => {
      const privateGameState = { ...room.gameState, me: player };

      this.hideSpysforResistancePlayer(privateGameState);
      this.hideMissionVotes(privateGameState);

      this.server.to(player.socketId).emit(SocketEvent.GAME_STATE_UPDATE, privateGameState);
    });
  }

  private hideSpysforResistancePlayer(gameState: GameState) {
    if (gameState.me?.role === Role.RESISTANCE) {
      if (gameState.players) {
        gameState.players = gameState.players.map((p) => ({
          ...p,
          role: undefined,
        }));
      }
    }
  }

  private hideMissionVotes(gameState: GameState) {
    if (gameState.rounds.length > 0) {
      gameState.rounds = gameState.rounds.map((round) => {
        const secretMissionVotes = {
          ...round.missionVotes,
        };

        Object.keys(secretMissionVotes).forEach((socketId) => {
          secretMissionVotes[socketId] = 'secret' as MissionVoteAction;
        });

        return {
          ...round,
          missionVotes: secretMissionVotes,
        };
      });
    }
  }
}
