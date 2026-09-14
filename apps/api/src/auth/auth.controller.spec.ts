import request from 'supertest';
import { createAuthTestApp } from '../../test/helpers/auth-test-app';
describe('AuthController HTTP with real authentication', () => {
  let s: Awaited<ReturnType<typeof createAuthTestApp>>;
  beforeAll(async () => { s = await createAuthTestApp(); });
  afterAll(async () => { await s?.app.close(); });
  it('logs in and signs a verifiable token without exposing the password', async () => {
    const res = await request(s.app.getHttpServer()).post('/api/auth/login')
      .send({ email: s.user.email, password: s.password }).expect(201);
    expect(s.jwt.verify(res.body.access_token)).toMatchObject({ sub: s.user.id, email: s.user.email });
    expect(res.body.user).toMatchObject({ id: s.user.id, roles: s.user.roles });
    expect(res.body.user).not.toHaveProperty('password');
  });
  it.each([
    { email: 'synthetic@example.invalid', password: 'wrong-password' },
    { email: 'missing@example.invalid', password: 'wrong-password' },
    { email: 'synthetic@example.invalid' }, { password: 'any-password' }, {},
  ])('rejects invalid or missing credentials %j', async body => {
    const res = await request(s.app.getHttpServer()).post('/api/auth/login').send(body).expect(401);
    expect(res.body).not.toHaveProperty('access_token');
  });
  it('returns the authenticated profile without the stored password', async () => {
    const res = await request(s.app.getHttpServer()).get('/api/auth/profile')
      .auth(s.jwt.sign({ sub: s.user.id }), { type: 'bearer' }).expect(200);
    expect(res.body.id).toBe(s.user.id);
    expect(res.body).not.toHaveProperty('password');
  });
  it.each(['missing', 'malformed', 'expired', 'wrong-signature', 'unknown-user'])('rejects %s authentication', async kind => {
    const tokens = {
      malformed: 'invalid-token',
      expired: s.jwt.sign({ sub: s.user.id }, { expiresIn: -1 }),
      'wrong-signature': s.jwt.sign({ sub: s.user.id }, { secret: 'another-synthetic-secret' }),
      'unknown-user': s.jwt.sign({ sub: 'unknown-synthetic-user' }),
    };
    const req = request(s.app.getHttpServer()).get('/api/auth/profile');
    if (kind !== 'missing') req.auth(tokens[kind], { type: 'bearer' });
    await req.expect(401);
  });
});
