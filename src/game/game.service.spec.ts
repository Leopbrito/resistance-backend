import { RoomService } from '../room/room.service';
import { GamePhase, MissionVoteAction, Role, TeamVoteAction } from '../shared/enums';
import { Player, Room, Round } from '../shared/interfaces';
import { GameService } from './game.service';

describe('GameService offline actors', () => {
  let service: GameService;
  let room: Room;
  let round: Round;

  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];

  const makePlayer = (id: string): Player => ({
    id,
    name: id,
    isHost: id === 'p1',
    socketId: `sock-${id}`,
    roomCode: 'ABCD-1234',
    connected: true,
    role: Role.RESISTANCE,
    isLeader: id === 'p1',
  });

  const setOffline = (...offline: string[]) =>
    room.gameState.players.forEach((p) => (p.connected = !offline.includes(p.id)));

  beforeEach(() => {
    round = {
      roundNumber: 1,
      leaderId: 'p1',
      teamSize: 2,
      selectedTeam: [],
      teamVotes: {},
      missionVotes: {},
      missionVoteResult: [],
      status: 'PENDING',
    };
    room = {
      code: 'ABCD-1234',
      hostId: 'p1',
      gameState: {
        phase: GamePhase.TEAM_SELECTION,
        me: null,
        players: ids.map(makePlayer),
        resistanceWins: 0,
        spyWins: 0,
        rounds: [round],
        currentRoundIndex: 0,
        failedTeamsInRow: 0,
      },
    };

    const roomService = {
      getRoom: jest.fn(async () => room),
      saveRoom: jest.fn(),
    } as unknown as RoomService;
    service = new GameService(roomService);
  });

  describe('getPendingOfflineActorId', () => {
    it('returns nothing while the actor is online', () => {
      expect(service.getPendingOfflineActorId(room.gameState)).toBeUndefined();
    });

    it('returns the offline leader during team selection', () => {
      setOffline('p1');
      expect(service.getPendingOfflineActorId(room.gameState)).toBe('p1');
    });

    it('returns the offline voter whose turn it is', () => {
      room.gameState.phase = GamePhase.VOTING;
      round.currentTeamVoterId = 'p2';
      setOffline('p3');
      expect(service.getPendingOfflineActorId(room.gameState)).toBeUndefined();

      setOffline('p2');
      expect(service.getPendingOfflineActorId(room.gameState)).toBe('p2');
    });

    it('returns an offline team member that has not voted on the mission', () => {
      room.gameState.phase = GamePhase.MISSION;
      round.selectedTeam = ['p2', 'p3'];
      round.missionVotes = { p2: MissionVoteAction.SUCCESS };
      setOffline('p2', 'p3');
      expect(service.getPendingOfflineActorId(room.gameState)).toBe('p3');
    });
  });

  describe('skipOfflineActor', () => {
    it('does nothing when the expected actor is no longer pending', async () => {
      expect(await service.skipOfflineActor('ABCD-1234', 'p1', jest.fn())).toBeNull();
    });

    it('rotates the leader without counting a rejected team', async () => {
      setOffline('p1');
      round.selectedTeam = ['p2'];

      await service.skipOfflineActor('ABCD-1234', 'p1', jest.fn());

      expect(round.leaderId).toBe('p2');
      expect(round.selectedTeam).toEqual([]);
      expect(room.gameState.failedTeamsInRow).toBe(0);
      expect(room.gameState.phase).toBe(GamePhase.TEAM_SELECTION);
    });

    it('skips the offline voter and passes the turn on', async () => {
      room.gameState.phase = GamePhase.VOTING;
      round.selectedTeam = ['p1', 'p2'];
      round.teamVotes = { p1: TeamVoteAction.APPROVE };
      round.currentTeamVoterId = 'p2';
      setOffline('p2');

      await service.skipOfflineActor('ABCD-1234', 'p2', jest.fn());

      expect(round.skippedTeamVoters).toEqual(['p2']);
      expect(round.currentTeamVoterId).toBe('p3');
      expect(room.gameState.phase).toBe(GamePhase.VOTING);
    });

    it('resolves the vote ignoring skipped voters when the last voter is offline', async () => {
      room.gameState.phase = GamePhase.VOTING;
      round.selectedTeam = ['p1', 'p2'];
      round.teamVotes = {
        p1: TeamVoteAction.APPROVE,
        p2: TeamVoteAction.APPROVE,
        p3: TeamVoteAction.REJECT,
        p4: TeamVoteAction.APPROVE,
      };
      round.currentTeamVoterId = 'p5';
      setOffline('p5');

      await service.skipOfflineActor('ABCD-1234', 'p5', jest.fn());

      expect(round.status).toBe('TEAM_APPROVED');
      expect(room.gameState.phase).toBe(GamePhase.MISSION);
    });

    it('submits SUCCESS for an offline mission member and resolves the mission', async () => {
      room.gameState.phase = GamePhase.MISSION;
      round.selectedTeam = ['p2', 'p3'];
      round.missionVotes = { p2: MissionVoteAction.SUCCESS };
      setOffline('p3');
      const onResolved = jest.fn();

      await service.skipOfflineActor('ABCD-1234', 'p3', onResolved);

      expect(onResolved).toHaveBeenCalled();
      expect(round.status).toBe('MISSION_SUCCESS');
      expect(room.gameState.resistanceWins).toBe(1);
    });
  });
});
