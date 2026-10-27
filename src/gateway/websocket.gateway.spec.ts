import { GamePhase, Role, SocketEvent } from '../shared/enums';
import { GameService } from '../game/game.service';
import { PlayerService } from '../player/player.service';
import { RoomService } from '../room/room.service';
import { Player, Room } from '../shared/interfaces';
import { WebsocketGateway } from './websocket.gateway';

describe('WebsocketGateway reconnection', () => {
  let gateway: WebsocketGateway;
  let playerService: jest.Mocked<PlayerService>;
  let roomService: jest.Mocked<RoomService>;
  let emit: jest.Mock;
  let to: jest.Mock;
  let serverIn: jest.Mock;
  let inEmit: jest.Mock;
  let disconnectSockets: jest.Mock;

  const makePlayer = (id: string): Player => ({
    id,
    name: id,
    isHost: false,
    socketId: `sock-${id}`,
    roomCode: 'ABCD-1234',
    connected: true,
    role: Role.RESISTANCE,
  });

  let room: Room;

  const makeClient = (id: string, playerId?: string) =>
    ({
      id,
      join: jest.fn(),
      emit: jest.fn(),
      handshake: { auth: { playerId }, query: {} },
    }) as any;

  beforeEach(() => {
    jest.useFakeTimers();
    const players = ['p1', 'p2', 'p3'].map(makePlayer);
    room = {
      code: 'ABCD-1234',
      hostId: 'p1',
      gameState: {
        phase: GamePhase.TEAM_SELECTION,
        me: null,
        players: players.map((p) => ({ ...p })),
        resistanceWins: 0,
        spyWins: 0,
        rounds: [],
        currentRoundIndex: 0,
        failedTeamsInRow: 0,
      },
    };

    const socketOwners = new Map(players.map((p) => [p.socketId, p.id]));
    socketOwners.set('sock-new', 'p2');

    playerService = {
      getPlayer: jest.fn(async (id: string) => players.find((p) => p.id === id) ?? null),
      // Como no Redis, a chave do socket antigo continua apontando para o jogador até ser liberada
      getPlayerBySocketId: jest.fn(async (sid: string) => players.find((p) => socketOwners.get(sid) === p.id) ?? null),
      savePlayer: jest.fn(),
      releaseSocket: jest.fn(),
      removePlayer: jest.fn(),
    } as any;
    roomService = {
      getRoom: jest.fn(async () => room),
      saveRoom: jest.fn(),
      removePlayer: jest.fn(),
      migrateHostIfOffline: jest.fn(),
    } as any;

    gateway = new WebsocketGateway(
      roomService,
      { getPendingOfflineActorId: jest.fn() } as unknown as GameService,
      playerService,
    );
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    disconnectSockets = jest.fn();
    inEmit = jest.fn();
    serverIn = jest.fn(() => ({ emit: inEmit, disconnectSockets }));
    gateway.server = { to, in: serverIn } as any;
  });

  afterEach(() => jest.useRealTimers());

  const emittedTo = (event: string) => to.mock.calls.filter((_, i) => emit.mock.calls[i][0] === event).map((c) => c[0]);

  it('sends RECONNECT only to the reconnecting player', async () => {
    await gateway.handleConnection(makeClient('sock-new', 'p2'));

    expect(emittedTo(SocketEvent.RECONNECT)).toEqual(['sock-new']);
    expect(emittedTo(SocketEvent.GAME_STATE_UPDATE).sort()).toEqual(['sock-p1', 'sock-p3']);
  });

  it('releases the previous socket mapping on reconnection', async () => {
    await gateway.handleConnection(makeClient('sock-new', 'p2'));

    expect(playerService.releaseSocket).toHaveBeenCalledWith('sock-p2');
  });

  it('ignores the disconnect of a socket that was already replaced', async () => {
    const player = (await playerService.getPlayer('p2'))!;
    player.socketId = 'sock-new';

    await gateway.handleDisconnect(makeClient('sock-p2'));

    expect(player.connected).toBe(true);
    expect(playerService.savePlayer).not.toHaveBeenCalled();
    expect(playerService.releaseSocket).toHaveBeenCalledWith('sock-p2');
  });

  it('does not remove a player that reconnected before the grace period ends', async () => {
    await gateway.handleDisconnect(makeClient('sock-p2'));
    const player = (await playerService.getPlayer('p2'))!;
    expect(player.connected).toBe(false);

    player.connected = true;
    player.socketId = 'sock-new';
    await jest.advanceTimersByTimeAsync(60000);

    expect(roomService.removePlayer).not.toHaveBeenCalled();
    expect(playerService.removePlayer).not.toHaveBeenCalled();
  });

  it('keeps an offline player in a game in progress after the grace period', async () => {
    await gateway.handleDisconnect(makeClient('sock-p2'));

    await jest.advanceTimersByTimeAsync(60000);

    expect(roomService.removePlayer).not.toHaveBeenCalled();
    expect(playerService.removePlayer).not.toHaveBeenCalled();
  });

  it('removes an offline player from the lobby after the grace period', async () => {
    room.gameState.phase = GamePhase.WAITING;
    await gateway.handleDisconnect(makeClient('sock-p2'));

    await jest.advanceTimersByTimeAsync(60000);

    expect(roomService.removePlayer).toHaveBeenCalledWith('p2', 'ABCD-1234');
    expect(playerService.removePlayer).toHaveBeenCalledWith('p2');
  });

  it('replaces the previous socket of the same player', async () => {
    await gateway.handleConnection(makeClient('sock-new', 'p2'));

    expect(serverIn).toHaveBeenCalledWith('sock-p2');
    expect(inEmit).toHaveBeenCalledWith(SocketEvent.SESSION_REPLACED);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('tells the client the session is invalid when the player is unknown', async () => {
    const client = makeClient('sock-new', 'ghost');

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith(SocketEvent.SESSION_INVALID);
  });

  it('tells the client the session is invalid when the room expired', async () => {
    roomService.getRoom.mockRejectedValue(new Error('Room not found'));
    const client = makeClient('sock-new', 'p2');

    await gateway.handleConnection(client);

    expect(client.emit).toHaveBeenCalledWith(SocketEvent.SESSION_INVALID);
    expect(playerService.removePlayer).toHaveBeenCalledWith('p2');
  });

  it('tells the client the session is invalid when a game event comes from an unknown socket', async () => {
    playerService.getPlayerBySocketId.mockResolvedValue(null);
    const client = makeClient('sock-ghost');

    await gateway.handleStartGame(client);

    expect(client.emit).toHaveBeenCalledWith(SocketEvent.SESSION_INVALID);
  });
});
