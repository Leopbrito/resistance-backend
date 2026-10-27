import { BadRequestException, HttpException } from '@nestjs/common';

export enum ErrorCode {
  UNKNOWN = 'UNKNOWN',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INVALID_ROOM_CODE = 'INVALID_ROOM_CODE',
  ROOM_NOT_FOUND = 'ROOM_NOT_FOUND',
  ROOM_FULL = 'ROOM_FULL',
  GAME_ALREADY_STARTED = 'GAME_ALREADY_STARTED',
  PLAYER_ALREADY_IN_ROOM = 'PLAYER_ALREADY_IN_ROOM',
  PLAYER_NAME_TAKEN = 'PLAYER_NAME_TAKEN',
  PLAYER_NOT_IN_ROOM = 'PLAYER_NOT_IN_ROOM',
  NOT_HOST = 'NOT_HOST',
  INVALID_PLAYER_COUNT = 'INVALID_PLAYER_COUNT',
  NOT_TEAM_SELECTION_PHASE = 'NOT_TEAM_SELECTION_PHASE',
  NOT_LEADER = 'NOT_LEADER',
  INVALID_SELECTED_PLAYER = 'INVALID_SELECTED_PLAYER',
  INVALID_TEAM_SIZE = 'INVALID_TEAM_SIZE',
  NOT_VOTING_PHASE = 'NOT_VOTING_PHASE',
  NOT_YOUR_TURN_TO_VOTE = 'NOT_YOUR_TURN_TO_VOTE',
  ALREADY_VOTED = 'ALREADY_VOTED',
  NOT_MISSION_PHASE = 'NOT_MISSION_PHASE',
  NOT_ON_MISSION_TEAM = 'NOT_ON_MISSION_TEAM',
  MISSION_ALREADY_PERFORMED = 'MISSION_ALREADY_PERFORMED',
}

export interface ErrorPayload {
  code: ErrorCode;
  params?: Record<string, string | number>;
}

/** Payload de exceção que o front traduz via `errors.<code>`. */
export const errorPayload = (code: ErrorCode, params?: ErrorPayload['params']): ErrorPayload =>
  params ? { code, params } : { code };

/** Converte qualquer erro capturado no gateway no payload enviado ao cliente. */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null && 'code' in response) {
      return response as ErrorPayload;
    }
  }
  return { code: ErrorCode.UNKNOWN };
}

/** Usado como `exceptionFactory` do ValidationPipe para não vazar texto do class-validator. */
export const validationExceptionFactory = (errors: { constraints?: Record<string, string> }[]) => {
  const invalidRoomCode = errors.some((e) => Object.values(e.constraints ?? {}).includes(ErrorCode.INVALID_ROOM_CODE));
  return new BadRequestException(
    errorPayload(invalidRoomCode ? ErrorCode.INVALID_ROOM_CODE : ErrorCode.VALIDATION_FAILED),
  );
};
