import { plainToInstance } from 'class-transformer';
import { ListIdeasQueryDto } from './idea.dto';

describe('ListIdeasQueryDto', () => {
  it.each([
    ['false', false],
    ['true', true],
    ['0', false],
    ['1', true],
  ])('parses mine=%p as %p', (input, expected) => {
    const dto = plainToInstance(ListIdeasQueryDto, { mine: input });

    expect(dto.mine).toBe(expected);
  });

  it('leaves an unrecognised value for the validator to reject', () => {
    const dto = plainToInstance(ListIdeasQueryDto, { mine: 'nope' });

    expect(dto.mine).toBe('nope');
  });
});
