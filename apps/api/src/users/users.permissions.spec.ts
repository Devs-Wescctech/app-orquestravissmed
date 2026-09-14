import request from 'supertest';
import { createAuthTestApp } from '../../test/helpers/auth-test-app';

describe('Users administration permission boundary', () => {
  let s: Awaited<ReturnType<typeof createAuthTestApp>>;
  let token: string;
  beforeAll(async () => { s = await createAuthTestApp(); token = s.jwt.sign({ sub: s.user.id }); });
  afterAll(async () => { await s?.app.close(); });
  beforeEach(() => { jest.clearAllMocks(); s.user.active = true; setRole('OPERATOR'); });
  function setRole(role: string) { s.user.roles = role ? [{ clinicId: 'synthetic-clinic', role, clinic: { id: 'synthetic-clinic' } }] : []; }
  const operations = [
    ['get', '/api/users', {}], ['get', '/api/users/synthetic-other', {}],
    ['post', '/api/users', { name: 'New', email: 'new@example.invalid', password: 'test-password' }],
    ['put', '/api/users/synthetic-other', { name: 'New Name' }], ['delete', '/api/users/synthetic-other', {}],
  ] as const;
  it.each(['OPERATOR', 'CLINIC_ADMIN', 'READONLY', ''])('denies every administrative user route to role %s', async role => {
    setRole(role);
    for (const [method, path, body] of operations) {
      await request(s.app.getHttpServer())[method](path).auth(token, { type: 'bearer' }).send(body).expect(403);
    }
    expect(s.prisma.user.findMany).not.toHaveBeenCalled();
    expect(s.prisma.user.findUnique.mock.calls.every(([args]) => args.where.id === s.user.id)).toBe(true);
    expect(s.prisma.user.create).not.toHaveBeenCalled();
    expect(s.prisma.user.update).not.toHaveBeenCalled();
    expect(s.prisma.user.delete).not.toHaveBeenCalled();
  });
  it('permits Super Admin operations without exposing password hashes', async () => {
    setRole('SUPER_ADMIN');
    for (const [method, path, body] of operations) {
      const res = await request(s.app.getHttpServer())[method](path).auth(token, { type: 'bearer' }).send(body).expect(method === 'post' ? 201 : 200);
      if (res.body) expect(res.body).not.toHaveProperty('password');
    }
    expect(s.prisma.user.create).toHaveBeenCalledTimes(1);
    expect(s.prisma.user.update).toHaveBeenCalledTimes(1);
    expect(s.prisma.user.delete).toHaveBeenCalledTimes(1);
  });
  it('does not trust an administrative role forged inside a valid signed token or request', async () => {
    const forged = s.jwt.sign({ sub: s.user.id, roles: [{ role: 'SUPER_ADMIN' }] });
    await request(s.app.getHttpServer()).post('/api/users').auth(forged, { type: 'bearer' })
      .send({ name: 'New', email: 'new@example.invalid', password: 'test-password', role: 'SUPER_ADMIN', clinicId: 'other-clinic' }).expect(403);
    expect(s.prisma.user.create).not.toHaveBeenCalled();
  });
  it('uses current roles: an old token loses administration after revocation', async () => {
    setRole('SUPER_ADMIN');
    await request(s.app.getHttpServer()).get('/api/users').auth(token, { type: 'bearer' }).expect(200);
    setRole('OPERATOR');
    await request(s.app.getHttpServer()).get('/api/users').auth(token, { type: 'bearer' }).expect(403);
    expect(s.prisma.user.findMany).toHaveBeenCalledTimes(1);
  });
  it.each(['OPERATOR', 'CLINIC_ADMIN', 'READONLY', 'SUPER_ADMIN', ''])('preserves own profile access for %s', async role => {
    setRole(role);
    await request(s.app.getHttpServer()).get('/api/users/me/profile').auth(token, { type: 'bearer' }).expect(200);
    await request(s.app.getHttpServer()).put('/api/users/me/profile').auth(token, { type: 'bearer' }).send({ name: 'Own Name' }).expect(200);
  });
  it.each([{ roles: { create: { role: 'SUPER_ADMIN' } } }, { id: 'replacement' }, { clinicId: 'other' }, { active: 'true' }, { password: { set: 'x' } }])('rejects arbitrary user update fields and invalid types %j', async body => {
    setRole('SUPER_ADMIN');
    await request(s.app.getHttpServer()).put('/api/users/synthetic-other').auth(token, { type: 'bearer' }).send(body).expect(400);
    expect(s.prisma.user.update).not.toHaveBeenCalled();
  });
  it('prevents Super Admin from deleting or deactivating the current account', async () => {
    setRole('SUPER_ADMIN');
    await request(s.app.getHttpServer()).delete('/api/users/' + s.user.id).auth(token, { type: 'bearer' }).expect(400);
    await request(s.app.getHttpServer()).put('/api/users/' + s.user.id).auth(token, { type: 'bearer' }).send({ active: false }).expect(400);
    expect(s.prisma.user.delete).not.toHaveBeenCalled();
    expect(s.prisma.user.update).not.toHaveBeenCalled();
  });
  it('denies a disabled user login and use of an existing token', async () => {
    s.user.active = false;
    await request(s.app.getHttpServer()).post('/api/auth/login').send({ email: s.user.email, password: s.password }).expect(401);
    await request(s.app.getHttpServer()).get('/api/users/me/profile').auth(token, { type: 'bearer' }).expect(401);
  });
});
