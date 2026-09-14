import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
describe('AuthService', () => {
  let service: AuthService;
  let users: { findByEmail: jest.Mock };
  let jwt: { sign: jest.Mock };
  let stored: any;
  beforeEach(async () => {
    stored = { id: 'synthetic', name: 'Synthetic', email: 'test@example.invalid',
      password: await bcrypt.hash('test-password', 4), roles: [] };
    users = { findByEmail: jest.fn().mockResolvedValue(stored) };
    jwt = { sign: jest.fn().mockReturnValue('synthetic-token') };
    const module = await Test.createTestingModule({ providers: [AuthService,
      { provide: UsersService, useValue: users }, { provide: JwtService, useValue: jwt }] }).compile();
    service = module.get(AuthService);
  });
  it('validates the password hash and removes password from the result', async () => {
    const result = await service.validateUser(stored.email, 'test-password');
    expect(result).toMatchObject({ id: stored.id });
    expect(result).not.toHaveProperty('password');
    expect(stored.password).toBeDefined();
  });
  it('returns null for an incorrect password and issues no token', async () => {
    expect(await service.validateUser(stored.email, 'wrong')).toBeNull();
    expect(jwt.sign).not.toHaveBeenCalled();
  });
  it('rejects an unknown user', async () => {
    users.findByEmail.mockResolvedValue(null);
    await expect(service.validateUser('missing@example.invalid', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.sign).not.toHaveBeenCalled();
  });
  it('propagates database failure without issuing a token', async () => {
    users.findByEmail.mockRejectedValue(new Error('synthetic database failure'));
    await expect(service.validateUser(stored.email, 'test-password')).rejects.toThrow('synthetic database failure');
    expect(jwt.sign).not.toHaveBeenCalled();
  });
  it('limits token and response fields', async () => {
    const result = await service.login(stored);
    expect(jwt.sign).toHaveBeenCalledWith({ email: stored.email, sub: stored.id });
    expect(result.user).not.toHaveProperty('password');
    expect(result.access_token).toBe('synthetic-token');
  });
});
