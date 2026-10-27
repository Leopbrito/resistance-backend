import { IsString, IsNotEmpty, Length, IsEnum, IsArray } from 'class-validator';
import { ErrorCode } from './error-codes';
import { AckScreen, MissionVoteAction, TeamVoteAction } from './enums';

export class CreateRoomDto {
  @IsString()
  @IsNotEmpty()
  playerName: string;
}

export class JoinRoomDto {
  @IsString()
  @IsNotEmpty()
  @Length(9, 9, { message: ErrorCode.INVALID_ROOM_CODE })
  roomCode: string;

  @IsString()
  @IsNotEmpty()
  playerName: string;
}

export class SelectTeamDto {
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  selectedPlayers: string[]; // list of socketIds
}

export class VoteTeamDto {
  @IsEnum(TeamVoteAction)
  vote: TeamVoteAction;
}

export class MissionVoteDto {
  @IsEnum(MissionVoteAction)
  vote: MissionVoteAction;
}

export class AckScreenDto {
  @IsEnum(AckScreen)
  screen: AckScreen;
}
