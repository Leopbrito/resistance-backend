import { IsString, IsNotEmpty, Length, IsEnum, IsArray } from 'class-validator';
import { MissionVoteAction, TeamVoteAction } from './enums';

export class CreateRoomDto {
  @IsString()
  @IsNotEmpty()
  playerName: string;
}

export class JoinRoomDto {
  @IsString()
  @IsNotEmpty()
  @Length(9, 9, { message: 'Room code must be in format ABCD-1234' })
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
