import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '../redis/redis.service';
import { GamePhase } from '../shared/enums';
import { Player, Room } from '../shared/interfaces';
import { RoomService } from './room.service';

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
  });
});
