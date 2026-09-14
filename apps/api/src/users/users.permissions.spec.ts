import request from 'supertest';
import { createAuthTestApp } from '../../test/helpers/auth-test-app';
// Acceptance tests intentionally remain failing while the API permits these actions.
// Database operations are mocked; no real users or clinics are accessed.
describe('Users administration permission boundary', () => {
  let s: Awaited<ReturnType<typeof createAuthTestApp>>;
  let token: string;
  beforeAll(async () => { s = await createAuthTestApp(); token = s.jwt.sign({ sub: s.user.id }); });
  afterAll(async () => { await s?.app.close(); });
  it('denies a non-administrative OPERATOR listing all users', async () => {
    const response = await request(s.app.getHttpServer()).get('/api/users').auth(token, { type: 'bearer' });
    expect({ status: response.status, databaseCalls: s.prisma.user.findMany.mock.calls.length })
      .toEqual({ status: 403, databaseCalls: 0 });
  });
  it('denies a non-administrative OPERATOR deleting another user', async () => {
    const response = await request(s.app.getHttpServer()).delete('/api/users/synthetic-other').auth(token, { type: 'bearer' });
    expect({ status: response.status, databaseCalls: s.prisma.user.delete.mock.calls.length })
      .toEqual({ status: 403, databaseCalls: 0 });
  });
});
