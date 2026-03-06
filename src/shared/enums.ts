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
