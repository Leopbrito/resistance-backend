export enum Role {
  RESISTANCE = 'RESISTANCE',
  SPY = 'SPY',
}

export enum MissionVoteAction {
  SUCCESS = 'SUCCESS',
  FAIL = 'FAIL',
}

export enum TeamVoteAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export enum GamePhase {
  WAITING = 'WAITING',
  TEAM_SELECTION = 'TEAM_SELECTION',
  VOTING = 'VOTING',
  MISSION = 'MISSION',
  FINISHED = 'FINISHED',
}

export enum SocketEvent {
  // Server to Client
  ERROR = 'error',
  GAME_STATE_UPDATE = 'gameStateUpdate',
  RECONNECT = 'reconnectGame',
  REVEAL_ROLES = 'revealRoles',
  REVEAL_MISSION_RESULT = 'revealMissionResult',

  // Client to Server
  CREATE_ROOM = 'createRoom',
  JOIN_ROOM = 'joinRoom',
  START_GAME = 'startGame',
  SELECT_MISSION_TEAM = 'selectMissionTeam',
  SUBMIT_SELECTED_MISSION_TEAM = 'submitSelectedMissionTeam',
  VOTE_TEAM_APPROVAL = 'voteTeamApproval',
  SUBMIT_MISSION_VOTE = 'submitMissionVote',
}
