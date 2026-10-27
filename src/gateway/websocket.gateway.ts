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
import { GamePhase, MissionVoteAction, Role, SocketEvent } from 'src/shared/enums';
import { GameService } from '../game/game.service';
import { PlayerService } from '../player/player.service';
import { RoomService } from '../room/room.service';
import { CreateRoomDto, JoinRoomDto, MissionVoteDto, SelectTeamDto, VoteTeamDto } from '../shared/dtos';
import { GameState, Player, Room } from '../shared/interfaces';

const DISCONNECT_IN_ONE_MINUTES = 60000;
const OFFLINE_ACTOR_SKIP_MS = 60000;
const IN_PROGRESS_PHASES = [GamePhase.TEAM_SELECTION, GamePhase.VOTING, GamePhase.MISSION];

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket'],
})
export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() public server: Server;

  private logger: Logger = new Logger('WebsocketGateway');

  // Um timer por sala: espera o ator offline da vez antes de pular a ação dele
  private offlineActorTimers = new Map<string, { actorId: string; key: string; timer: NodeJS.Timeout }>();

  constructor(
    private readonly roomService: RoomService,
    private readonly gameService: GameService,
    private readonly playerService: PlayerService,
  ) {}

  async handleConnection(client: Socket) {
    const playerId = (client.handshake.auth?.playerId || client.handshake.query.playerId) as string;
    this.logger.log(`Client connected: ${playerId}  ${client.id}`);

    if (playerId) {
      const player = await this.playerService.getPlayer(playerId);
      if (player) {
        if (player.socketId && player.socketId !== client.id) {
          await this.playerService.releaseSocket(player.socketId);
        }
        player.socketId = client.id;
        player.connected = true;
        await this.playerService.savePlayer(player);

        if (player.roomCode) {
          try {
            client.join(player.roomCode);
            const room = await this.roomService.getRoom(player.roomCode);
            const roomPlayer = room.gameState.players.find((p) => p.id === player.id);
            if (roomPlayer) {
              roomPlayer.socketId = client.id;
              roomPlayer.connected = true;
              await this.roomService.saveRoom(room);
            }
            this.emitGameStateAsync(room, player.id);
          } catch (e) {
            this.logger.warn(`Could not restore room ${player.roomCode}: ${e.message}`);
          }
        }
      }
    }
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    const player = await this.playerService.getPlayerBySocketId(client.id);
    if (!player) return;

    // Socket já substituído por uma reconexão (ex.: refresh): o disconnect antigo não deve derrubar o jogador
    if (player.socketId !== client.id) {
      await this.playerService.releaseSocket(client.id);
      return;
    }

    player.connected = false;
    await this.playerService.savePlayer(player);

    if (player.roomCode) {
      try {
        const room = await this.roomService.getRoom(player.roomCode);
        const roomPlayer = room.gameState.players.find((p) => p.id === player.id);
        if (roomPlayer) {
          roomPlayer.connected = false;
          await this.roomService.saveRoom(room);
        }
        this.emitGameStateAsync(room);
      } catch (e) {
        this.logger.warn(`Room ${player.roomCode} not found during disconnect: ${e.message}`);
      }
    }

    setTimeout(async () => {
      const currentPlayer = await this.playerService.getPlayer(player.id);
      if (currentPlayer && !currentPlayer.connected && currentPlayer.socketId === client.id) {
        await this.handleOfflineTimeout(currentPlayer);
      }
    }, DISCONNECT_IN_ONE_MINUTES);
  }

  private async handleOfflineTimeout(player: Player) {
    if (player.roomCode) {
      try {
        const room = await this.roomService.getRoom(player.roomCode);

        // Durante a partida o jogador é mantido para poder voltar; só o host é repassado
        if (IN_PROGRESS_PHASES.includes(room.gameState.phase)) {
          if (await this.roomService.migrateHostIfOffline(room)) {
            this.emitGameStateAsync(room);
          }
          return;
        }
      } catch {
        // Sala já encerrada
      }

      await this.roomService.removePlayer(player.id, player.roomCode);
      try {
        const updatedRoom = await this.roomService.getRoom(player.roomCode);
        this.emitGameStateAsync(updatedRoom);
      } catch {
        // Sala já encerrada
      }
    }
    await this.playerService.removePlayer(player.id);
  }

  // --- ROOM EVENTS ---

  @UsePipes(new ValidationPipe())
  @SubscribeMessage(SocketEvent.CREATE_ROOM)
  async handleCreateRoom(@MessageBody() dto: CreateRoomDto, @ConnectedSocket() client: Socket) {
    const player = await this.playerService.createPlayer({
      name: dto.playerName,
      isHost: true,
      socketId: client.id,
    });
    const room = await this.roomService.createRoom(player);
    player.roomCode = room.code;
    await this.playerService.savePlayer(player);

    client.join(room.code);

    this.logger.log(`Room created: ${room.code} by ${client.id}`);
    this.emitGameStateAsync(room);
    return { roomCode: room.code, playerId: player.id };
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage(SocketEvent.JOIN_ROOM)
  async handleJoinRoom(@MessageBody() dto: JoinRoomDto, @ConnectedSocket() client: Socket) {
    try {
      const player = await this.playerService.createPlayer({
        name: dto.playerName,
        isHost: false,
        socketId: client.id,
        roomCode: dto.roomCode.toUpperCase(),
      });
      const room = await this.roomService.joinRoom(player);
      client.join(room.code);

      this.logger.log(`Player ${client.id} joined room ${room.code}`);
      this.emitGameStateAsync(room);
      return { roomCode: room.code, playerId: player.id };
    } catch (error) {
      client.emit(SocketEvent.ERROR, error.message);
      return { success: false, error: error.message };
    }
  }

  // --- GAME EVENTS ---

  @SubscribeMessage(SocketEvent.START_GAME)
  async handleStartGame(@ConnectedSocket() client: Socket) {
    const player = await this.playerService.getPlayerBySocketId(client.id);
    if (!player) return;

    try {
      const room = await this.gameService.startGame(player);
      this.logger.log(`Game started in room ${room.code}`);
      this.emitGameStateAsync(room);
      this.emitRevealRoles(room);
    } catch (e) {
      this.logger.log(`error ${e.message}`);
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage(SocketEvent.SELECT_MISSION_TEAM)
  async handleSelectTeam(@MessageBody() dto: SelectTeamDto, @ConnectedSocket() client: Socket) {
    const player = await this.playerService.getPlayerBySocketId(client.id);
    if (!player) return;

    try {
      const room = await this.gameService.selectTeam(player, dto.selectedPlayers);
      this.emitGameStateAsync(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage(SocketEvent.SUBMIT_SELECTED_MISSION_TEAM)
  async handleSubmitSelectedMissionTeam(@MessageBody() dto: SelectTeamDto, @ConnectedSocket() client: Socket) {
    const player = await this.playerService.getPlayerBySocketId(client.id);
    if (!player) return;

    try {
      const room = await this.gameService.submitSelectedMissionTeam(player, dto.selectedPlayers);
      this.emitGameStateAsync(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage(SocketEvent.VOTE_TEAM_APPROVAL)
  async handleVoteTeam(@MessageBody() dto: VoteTeamDto, @ConnectedSocket() client: Socket) {
    const player = await this.playerService.getPlayerBySocketId(client.id);
    if (!player) return;

    try {
      const room = await this.gameService.voteTeam(player, dto.vote);
      this.emitGameStateAsync(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage(SocketEvent.SUBMIT_MISSION_VOTE)
  async handleSubmitMissionVote(@MessageBody() dto: MissionVoteDto, @ConnectedSocket() client: Socket) {
    const player = await this.playerService.getPlayerBySocketId(client.id);
    if (!player) return;

    try {
      let resolveResultMission = false;
      const room = await this.gameService.submitMissionVote(player, dto.vote, () => {
        resolveResultMission = true;
      });
      this.emitGameStateAsync(room);
      if (resolveResultMission) {
        this.emitOpenMissionResultScreen(room);
      }
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  @UsePipes(new ValidationPipe())
  @SubscribeMessage(SocketEvent.SUBMIT_MISSION_RESULT_REVEAL)
  async handleSubmitMissionResultReveal(@ConnectedSocket() client: Socket) {
    const player = await this.playerService.getPlayerBySocketId(client.id);
    if (!player) return;

    try {
      const room = await this.roomService.getRoom(player.roomCode!);
      this.emitRevealMissionResult(room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  private emitRevealRoles(room: Room) {
    room.gameState.players.forEach((player) => {
      this.server.to(player.socketId).emit(SocketEvent.REVEAL_ROLES);
    });
  }

  private emitRevealMissionResult(room: Room) {
    room.gameState.players.forEach((player) => {
      this.server.to(player.socketId).emit(SocketEvent.REVEAL_MISSION_RESULT);
    });
  }

  private emitOpenMissionResultScreen(room: Room) {
    room.gameState.players.forEach((player) => {
      this.server.to(player.socketId).emit(SocketEvent.OPEN_MISSION_RESULT_SCREEN);
    });
  }

  private emitGameStateAsync(room: Room, reconnectingPlayerId?: string) {
    room.gameState.players.forEach((player) => {
      const privateGameState = { ...room.gameState, me: player };

      if (privateGameState.phase !== GamePhase.FINISHED) {
        this.hideSpysforResistancePlayer(privateGameState);
        this.hideMissionVotes(privateGameState);
      }

      this.server
        .to(player.socketId)
        .emit(
          player.id === reconnectingPlayerId ? SocketEvent.RECONNECT : SocketEvent.GAME_STATE_UPDATE,
          privateGameState,
        );
    });

    this.scheduleOfflineActorSkip(room);
  }

  private scheduleOfflineActorSkip(room: Room) {
    const { gameState } = room;
    const actorId = this.gameService.getPendingOfflineActorId(gameState);
    const key = actorId
      ? `${gameState.phase}:${gameState.currentRoundIndex}:${gameState.failedTeamsInRow}:${actorId}`
      : undefined;

    const existing = this.offlineActorTimers.get(room.code);
    if (existing && existing.key === key) return;
    if (existing) {
      clearTimeout(existing.timer);
      this.offlineActorTimers.delete(room.code);
    }
    if (!actorId || !key) return;

    const timer = setTimeout(() => this.skipOfflineActor(room.code, actorId), OFFLINE_ACTOR_SKIP_MS);
    timer.unref?.();
    this.offlineActorTimers.set(room.code, { actorId, key, timer });
  }

  private async skipOfflineActor(roomCode: string, actorId: string) {
    this.offlineActorTimers.delete(roomCode);

    try {
      let missionResolved = false;
      const room = await this.gameService.skipOfflineActor(roomCode, actorId, () => {
        missionResolved = true;
      });
      if (!room) return;

      this.logger.log(`Skipped offline player ${actorId} in room ${roomCode}`);
      await this.roomService.migrateHostIfOffline(room);
      this.emitGameStateAsync(room);
      if (missionResolved) {
        this.emitOpenMissionResultScreen(room);
      }
    } catch (e) {
      this.logger.warn(`Could not skip offline player ${actorId} in room ${roomCode}: ${e.message}`);
    }
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

        Object.keys(secretMissionVotes).forEach((id) => {
          secretMissionVotes[id] = 'secret' as MissionVoteAction;
        });

        return {
          ...round,
          missionVotes: secretMissionVotes,
        };
      });
    }
  }
}
