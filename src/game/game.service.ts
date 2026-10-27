import { BadRequestException, Injectable } from '@nestjs/common';
import { TEAM_SIZE_MISSION_CONFIGS, TEAM_SIZE_SPY_CONFIGS } from 'src/config/game.config';
import { RoomService } from '../room/room.service';
import { AckScreen, GamePhase, MissionVoteAction, Role, TeamVoteAction } from '../shared/enums';
import { GameState, Player, PlayerSession, Room, Round } from '../shared/interfaces';
import { ErrorCode, errorPayload } from '../shared/error-codes';

@Injectable()
export class GameService {
  constructor(private readonly roomService: RoomService) {}

  public async startGame(player: PlayerSession): Promise<Room> {
    const room = await this.roomService.getRoom(player.roomCode!);

    if (room.hostId !== player.id) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_HOST));
    }

    const { players } = room.gameState;
    const playerCount = players.length;

    if (playerCount < 5 || playerCount > 10) {
      throw new BadRequestException(errorPayload(ErrorCode.INVALID_PLAYER_COUNT, { min: 5, max: 10 }));
    }

    if (
      room.gameState.phase === GamePhase.TEAM_SELECTION ||
      room.gameState.phase === GamePhase.VOTING ||
      room.gameState.phase === GamePhase.MISSION
    ) {
      throw new BadRequestException(errorPayload(ErrorCode.GAME_ALREADY_STARTED));
    }

    this.resetGameState(room.gameState);
    this.assignRoles(players);
    this.startNewRound(room.gameState);

    await this.roomService.saveRoom(room);
    return room;
  }

  private resetGameState(gameState: GameState) {
    gameState.phase = GamePhase.WAITING;
    gameState.resistanceWins = 0;
    gameState.spyWins = 0;
    gameState.rounds = [];
    gameState.currentRoundIndex = 0;
    gameState.failedTeamsInRow = 0;
  }

  private assignRoles(players: Player[]) {
    const spyCount = TEAM_SIZE_SPY_CONFIGS[players.length];

    // Reseta todos para Resistance e remove líder
    players.forEach((p) => {
      p.role = Role.RESISTANCE;
      p.isLeader = false;
      p.rolesSeen = false;
      p.pendingMissionResult = null;
      p.gameEndSeen = false;
    });

    // Distribui os Espiões aleatoriamente
    let assignedSpies = 0;
    while (assignedSpies < spyCount) {
      const randomIndex = Math.floor(Math.random() * players.length);
      if (players[randomIndex].role !== Role.SPY) {
        players[randomIndex].role = Role.SPY;
        assignedSpies++;
      }
    }
  }

  private startNewRound(gameState: GameState) {
    const totalPlayersCount = gameState.players.length;

    // Choose new leader by rotating
    const currentLeaderIndex = gameState.players.findIndex((p) => p.isLeader);
    let nextLeaderIndex = 0;

    if (currentLeaderIndex !== -1) {
      gameState.players[currentLeaderIndex].isLeader = false;
      nextLeaderIndex = (currentLeaderIndex + 1) % totalPlayersCount;
    } else {
      // First round: random leader
      nextLeaderIndex = Math.floor(Math.random() * totalPlayersCount);
    }

    const newLeader = gameState.players[nextLeaderIndex];
    newLeader.isLeader = true;

    // Define team size
    const roundNumber = gameState.rounds.length + 1;
    const requiredTeamSize = TEAM_SIZE_MISSION_CONFIGS[totalPlayersCount][roundNumber - 1];

    const newRound: Round = {
      roundNumber,
      leaderId: newLeader.id,
      teamSize: requiredTeamSize,
      selectedTeam: [],
      teamVotes: {},
      missionVotes: {},
      missionVoteResult: [],
      status: 'PENDING',
    };

    gameState.rounds.push(newRound);
    gameState.currentRoundIndex = gameState.rounds.length - 1;
    gameState.phase = GamePhase.TEAM_SELECTION;
  }

  public async selectTeam(player: PlayerSession, selectedPlayers: string[]): Promise<Room> {
    const room = await this.roomService.getRoom(player.roomCode!);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.TEAM_SELECTION) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_TEAM_SELECTION_PHASE));
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (currentRound.leaderId !== player.id) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_LEADER));
    }

    selectedPlayers.forEach((selectedId) => {
      if (!gameState.players.find((p) => p.id === selectedId)) {
        throw new BadRequestException(errorPayload(ErrorCode.INVALID_SELECTED_PLAYER));
      }
    });

    currentRound.selectedTeam = selectedPlayers;
    await this.roomService.saveRoom(room);

    return room;
  }

  public async submitSelectedMissionTeam(player: PlayerSession, selectedPlayers: string[]): Promise<Room> {
    const room = await this.roomService.getRoom(player.roomCode!);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.TEAM_SELECTION) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_TEAM_SELECTION_PHASE));
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (currentRound.leaderId !== player.id) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_LEADER));
    }

    if (selectedPlayers.length !== currentRound.teamSize) {
      throw new BadRequestException(errorPayload(ErrorCode.INVALID_TEAM_SIZE, { teamSize: currentRound.teamSize }));
    }

    selectedPlayers.forEach((selectedId) => {
      if (!gameState.players.find((p) => p.id === selectedId)) {
        throw new BadRequestException(errorPayload(ErrorCode.INVALID_SELECTED_PLAYER));
      }
    });

    currentRound.selectedTeam = selectedPlayers;
    gameState.phase = GamePhase.VOTING;
    currentRound.currentTeamVoterId = currentRound.leaderId;

    await this.roomService.saveRoom(room);
    return room;
  }

  public async voteTeam(player: PlayerSession, vote: TeamVoteAction): Promise<Room> {
    const room = await this.roomService.getRoom(player.roomCode!);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.VOTING) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_VOTING_PHASE));
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (currentRound.currentTeamVoterId && currentRound.currentTeamVoterId !== player.id) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_YOUR_TURN_TO_VOTE));
    }

    if (currentRound.teamVotes[player.id]) {
      throw new BadRequestException(errorPayload(ErrorCode.ALREADY_VOTED));
    }

    currentRound.teamVotes[player.id] = vote;
    this.advanceTeamVoting(gameState, player.id);

    await this.roomService.saveRoom(room);
    return room;
  }

  // Passa a vez para o próximo votante ou resolve a votação quando todos votaram ou foram pulados
  private advanceTeamVoting(gameState: GameState, fromPlayerId: string) {
    const currentRound = gameState.rounds[gameState.currentRoundIndex];
    const countedVotes = Object.keys(currentRound.teamVotes).length + (currentRound.skippedTeamVoters?.length ?? 0);

    if (countedVotes >= gameState.players.length) {
      currentRound.currentTeamVoterId = undefined;
      this.resolveTeamVotes(gameState);
    } else {
      const currentPlayerIndex = gameState.players.findIndex((p) => p.id === fromPlayerId);
      const nextPlayerIndex = (currentPlayerIndex + 1) % gameState.players.length;
      currentRound.currentTeamVoterId = gameState.players[nextPlayerIndex].id;
    }
  }

  /** Jogador offline de quem o jogo está esperando uma ação (líder, votante ou membro da missão). */
  public getPendingOfflineActorId(gameState: GameState): string | undefined {
    const round = gameState.rounds[gameState.currentRoundIndex];
    if (!round) return undefined;

    const isOffline = (id?: string) => !!id && gameState.players.find((p) => p.id === id)?.connected === false;

    switch (gameState.phase) {
      case GamePhase.TEAM_SELECTION:
        return isOffline(round.leaderId) ? round.leaderId : undefined;
      case GamePhase.VOTING:
        return isOffline(round.currentTeamVoterId) ? round.currentTeamVoterId : undefined;
      case GamePhase.MISSION:
        return round.selectedTeam.find((id) => !round.missionVotes[id] && isOffline(id));
      default:
        return undefined;
    }
  }

  /**
   * Destrava o jogo quando o ator da vez continua offline: pula o líder, pula o voto de equipe
   * ou registra SUCCESS na missão. Retorna null se o ator já mudou ou voltou.
   */
  public async skipOfflineActor(
    roomCode: string,
    expectedActorId: string,
    resolveMissionResult: () => void,
  ): Promise<Room | null> {
    const room = await this.roomService.getRoom(roomCode);
    const { gameState } = room;

    if (this.getPendingOfflineActorId(gameState) !== expectedActorId) return null;

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    switch (gameState.phase) {
      case GamePhase.TEAM_SELECTION:
        // Rotaciona o líder sem contar como time rejeitado
        this.resetCurrentRoundForNewTeam(gameState);
        break;
      case GamePhase.VOTING:
        currentRound.skippedTeamVoters = [...(currentRound.skippedTeamVoters ?? []), expectedActorId];
        this.advanceTeamVoting(gameState, expectedActorId);
        break;
      case GamePhase.MISSION: {
        const actor = gameState.players.find((p) => p.id === expectedActorId)!;
        return this.submitMissionVote(
          { ...actor, roomCode: room.code },
          MissionVoteAction.SUCCESS,
          resolveMissionResult,
        );
      }
    }

    await this.roomService.saveRoom(room);
    return room;
  }

  private resolveTeamVotes(gameState: GameState) {
    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    let approves = 0;
    let rejects = 0;

    Object.values(currentRound.teamVotes).forEach((v) => {
      if (v === TeamVoteAction.APPROVE) approves++;
      else rejects++;
    });

    if (approves > rejects) {
      // Time aprovado e vai para a Missão
      currentRound.status = 'TEAM_APPROVED';
      gameState.phase = GamePhase.MISSION;
      gameState.failedTeamsInRow = 0;
    } else {
      // Time rejeitado
      currentRound.status = 'TEAM_REJECTED';
      gameState.failedTeamsInRow++;

      if (gameState.failedTeamsInRow === 5) {
        // Espiões vencem se 5 times seguidos forem rejeitados na mesma rodada (Regra oficial)
        gameState.spyWins = 3;
        gameState.phase = GamePhase.FINISHED;
      } else {
        // Rotaciona o líder e mantém a mesma rodada tentando equipe novamente
        this.resetCurrentRoundForNewTeam(gameState);
      }
    }
  }

  private resetCurrentRoundForNewTeam(gameState: GameState) {
    const totalPlayersCount = gameState.players.length;
    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    const currentLeaderIndex = gameState.players.findIndex((p) => p.isLeader);
    gameState.players[currentLeaderIndex].isLeader = false;

    const nextLeaderIndex = (currentLeaderIndex + 1) % totalPlayersCount;
    gameState.players[nextLeaderIndex].isLeader = true;

    // Limpa estado para nova tentativa de seleção
    currentRound.leaderId = gameState.players[nextLeaderIndex].id;
    currentRound.selectedTeam = [];
    currentRound.teamVotes = {};
    currentRound.skippedTeamVoters = [];
    currentRound.status = 'PENDING';
    currentRound.currentTeamVoterId = undefined;

    gameState.phase = GamePhase.TEAM_SELECTION;
  }

  public async submitMissionVote(
    player: PlayerSession,
    vote: MissionVoteAction,
    resolveMissionResult: () => void,
  ): Promise<Room> {
    const room = await this.roomService.getRoom(player.roomCode!);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.MISSION) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_MISSION_PHASE));
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (!currentRound.selectedTeam.includes(player.id)) {
      throw new BadRequestException(errorPayload(ErrorCode.NOT_ON_MISSION_TEAM));
    }

    if (currentRound.missionVotes[player.id]) {
      throw new BadRequestException(errorPayload(ErrorCode.MISSION_ALREADY_PERFORMED));
    }

    currentRound.missionVotes[player.id] = vote;

    const totalMissionVotes = Object.keys(currentRound.missionVotes).length;

    if (totalMissionVotes === currentRound.teamSize) {
      this.resolveMission(gameState);
      resolveMissionResult();
    }

    await this.roomService.saveRoom(room);
    return room;
  }

  /** Marca uma tela como vista pelo jogador (persistido para o refresh voltar à tela certa). */
  public async ackScreen(player: PlayerSession, screen: AckScreen): Promise<Room> {
    const room = await this.roomService.getRoom(player.roomCode!);
    const roomPlayer = room.gameState.players.find((p) => p.id === player.id);
    if (!roomPlayer) throw new BadRequestException(errorPayload(ErrorCode.PLAYER_NOT_IN_ROOM));

    switch (screen) {
      case AckScreen.ROLES:
        roomPlayer.rolesSeen = true;
        break;
      case AckScreen.MISSION_RESULT:
        roomPlayer.pendingMissionResult = null;
        break;
      case AckScreen.GAME_END:
        roomPlayer.gameEndSeen = true;
        break;
    }

    await this.roomService.saveRoom(room);
    return room;
  }

  /** Persiste que o resultado da missão pendente do jogador já foi revelado (cards virados). */
  public async markMissionResultRevealed(player: PlayerSession): Promise<Room> {
    const room = await this.roomService.getRoom(player.roomCode!);
    const roomPlayer = room.gameState.players.find((p) => p.id === player.id);
    const round = room.gameState.rounds[roomPlayer?.pendingMissionResult ?? -1];

    if (round && !round.resultRevealed) {
      round.resultRevealed = true;
      await this.roomService.saveRoom(room);
    }
    return room;
  }

  private resolveMission(gameState: GameState) {
    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    let failedVotes = 0;
    Object.values(currentRound.missionVotes).forEach((v) => {
      currentRound.missionVoteResult.push(v);
      if (v === MissionVoteAction.FAIL) failedVotes++;
    });

    currentRound.failedVotesCount = failedVotes;
    gameState.players.forEach((p) => (p.pendingMissionResult = gameState.currentRoundIndex));

    if (failedVotes > 0) {
      currentRound.status = 'MISSION_FAILED';
      gameState.spyWins++;
    } else {
      currentRound.status = 'MISSION_SUCCESS';
      gameState.resistanceWins++;
    }
    this.checkWinCondition(gameState);
  }

  private checkWinCondition(gameState: GameState) {
    if (gameState.resistanceWins === 3 || gameState.spyWins === 3) {
      gameState.phase = GamePhase.FINISHED;
    } else {
      this.startNewRound(gameState);
    }
  }
}
