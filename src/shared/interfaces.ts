import { Role, GamePhase, TeamVoteAction, MissionVoteAction } from './enums';

export interface Player {
  id: string;
  socketId: string;
  name: string;
  isHost: boolean;
  roomCode?: string;
  role?: Role;
  isLeader?: boolean;
  connected?: boolean;
}

export interface Round {
  roundNumber: number; // 1 to 5
  leaderId: string;
  teamSize: number;
  selectedTeam: string[];
  teamVotes: Record<string, TeamVoteAction>;
  missionVotes: Record<string, MissionVoteAction>;
  status: 'PENDING' | 'TEAM_APPROVED' | 'TEAM_REJECTED' | 'MISSION_SUCCESS' | 'MISSION_FAILED';
  failedVotesCount?: number;
}

export interface GameState {
  phase: GamePhase;
  me: Player | null;
  players: Player[];
  resistanceWins: number;
  spyWins: number;
  rounds: Round[];
  currentRoundIndex: number; // 0 to 4
  failedTeamsInRow: number; // Se chegar a 5, espiões vencem (regra opcional, mas boa para se ter)
}

export interface Room {
  code: string;
  hostId: string;
  gameState: GameState;
}
