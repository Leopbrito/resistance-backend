import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT) || 6379;
    const password = process.env.REDIS_PASSWORD || undefined;

    this.client = new Redis({
      host,
      port,
      password,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
    });

    this.client.on('connect', () => {
      this.logger.log(`Connecting to Redis at ${host}:${port}...`);
    });

    this.client.on('ready', () => {
      this.logger.log('Redis client ready and connected');
    });

    this.client.on('error', (err) => {
      this.logger.warn(`Redis connection error: ${err.message}`);
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
    } catch (error) {
      this.logger.error(`Initial Redis connection failed: ${error.message}`);
    }
  }

  async onModuleDestroy() {
    try {
      await this.client.quit();
      this.logger.log('Redis client disconnected gracefully');
    } catch (error) {
      this.logger.error(`Error disconnecting Redis client: ${error.message}`);
    }
  }

  public getClient(): Redis {
    return this.client;
  }

  public async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  public async set(key: string, value: string, ttlSeconds?: number): Promise<'OK' | null> {
    if (ttlSeconds) {
      return this.client.set(key, value, 'EX', ttlSeconds);
    }
    return this.client.set(key, value);
  }

  public async getJson<T>(key: string): Promise<T | null> {
    const data = await this.client.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as T;
    } catch (err) {
      this.logger.error(`Failed to parse JSON for key "${key}": ${err.message}`);
      return null;
    }
  }

  public async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<'OK' | null> {
    const serialized = JSON.stringify(value);
    return this.set(key, serialized, ttlSeconds);
  }

  public async del(...keys: string[]): Promise<number> {
    const filtered = keys.filter(Boolean);
    if (filtered.length === 0) return 0;
    return this.client.del(...filtered);
  }

  public async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  public async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  public async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }
}
