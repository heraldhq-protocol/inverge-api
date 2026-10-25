import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { AnalyticsReadGuard } from './analytics-read.guard';

function setup(enabled: boolean) {
  const config = {
    get: jest.fn(() => enabled),
  } as unknown as ConfigService<Env, true>;
  return new AnalyticsReadGuard(config);
}

describe('AnalyticsReadGuard', () => {
  it('allows the read surface when enabled', () => {
    expect(setup(true).canActivate()).toBe(true);
  });

  it('hides the read surface when disabled', () => {
    // #given reports disabled by the operator
    // #when the guard runs
    // #then the route is indistinguishable from a missing one
    expect(() => setup(false).canActivate()).toThrow(NotFoundException);
  });
});
