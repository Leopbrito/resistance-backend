import { Role, GamePhase, TeamVoteAction, MissionVoteAction } from './enums';

export interface Player {
  socketId: string;
  name: string;
  role?: Role;
  isLeader: boolean;
  roomCode: string;
}

export interface Round {
  roundNumber: number; // 1 to 5
  leaderSocketId: string;
  teamSize: number;
  selectedTeam: string[]; // socketIds
  teamVotes: Record<string, TeamVoteAction>; // Mapping socketId -> Vote
  missionVotes: Record<string, MissionVoteAction>; // Mapping socketId -> Vote
  status: 'PENDING' | 'TEAM_APPROVED' | 'TEAM_REJECTED' | 'MISSION_SUCCESS' | 'MISSION_FAILED';
  failedVotesCount?: number;
}

export interface GameState {
  phase: GamePhase;
  players: Player[];
  resistanceWins: number;
  spyWins: number;
  rounds: Round[];
  currentRoundIndex: number; // 0 to 4
  failedTeamsInRow: number; // Se chegar a 5, espiões vencem (regra opcional, mas boa para se ter)
  spyPlayers?: string[]; // Para enviar apenas aos espiões
}

export interface Room {
  code: string;
  hostSocketId: string;
  gameState: GameState;
}
