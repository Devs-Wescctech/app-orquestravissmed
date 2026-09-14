import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createAuthTestApp } from '../../test/helpers/auth-test-app';
describe('UsersController HTTP with real guards', () => {
  let s: Awaited<ReturnType<typeof createAuthTestApp>>;
  let token: string;
  beforeAll(async () => { s = await createAuthTestApp(); token = s.jwt.sign({ sub: s.user.id }); });
  afterAll(async () => { await s?.app.close(); });
  beforeEach(() => jest.clearAllMocks());
  it.each(['get', 'post', 'put', 'delete'])('rejects unauthenticated %s without accessing user data', async method => {
    const path = method === 'put' || method === 'delete' ? '/api/users/synthetic-other' : '/api/users';
    await request(s.app.getHttpServer())[method](path).send({ name: 'Synthetic' }).expect(401);
    expect(s.prisma.user.findMany).not.toHaveBeenCalled();
    expect(s.prisma.user.create).not.toHaveBeenCalled();
    expect(s.prisma.user.update).not.toHaveBeenCalled();
    expect(s.prisma.user.delete).not.toHaveBeenCalled();
  });
  it('loads the authenticated own profile', async () => {
    const res = await request(s.app.getHttpServer()).get('/api/users/me/profile').auth(token, { type: 'bearer' }).expect(200);
    expect(res.body.id).toBe(s.user.id);
    expect(res.body).not.toHaveProperty('password');
  });
  it('updates own name and ignores a supplied target ID and role', async () => {
    const res = await request(s.app.getHttpServer()).put('/api/users/me/profile').auth(token, { type: 'bearer' })
      .send({ id: 'synthetic-other', name: '  Synthetic New Name  ', role: 'SUPER_ADMIN' }).expect(200);
    expect(s.prisma.user.update).toHaveBeenCalledWith({ where: { id: s.user.id }, data: { name: 'Synthetic New Name' } });
    expect(res.body).not.toHaveProperty('password');
  });
  it('rejects an empty name without changing the user', async () => {
    await request(s.app.getHttpServer()).put('/api/users/me/profile').auth(token, { type: 'bearer' }).send({ name: ' ' }).expect(400);
    expect(s.prisma.user.update).not.toHaveBeenCalled();
  });
  it('requires the correct current password', async () => {
    await request(s.app.getHttpServer()).put('/api/users/me/password').auth(token, { type: 'bearer' })
      .send({ currentPassword: 'wrong', newPassword: 'new-synthetic-password' }).expect(401);
    expect(s.prisma.user.update).not.toHaveBeenCalled();
  });
  it.each([{ currentPassword: 'old' }, { currentPassword: 'old', newPassword: '123' }])('rejects missing or short new password %j', async body => {
    await request(s.app.getHttpServer()).put('/api/users/me/password').auth(token, { type: 'bearer' }).send(body).expect(400);
    expect(s.prisma.user.update).not.toHaveBeenCalled();
  });
  it('stores a hash when changing own password', async () => {
    await request(s.app.getHttpServer()).put('/api/users/me/password').auth(token, { type: 'bearer' })
      .send({ currentPassword: s.password, newPassword: 'new-synthetic-password' }).expect(200, { success: true });
    const change = s.prisma.user.update.mock.calls[0][0];
    expect(change.where.id).toBe(s.user.id);
    expect(change.data.password).not.toBe('new-synthetic-password');
    expect(await bcrypt.compare('new-synthetic-password', change.data.password)).toBe(true);
  });
});
