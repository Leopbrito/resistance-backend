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
        this.emitGameStateAsync(roomCode, room);

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
    this.emitGameStateAsync(room.code, room);
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
      this.emitGameStateAsync(room.code, room);
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
      this.emitGameStateAsync(room.code, room);
    } catch (e) {
      client.emit('error', e.message);
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
      this.emitGameStateAsync(roomCode, room);
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
      this.emitGameStateAsync(roomCode, room);
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
      this.emitGameStateAsync(roomCode, room);
    } catch (e) {
      client.emit('error', e.message);
    }
  }

  /**
   * Função para emitir o estado do jogo e proteger papéis sensíveis
   */
  private emitGameStateAsync(roomCode: string, room: Room) {
    // Para simplificar: enviamos o estado global mas OMITIMOS quem é espião.
    // Você não deve mostrar quem é espião para a resistência.
    const sanitizedGameState = { ...room.gameState };
    
    // Omit spy identification globally
    if (sanitizedGameState.players) {
      sanitizedGameState.players = sanitizedGameState.players.map(p => ({
        ...p,
        role: undefined, // Hide global roles by default
      }));
    }

    // Emit para todos os jogadores o estado 'sanitizado'
    this.server.to(roomCode).emit('gameStateUpdate', sanitizedGameState);

    // E então manda um evento 'privateRoleUpdate' (ou similar) só mandando os espiões pra quem for espião...
    // Opcionalmente, pode-se simplesmente percorrer cada socket.
    const serverInst = this.server;
    room.gameState.players.forEach(p => {
      const privateState = { ...room.gameState };
      
      // Se for Espião, ele pode ver a lista de espiões (gameState.spyPlayers tem socketIds)
      if (p.role === 'SPY') {
        privateState.spyPlayers = room.gameState.spyPlayers;
      } else {
        privateState.spyPlayers = []; // Resistência não vê nada
      }
      
      // O jogador sempre deve saber seu próprio papel.
      const personalPlayerObj = room.gameState.players.find(rp => rp.socketId === p.socketId);

      serverInst.to(p.socketId).emit('privateGameState', {
        ...privateState,
        myRole: p.role,
      });
    });
  }
}
