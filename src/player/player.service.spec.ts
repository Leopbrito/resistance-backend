import { Test, TestingModule } from '@nestjs/testing';
import { PlayerService } from './player.service';
import { RedisService } from '../redis/redis.service';
import { Player } from '../shared/interfaces';

describe('PlayerService', () => {
  let service: PlayerService;
  let redisService: jest.Mocked<RedisService>;

  beforeEach(async () => {
    const mockRedisService = {
      get: jest.fn(),
      set: jest.fn(),
      getJson: jest.fn(),
      setJson: jest.fn(),
      del: jest.fn(),
      expire: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlayerService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<PlayerService>(PlayerService);
    redisService = module.get(RedisService);
  });

  it('should create and persist a player in Redis', async () => {
    redisService.setJson.mockResolvedValue('OK');
    redisService.set.mockResolvedValue('OK');

    const player = await service.createPlayer({
      name: 'Agent Cooper',
      isHost: true,
      socketId: 'sock-123',
    });

    expect(player).toBeDefined();
    expect(player.id).toBeDefined();
    expect(player.name).toBe('Agent Cooper');
    expect(player.isHost).toBe(true);
    expect(player.socketId).toBe('sock-123');
    expect(player.connected).toBe(true);

    expect(redisService.setJson).toHaveBeenCalledWith(`player:${player.id}`, player, 7200);
    expect(redisService.set).toHaveBeenCalledWith('socket_player:sock-123', player.id, 7200);
  });

  it('should retrieve player by playerId', async () => {
    const mockPlayer: Player = {
      id: 'p-1',
      name: 'Agent Mulder',
      isHost: false,
      socketId: 'sock-456',
      connected: true,
    };
    redisService.getJson.mockResolvedValue(mockPlayer);

    const result = await service.getPlayer('p-1');
    expect(redisService.getJson).toHaveBeenCalledWith('player:p-1');
    expect(result).toEqual(mockPlayer);
  });

  it('should retrieve player by socketId', async () => {
    const mockPlayer: Player = {
      id: 'p-1',
      name: 'Agent Mulder',
      isHost: false,
      socketId: 'sock-456',
      connected: true,
    };
    redisService.get.mockResolvedValue('p-1');
    redisService.getJson.mockResolvedValue(mockPlayer);

    const result = await service.getPlayerBySocketId('sock-456');
    expect(redisService.get).toHaveBeenCalledWith('socket_player:sock-456');
    expect(redisService.getJson).toHaveBeenCalledWith('player:p-1');
    expect(result).toEqual(mockPlayer);
  });

  it('should return null when socketId is not found', async () => {
    redisService.get.mockResolvedValue(null);

    const result = await service.getPlayerBySocketId('sock-unknown');
    expect(result).toBeNull();
  });

  it('should remove player and socket mapping', async () => {
    const mockPlayer: Player = {
      id: 'p-1',
      name: 'Agent Mulder',
      isHost: false,
      socketId: 'sock-456',
      connected: true,
    };
    redisService.getJson.mockResolvedValue(mockPlayer);
    redisService.del.mockResolvedValue(2);

    await service.removePlayer('p-1');
    expect(redisService.del).toHaveBeenCalledWith('player:p-1', 'socket_player:sock-456');
  });

  it('should renew the TTL of player and socket keys on access', async () => {
    const stored = { id: 'p1', socketId: 'sock-1', name: 'A', isHost: false } as Player;
    redisService.getJson.mockResolvedValue(stored);

    await service.getPlayer('p1');

    expect(redisService.expire).toHaveBeenCalledWith('player:p1', 7200);
    expect(redisService.expire).toHaveBeenCalledWith('socket_player:sock-1', 7200);
  });

  it('should not renew anything for an unknown player', async () => {
    redisService.getJson.mockResolvedValue(null);

    expect(await service.getPlayer('ghost')).toBeNull();
    expect(redisService.expire).not.toHaveBeenCalled();
  });
});
