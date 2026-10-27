import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/redis/redis.service';
import { GamePhase, MissionVoteAction, SocketEvent, TeamVoteAction, AckScreen } from '../src/shared/enums';
import { GameState } from '../src/shared/interfaces';

// Redis em memória: o e2e valida o fluxo de sockets sem depender de infraestrutura
class InMemoryRedisService {
  private store = new Map<string, string>();

  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
    return 'OK';
  }
  async getJson<T>(key: string): Promise<T | null> {
    const data = this.store.get(key);
    return data ? (JSON.parse(data) as T) : null;
  }
  async setJson<T>(key: string, value: T) {
    return this.set(key, JSON.stringify(value));
  }
  async del(...keys: string[]) {
    keys.forEach((k) => this.store.delete(k));
    return keys.length;
  }
  async expire() {
    return 1;
  }
  async exists(key: string) {
    return this.store.has(key);
  }
  async keys(pattern: string) {
    const prefix = pattern.replace('*', '');
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

interface TestClient {
  name: string;
  playerId: string;
  socket: Socket;
  state?: GameState;
  events: string[];
}

const until = async (condition: () => boolean, label: string, timeoutMs = 3000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

describe('Reconnection flow (e2e)', () => {
  let app: INestApplication;
  let url: string;
  let clients: TestClient[];

  const connect = (client: Pick<TestClient, 'name' | 'playerId'>): TestClient => {
    const socket = io(url, { transports: ['websocket'], auth: { playerId: client.playerId }, forceNew: true });
    const testClient: TestClient = { ...client, socket, events: [] };
    [SocketEvent.GAME_STATE_UPDATE, SocketEvent.RECONNECT].forEach((event) =>
      socket.on(event, (state: GameState) => {
        testClient.state = state;
        testClient.events.push(event);
      }),
    );
    [SocketEvent.SESSION_REPLACED, SocketEvent.SESSION_INVALID].forEach((event) =>
      socket.on(event, () => testClient.events.push(event)),
    );
    return testClient;
  };

  const countEvents = (client: TestClient, event: string) => client.events.filter((e) => e === event).length;

  // Refresh: o socket novo conecta antes do antigo cair, o pior caso do race
  const refresh = async (index: number) => {
    const old = clients[index];
    const reconnectsBefore = clients.map((c) => countEvents(c, SocketEvent.RECONNECT));
    const fresh = connect(old);
    clients[index] = fresh;

    await until(() => countEvents(fresh, SocketEvent.RECONNECT) === 1, `${fresh.name} RECONNECT`);
    await until(() => countEvents(old, SocketEvent.SESSION_REPLACED) === 1, `${old.name} SESSION_REPLACED`);
    old.socket.close();
    // dá tempo ao disconnect antigo chegar ao servidor
    await new Promise((resolve) => setTimeout(resolve, 100));

    clients.forEach((c, i) => {
      if (i !== index) expect(countEvents(c, SocketEvent.RECONNECT)).toBe(reconnectsBefore[i]);
    });
    return fresh;
  };

  const leader = () => clients.find((c) => c.state?.me?.isLeader)!;
  const round = (client: TestClient) => client.state!.rounds[client.state!.currentRoundIndex];

  const voteTeamUntilResolved = async () => {
    await until(() => leader().state!.phase === GamePhase.VOTING, 'VOTING');
    for (let i = 0; i < clients.length; i++) {
      await until(() => !!round(leader()).currentTeamVoterId || leader().state!.phase !== GamePhase.VOTING, 'voter');
      const voterId = round(leader()).currentTeamVoterId;
      if (!voterId) break;
      clients
        .find((c) => c.playerId === voterId)!
        .socket.emit(SocketEvent.VOTE_TEAM_APPROVAL, {
          vote: TeamVoteAction.APPROVE,
        });
      await until(() => round(leader()).currentTeamVoterId !== voterId, 'next voter');
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue(new InMemoryRedisService())
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    url = await app.getUrl().then((u) => u.replace('[::1]', 'localhost'));
  });

  afterAll(async () => {
    clients?.forEach((c) => c.socket.close());
    await app.close();
  });

  it('restores each player to the right point of the game without disturbing the others', async () => {
    // Sala com 5 jogadores
    const host = connect({ name: 'host', playerId: '' });
    const created = await host.socket.emitWithAck(SocketEvent.CREATE_ROOM, { playerName: 'host' });
    host.playerId = created.playerId;
    clients = [host];

    for (const name of ['ana', 'bia', 'caio', 'dani']) {
      const guest = connect({ name, playerId: '' });
      const joined = await guest.socket.emitWithAck(SocketEvent.JOIN_ROOM, {
        playerName: name,
        roomCode: created.roomCode,
      });
      guest.playerId = joined.playerId;
      clients.push(guest);
    }

    host.socket.emit(SocketEvent.START_GAME, {});
    await until(() => clients.every((c) => c.state?.phase === GamePhase.TEAM_SELECTION), 'game started');

    // 1) Refresh logo após começar: papel ainda não visto
    let ana = await refresh(1);
    expect(ana.state!.phase).toBe(GamePhase.TEAM_SELECTION);
    expect(ana.state!.me!.rolesSeen).toBe(false);
    expect(ana.state!.me!.role).toBeDefined();

    // 2) Ack persiste entre refreshes
    ana.socket.emit(SocketEvent.ACK_SCREEN, { screen: AckScreen.ROLES });
    await until(() => ana.state!.me!.rolesSeen === true, 'roles ack');
    ana = await refresh(1);
    expect(ana.state!.me!.rolesSeen).toBe(true);

    // 3) Refresh durante a votação do time
    const teamSize = round(leader()).teamSize;
    const team = clients.slice(0, teamSize).map((c) => c.playerId);
    leader().socket.emit(SocketEvent.SUBMIT_SELECTED_MISSION_TEAM, { selectedPlayers: team });
    await until(() => leader().state!.phase === GamePhase.VOTING, 'VOTING');
    const voter = await refresh(2);
    expect(voter.state!.phase).toBe(GamePhase.VOTING);
    expect(round(voter).selectedTeam).toEqual(team);

    // 4) Refresh durante a missão
    await voteTeamUntilResolved();
    await until(() => leader().state!.phase === GamePhase.MISSION, 'MISSION');
    const memberIndex = clients.findIndex((c) => c.playerId === team[0]);
    const member = await refresh(memberIndex);
    expect(member.state!.phase).toBe(GamePhase.MISSION);

    // 5) Missão resolve; o resultado pendente sobrevive ao refresh até o ack
    for (const id of team) {
      clients
        .find((c) => c.playerId === id)!
        .socket.emit(SocketEvent.SUBMIT_MISSION_VOTE, {
          vote: MissionVoteAction.SUCCESS,
        });
    }
    await until(() => clients.every((c) => c.state!.me!.pendingMissionResult === 0), 'pending mission result');

    const after = await refresh(3);
    expect(after.state!.me!.pendingMissionResult).toBe(0);
    expect(after.state!.rounds[0].status).toBe('MISSION_SUCCESS');

    after.socket.emit(SocketEvent.ACK_SCREEN, { screen: AckScreen.MISSION_RESULT });
    await until(() => after.state!.me!.pendingMissionResult === null, 'mission result ack');
    expect((await refresh(3)).state!.me!.pendingMissionResult).toBeNull();
  });

  it('tells a client with an unknown playerId that the session is invalid', async () => {
    const ghost = connect({ name: 'ghost', playerId: 'does-not-exist' });

    await until(() => countEvents(ghost, SocketEvent.SESSION_INVALID) === 1, 'SESSION_INVALID');
    ghost.socket.close();
  });
});
