import { Injectable, BadRequestException } from '@nestjs/common';
import { RoomService } from '../room/room.service';
import { Role, GamePhase, TeamVoteAction, MissionVoteAction } from '../shared/enums';
import { Room, GameState, Player, Round } from '../shared/interfaces';

@Injectable()
export class GameService {
  // Configuração padrão do Resistance: (Tamanho do time por rodada com base em N jogadores)
  private readonly teamSizeConfigs: Record<number, number[]> = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5],
  };

  // Quantidade de espiões por N jogadores
  private readonly spyConfigs: Record<number, number> = {
    5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4
  };

  constructor(private readonly roomService: RoomService) {}

  startGame(roomCode: string, socketId: string): Room {
    const room = this.roomService.getRoom(roomCode);

    if (room.hostSocketId !== socketId) {
      throw new BadRequestException('Apenas o criador da sala pode iniciar o jogo');
    }

    const { players } = room.gameState;
    const playerCount = players.length;

    if (playerCount < 5 || playerCount > 10) {
      throw new BadRequestException('The Resistance requer 5 a 10 jogadores');
    }

    if (room.gameState.phase !== GamePhase.WAITING) {
      throw new BadRequestException('Partida já foi iniciada');
    }

    this.assignRoles(players);
    this.startNewRound(room.gameState);
    
    // Armazena quem são os espiões para retornar facilmente pro Client dps
    room.gameState.spyPlayers = players.filter(p => p.role === Role.SPY).map(p => p.socketId);

    return room;
  }

  private assignRoles(players: Player[]) {
    const spyCount = this.spyConfigs[players.length];
    
    // Reseta todos para Resistance e remove líder
    players.forEach(p => {
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
    const currentLeaderIndex = gameState.players.findIndex(p => p.isLeader);
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
    const requiredTeamSize = this.teamSizeConfigs[totalPlayersCount][roundNumber - 1];

    const newRound: Round = {
      roundNumber,
      leaderSocketId: newLeader.socketId,
      teamSize: requiredTeamSize,
      selectedTeam: [],
      teamVotes: {},
      missionVotes: {},
      status: 'PENDING'
    };

    gameState.rounds.push(newRound);
    gameState.currentRoundIndex = gameState.rounds.length - 1;
    gameState.phase = GamePhase.TEAM_SELECTION;
  }

  selectTeam(roomCode: string, socketId: string, selectedPlayers: string[]): Room {
    const room = this.roomService.getRoom(roomCode);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.TEAM_SELECTION) {
      throw new BadRequestException('Jogo não está na fase de seleção de time');
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (currentRound.leaderSocketId !== socketId) {
      throw new BadRequestException('Apenas o líder pode escolher a equipe');
    }

    if (selectedPlayers.length !== currentRound.teamSize) {
      throw new BadRequestException(`Necessário selecionar exatamente ${currentRound.teamSize} jogadores`);
    }

    // Valida se os escolhidos existem na sala
    selectedPlayers.forEach(selectedId => {
      if (!gameState.players.find(p => p.socketId === selectedId)) {
        throw new BadRequestException('Jogador selecionado inválido');
      }
    });

    currentRound.selectedTeam = selectedPlayers;
    gameState.phase = GamePhase.VOTING;

    return room;
  }

  voteTeam(roomCode: string, socketId: string, vote: TeamVoteAction): Room {
    const room = this.roomService.getRoom(roomCode);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.VOTING) {
      throw new BadRequestException('Fase incorreta. A votação do time não está ativa.');
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];
    
    if (currentRound.teamVotes[socketId]) {
      throw new BadRequestException('Você já enviou seu voto');
    }

    currentRound.teamVotes[socketId] = vote;

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

    Object.values(currentRound.teamVotes).forEach(v => {
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
    
    const currentLeaderIndex = gameState.players.findIndex(p => p.isLeader);
    gameState.players[currentLeaderIndex].isLeader = false;
    
    const nextLeaderIndex = (currentLeaderIndex + 1) % totalPlayersCount;
    gameState.players[nextLeaderIndex].isLeader = true;

    // Limpa estado para nova tentativa de seleção
    currentRound.leaderSocketId = gameState.players[nextLeaderIndex].socketId;
    currentRound.selectedTeam = [];
    currentRound.teamVotes = {};
    currentRound.status = 'PENDING';
    
    gameState.phase = GamePhase.TEAM_SELECTION;
  }

  submitMissionVote(roomCode: string, socketId: string, vote: MissionVoteAction): Room {
    const room = this.roomService.getRoom(roomCode);
    const { gameState } = room;

    if (gameState.phase !== GamePhase.MISSION) {
      throw new BadRequestException('A fase não é a de Missão.');
    }

    const currentRound = gameState.rounds[gameState.currentRoundIndex];

    if (!currentRound.selectedTeam.includes(socketId)) {
      throw new BadRequestException('Apenas a equipe escalada pode realizar a missão');
    }

    if (currentRound.missionVotes[socketId]) {
      throw new BadRequestException('Você já executou sua parte da missão');
    }

    // Regra The Resistance: Resistência DEVE votar SUCESSO. Somente espiões podem escolher.
    const player = gameState.players.find(p => p.socketId === socketId);
    if (!player) {
      throw new BadRequestException('Jogador não encontrado');
    }
    if (player.role === Role.RESISTANCE && vote === MissionVoteAction.FAIL) {
      throw new BadRequestException('A Resistência não pode sabotar uma missão.');
    }

    currentRound.missionVotes[socketId] = vote;

    // Se todos votaram na missão
    const totalMissionVotes = Object.keys(currentRound.missionVotes).length;
    if (totalMissionVotes === currentRound.teamSize) {
      this.resolveMission(gameState);
    }

    return room;
  }

  private resolveMission(gameState: GameState) {
    const currentRound = gameState.rounds[gameState.currentRoundIndex];
    
    let failedVotes = 0;
    Object.values(currentRound.missionVotes).forEach(v => {
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
