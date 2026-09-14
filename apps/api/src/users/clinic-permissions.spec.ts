import request from 'supertest';
import { createAuthTestApp } from '../../test/helpers/auth-test-app';

describe('Clinic routes cannot bypass user administration permissions', () => {
  let s: Awaited<ReturnType<typeof createAuthTestApp>>;
  let token: string;
  beforeAll(async () => { s = await createAuthTestApp(); token = s.jwt.sign({ sub: s.user.id }); });
  afterAll(async () => { await s?.app.close(); });
  beforeEach(() => jest.clearAllMocks());
  const routes = [
    ['get', '/api/clinics', {}], ['get', '/api/clinics/other-clinic', {}],
    ['post', '/api/clinics', { name: 'Synthetic', users: { create: { userId: 'synthetic-user', role: 'SUPER_ADMIN' } } }],
    ['put', '/api/clinics/other-clinic', { name: 'Synthetic' }], ['delete', '/api/clinics/other-clinic', {}],
    ['post', '/api/clinics/other-clinic/users', { userId: 'synthetic-other', role: 'SUPER_ADMIN' }],
    ['delete', '/api/clinics/other-clinic/users/synthetic-other', {}],
    ['post', '/api/clinics/other-clinic/test-integration', {}], ['post', '/api/clinics/other-clinic/test-vismed', {}],
  ] as const;
  function setRole(role: string) { s.user.roles = role ? [{ clinicId: 'synthetic-clinic', role, clinic: { id: 'synthetic-clinic' } }] : []; }
  it.each(['OPERATOR', 'CLINIC_ADMIN', 'READONLY', ''])('denies alternate administrative routes for %s', async role => {
    setRole(role);
    for (const [method, path, body] of routes) {
      await request(s.app.getHttpServer())[method](path).auth(token, { type: 'bearer' }).send(body).expect(403);
    }
    for (const method of Object.values(s.clinics)) expect(method).not.toHaveBeenCalled();
  });
  it('allows administrative routes to Super Admin', async () => {
    setRole('SUPER_ADMIN');
    for (const [method, path, body] of routes) {
      await request(s.app.getHttpServer())[method](path).auth(token, { type: 'bearer' }).send(body).expect(method === 'post' ? 201 : 200);
    }
    expect(s.clinics.addUser).toHaveBeenCalledWith('other-clinic', 'synthetic-other', 'SUPER_ADMIN');
  });
  it.each(['OPERATOR', 'CLINIC_ADMIN', 'READONLY', 'SUPER_ADMIN', ''])('preserves own clinic selection for %s', async role => {
    setRole(role);
    await request(s.app.getHttpServer()).get('/api/clinics/my').auth(token, { type: 'bearer' }).expect(200);
    expect(s.clinics.findByUser).toHaveBeenCalledWith(s.user.id, s.user.roles);
    expect(s.clinics.findAll).not.toHaveBeenCalled();
  });
  it('does not make own-clinics route public', async () => {
    await request(s.app.getHttpServer()).get('/api/clinics/my').expect(401);
    expect(s.clinics.findByUser).not.toHaveBeenCalled();
  });
  it('rejects invalid role and self-demotion or self-unlink', async () => {
    setRole('SUPER_ADMIN');
    for (const body of [{ userId: 'synthetic-other', role: 'INVALID' }, { userId: s.user.id, role: 'OPERATOR' }]) {
      await request(s.app.getHttpServer()).post('/api/clinics/synthetic-clinic/users').auth(token, { type: 'bearer' }).send(body).expect(400);
    }
    await request(s.app.getHttpServer()).delete('/api/clinics/synthetic-clinic/users/' + s.user.id).auth(token, { type: 'bearer' }).expect(400);
    expect(s.clinics.addUser).not.toHaveBeenCalled();
    expect(s.clinics.removeUser).not.toHaveBeenCalled();
  });
});
