import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConvertIdeaDto } from './convert-idea.dto';

function base() {
  return {
    type: 'ALL_OR_NOTHING',
    tokenType: 'USDC',
    targetAmount: '5000.00',
    deadline: '2026-12-31T00:00:00Z',
    milestones: [
      { title: 'a', deliverable: 'x', tranchePct: 50, evidenceDefinition: {} },
      { title: 'b', deliverable: 'y', tranchePct: 50, evidenceDefinition: {} },
    ],
  };
}

describe('ConvertIdeaDto', () => {
  it('accepts an exact decimal string target, like the draft contract', async () => {
    const dto = plainToInstance(ConvertIdeaDto, base());

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a numeric target so money never enters through a float', async () => {
    const dto = plainToInstance(ConvertIdeaDto, {
      ...base(),
      targetAmount: 5000,
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'targetAmount')).toBe(true);
  });

  it.each(['0', '0.00'])('rejects the non-positive target %s', async (targetAmount) => {
    const dto = plainToInstance(ConvertIdeaDto, { ...base(), targetAmount });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'targetAmount')).toBe(true);
  });

  it('accepts the smallest positive target', async () => {
    const dto = plainToInstance(ConvertIdeaDto, {
      ...base(),
      targetAmount: '0.01',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
