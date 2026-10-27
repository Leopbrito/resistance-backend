import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ErrorCode, errorPayload, toErrorPayload, validationExceptionFactory } from './error-codes';

describe('error-codes', () => {
  it('toErrorPayload returns code and params from Nest exceptions', () => {
    const error = new BadRequestException(errorPayload(ErrorCode.ROOM_FULL, { max: 10 }));
    expect(toErrorPayload(error)).toEqual({ code: ErrorCode.ROOM_FULL, params: { max: 10 } });
    expect(toErrorPayload(new NotFoundException(errorPayload(ErrorCode.ROOM_NOT_FOUND)))).toEqual({
      code: ErrorCode.ROOM_NOT_FOUND,
    });
  });

  it('toErrorPayload falls back to UNKNOWN for unexpected errors', () => {
    expect(toErrorPayload(new Error('boom'))).toEqual({ code: ErrorCode.UNKNOWN });
    expect(toErrorPayload(new BadRequestException('texto livre'))).toEqual({ code: ErrorCode.UNKNOWN });
  });

  it('validationExceptionFactory maps the room code constraint to INVALID_ROOM_CODE', () => {
    const error = validationExceptionFactory([{ constraints: { length: ErrorCode.INVALID_ROOM_CODE } }]);
    expect(toErrorPayload(error)).toEqual({ code: ErrorCode.INVALID_ROOM_CODE });
  });

  it('validationExceptionFactory uses VALIDATION_FAILED for other constraints', () => {
    const error = validationExceptionFactory([{ constraints: { isString: 'playerName must be a string' } }]);
    expect(toErrorPayload(error)).toEqual({ code: ErrorCode.VALIDATION_FAILED });
  });
});
