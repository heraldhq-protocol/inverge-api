import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCreatorProfileDto } from './update-creator-profile.dto';

async function avatarIssues(avatarUrl: unknown) {
  const dto = plainToInstance(UpdateCreatorProfileDto, { avatarUrl });
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'avatarUrl');
}

describe('UpdateCreatorProfileDto.avatarUrl', () => {
  it('#given an uploaded asset reference #then it is accepted', async () => {
    expect(
      await avatarIssues('/api/media/clx0mediaasset0001abcdef'),
    ).toHaveLength(0);
  });

  it('#given an https image #then it is accepted', async () => {
    expect(
      await avatarIssues('https://lh3.googleusercontent.com/a/example=s96-c'),
    ).toHaveLength(0);
  });

  it('#given an empty value #then clearing the avatar is allowed', async () => {
    expect(await avatarIssues('')).toHaveLength(0);
  });

  it('#given a scheme other than https or a traversal path #then it is rejected', async () => {
    expect(await avatarIssues('javascript:alert(1)')).not.toHaveLength(0);
    expect(await avatarIssues('http://example.com/a.png')).not.toHaveLength(0);
    expect(await avatarIssues('/api/media/../../etc/passwd')).not.toHaveLength(0);
  });
});
