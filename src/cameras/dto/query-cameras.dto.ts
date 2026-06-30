import { IsBooleanString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryCamerasDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() cc?: string;
  @IsOptional() @IsBooleanString() isLive?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 24;
  @IsOptional() @IsString() sort?: string;
}
