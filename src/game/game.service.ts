import { BadRequestException, Injectable } from '@nestjs/common';
import { TEAM_SIZE_MISSION_CONFIGS, TEAM_SIZE_SPY_CONFIGS } from 'src/config/game.config';
import { RoomService } from '../room/room.service';
import { GamePhase, MissionVoteAction, Role, TeamVoteAction } from '../shared/enums';
import { GameState, Player, Room, Round } from '../shared/interfaces';

@Injectable()
export class GameService {
  constructor(private readonly roomService: RoomService) {}

  public startGame(player: Player): Room {
    const room = this.roomService.getRoom(player.roomCode!);

    if (room.hostId !== player.id) {
      throw new BadRequestException('Apenas o criador da sala pode iniciar o jogo');
    }

    const { players } = room.gameState;
    const playerCount = players.length;

    if (playerCount < 5 || playerCount > 10) {
      throw new BadRequestException('The Resistance requer 5 a 10 jogadores');
    }

    if (
      room.gameState.phase === GamePhase.TEAM_SELECTION ||
      room.gameState.phase === GamePhase.VOTING ||
      room.gameState.phase === GamePhase.MISSION
    ) {
      throw new BadRequestException('Partida já foi iniciada');
    }

    this.resetGameState(room.gameState);
    this.assignRoles(players);
    this.startNewRound(room.gameState);

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
      status: 'PENDING',
    };

    gameState.rounds.push(newRound);
    gameState.currentRoundIndex = gameState.rounds.length - 1;
    gameState.phase = GamePhase.TEAM_SELECTION;
  }

  selectTeam(player: Player, selectedPlayers: string[]): Room {
    const room = this.roomService.getRoom(player.roomCode!);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.TEAM_SELECTION) {
      throw new BadRequestException('Jogo não está na fase de seleção de time');
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (currentRound.leaderId !== player.id) {
      throw new BadRequestException('Apenas o líder pode escolher a equipe');
    }

    selectedPlayers.forEach((selectedId) => {
      if (!gameState.players.find((p) => p.id === selectedId)) {
        throw new BadRequestException('Jogador selecionado inválido');
      }
    });

    currentRound.selectedTeam = selectedPlayers;

    return room;
  }

  submitSelectedMissionTeam(player: Player, selectedPlayers: string[]): Room {
    const room = this.roomService.getRoom(player.roomCode!);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.TEAM_SELECTION) {
      throw new BadRequestException('Jogo não está na fase de seleção de time');
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (currentRound.leaderId !== player.id) {
      throw new BadRequestException('Apenas o líder pode escolher a equipe');
    }

    if (selectedPlayers.length !== currentRound.teamSize) {
      throw new BadRequestException(`Necessário selecionar exatamente ${currentRound.teamSize} jogadores`);
    }

    selectedPlayers.forEach((selectedId) => {
      if (!gameState.players.find((p) => p.id === selectedId)) {
        throw new BadRequestException('Jogador selecionado inválido');
      }
    });

    currentRound.selectedTeam = selectedPlayers;
    gameState.phase = GamePhase.VOTING;

    return room;
  }

  voteTeam(player: Player, vote: TeamVoteAction): Room {
    const room = this.roomService.getRoom(player.roomCode!);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.VOTING) {
      throw new BadRequestException('Fase incorreta. A votação do time não está ativa.');
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (currentRound.teamVotes[player.id]) {
      throw new BadRequestException('Você já enviou seu voto');
    }

    currentRound.teamVotes[player.id] = vote;

    // Verifica se todos votaram
    const totalVotes = Object.keys(currentRound.teamVotes).length;
    if (totalVotes === gameState.players.length) {
      this.resolveTeamVotes(gameState);
    }

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
    currentRound.status = 'PENDING';

    gameState.phase = GamePhase.TEAM_SELECTION;
  }

  submitMissionVote(player: Player, vote: MissionVoteAction, resolveMissionResult: () => void): Room {
    const room = this.roomService.getRoom(player.roomCode!);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.MISSION) {
      throw new BadRequestException('A fase não é a de Missão.');
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (!currentRound.selectedTeam.includes(player.id)) {
      throw new BadRequestException('Apenas a equipe escalada pode realizar a missão');
    }

    if (currentRound.missionVotes[player.id]) {
      throw new BadRequestException('Você já executou sua parte da missão');
    }

    currentRound.missionVotes[player.id] = vote;

    const totalMissionVotes = Object.keys(currentRound.missionVotes).length;

    if (totalMissionVotes === currentRound.teamSize) {
      this.resolveMission(gameState);
      resolveMissionResult();
    }

    return room;
  }

  private resolveMission(gameState: GameState) {
    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    let failedVotes = 0;
    Object.values(currentRound.missionVotes).forEach((v) => {
      if (v === MissionVoteAction.FAIL) failedVotes++;
    });

    currentRound.failedVotesCount = failedVotes;

    // A missão requer apenas 1 FAIL pra falhar nas regras clássicas padrão The Resistance
    // (A não ser em 7+ jogadores e ronda 4, mas aqui não faremos essa exceção pra simplificar)
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
