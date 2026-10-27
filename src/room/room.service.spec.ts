import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '../redis/redis.service';
import { GamePhase } from '../shared/enums';
import { Player, Room } from '../shared/interfaces';
import { RoomService } from './room.service';
import { ErrorCode } from '../shared/error-codes';

describe('RoomService', () => {
  let service: RoomService;
  let redisService: jest.Mocked<RedisService>;

  beforeEach(async () => {
    const mockRedisService = {
      getJson: jest.fn(),
      setJson: jest.fn(),
      del: jest.fn(),
      expire: jest.fn(),
      exists: jest.fn(),
      keys: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<RoomService>(RoomService);
    redisService = module.get(RedisService);
  });

  const createMockHost = (): Player => ({
    id: 'host-1',
    name: 'Host Player',
    isHost: true,
    socketId: 'sock-host',
    connected: true,
  });

  it('should create a room and persist it to Redis', async () => {
    redisService.exists.mockResolvedValue(false);
    redisService.setJson.mockResolvedValue('OK');

    const host = createMockHost();
    const room = await service.createRoom(host);

    expect(room).toBeDefined();
    expect(room.code).toBeDefined();
    expect(room.hostId).toBe('host-1');
    expect(room.gameState.players).toHaveLength(1);
    expect(room.gameState.phase).toBe(GamePhase.WAITING);

    expect(redisService.setJson).toHaveBeenCalledWith(`room:${room.code}`, room, 7200);
  });

  it('should throw NotFoundException if room is not found in Redis', async () => {
    redisService.getJson.mockResolvedValue(null);

    await expect(service.getRoom('ABCD-1234')).rejects.toThrow(NotFoundException);
    await expect(service.getRoom('ABCD-1234')).rejects.toMatchObject({
      response: { code: ErrorCode.ROOM_NOT_FOUND },
    });
  });

  it('should get room and renew TTL in Redis', async () => {
    const mockRoom: Room = {
      code: 'ABCD-1234',
      hostId: 'host-1',
      gameState: {
        phase: GamePhase.WAITING,
        me: createMockHost(),
        players: [createMockHost()],
        resistanceWins: 0,
        spyWins: 0,
        rounds: [],
        currentRoundIndex: 0,
        failedTeamsInRow: 0,
      },
    };
    redisService.getJson.mockResolvedValue(mockRoom);
    redisService.expire.mockResolvedValue(1);

    const room = await service.getRoom('ABCD-1234');
    expect(room).toEqual(mockRoom);
    expect(redisService.expire).toHaveBeenCalledWith('room:ABCD-1234', 7200);
  });

  it('should join a room and save updated state', async () => {
    const host = createMockHost();
    const mockRoom: Room = {
      code: 'ABCD-1234',
      hostId: host.id,
      gameState: {
        phase: GamePhase.WAITING,
        me: host,
        players: [host],
        resistanceWins: 0,
        spyWins: 0,
        rounds: [],
        currentRoundIndex: 0,
        failedTeamsInRow: 0,
      },
    };
    redisService.getJson.mockResolvedValue(mockRoom);
    redisService.expire.mockResolvedValue(1);
    redisService.setJson.mockResolvedValue('OK');

    const newPlayer: Player = {
      id: 'p-2',
      name: 'Player 2',
      isHost: false,
      socketId: 'sock-2',
      roomCode: 'ABCD-1234',
      connected: true,
    };

    const updatedRoom = await service.joinRoom(newPlayer);
    expect(updatedRoom.gameState.players).toHaveLength(2);
    expect(redisService.setJson).toHaveBeenCalledWith('room:ABCD-1234', updatedRoom, 7200);
  });

  it('should not allow joining a room that already started', async () => {
    const host = createMockHost();
    const mockRoom: Room = {
      code: 'ABCD-1234',
      hostId: host.id,
      gameState: {
        phase: GamePhase.MISSION,
        me: host,
        players: [host],
        resistanceWins: 0,
        spyWins: 0,
        rounds: [],
        currentRoundIndex: 0,
        failedTeamsInRow: 0,
      },
    };
    redisService.getJson.mockResolvedValue(mockRoom);
    redisService.expire.mockResolvedValue(1);

    const newPlayer: Player = {
      id: 'p-2',
      name: 'Player 2',
      isHost: false,
      socketId: 'sock-2',
      roomCode: 'ABCD-1234',
    };

    await expect(service.joinRoom(newPlayer)).rejects.toThrow(BadRequestException);
    await expect(service.joinRoom(newPlayer)).rejects.toMatchObject({
      response: { code: ErrorCode.GAME_ALREADY_STARTED },
    });
  });
  describe('migrateHostIfOffline', () => {
    const makeRoom = (hostConnected: boolean, guestConnected: boolean): Room => ({
      code: 'ABCD-1234',
      hostId: 'host-1',
      gameState: {
        phase: GamePhase.TEAM_SELECTION,
        me: null,
        players: [
          { ...createMockHost(), connected: hostConnected },
          { ...createMockHost(), id: 'guest-1', isHost: false, connected: guestConnected },
        ],
        resistanceWins: 0,
        spyWins: 0,
        rounds: [],
        currentRoundIndex: 0,
        failedTeamsInRow: 0,
      },
    });

    it('passes the host role to a connected player when the host is offline', async () => {
      const room = makeRoom(false, true);

      expect(await service.migrateHostIfOffline(room)).toBe(true);
      expect(room.hostId).toBe('guest-1');
      expect(room.gameState.players.map((p) => p.isHost)).toEqual([false, true]);
    });

    it('keeps the host when still connected or when nobody else is online', async () => {
      expect(await service.migrateHostIfOffline(makeRoom(true, true))).toBe(false);
      expect(await service.migrateHostIfOffline(makeRoom(false, false))).toBe(false);
    });
  });

  describe('updatePlayer', () => {
    it('patches the player inside the room and saves it', async () => {
      const room: Room = {
        code: 'ABCD-1234',
        hostId: 'host-1',
        gameState: {
          phase: GamePhase.WAITING,
          me: null,
          players: [createMockHost()],
          resistanceWins: 0,
          spyWins: 0,
          rounds: [],
          currentRoundIndex: 0,
          failedTeamsInRow: 0,
        },
      };
      redisService.getJson.mockResolvedValue(room);

      const updated = await service.updatePlayer('ABCD-1234', 'host-1', { connected: false });

      expect(updated.gameState.players[0].connected).toBe(false);
      expect(redisService.setJson).toHaveBeenCalledWith('room:ABCD-1234', updated, 7200);
    });
  });
});
