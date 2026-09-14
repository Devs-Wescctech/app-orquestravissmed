import { Test } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
describe('UsersService', () => {
  let service: UsersService;
  let prisma: any;
  const user = { id: 'synthetic', email: 'test@example.invalid', password: 'synthetic-hash', roles: [] };
  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn().mockResolvedValue(user), findMany: jest.fn().mockResolvedValue([user]) } };
    const module = await Test.createTestingModule({ providers: [UsersService,
      { provide: PrismaService, useValue: prisma }] }).compile();
    service = module.get(UsersService);
  });
  it('provides the hash to internal authentication lookup by email', async () => {
    expect(await service.findByEmail(user.email)).toEqual(user);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: user.email } }));
  });
  it('removes password from profile without modifying the stored object', async () => {
    expect(await service.findById(user.id)).toEqual({ id: user.id, email: user.email, roles: [] });
    expect(user.password).toBe('synthetic-hash');
  });
  it('returns null for a missing profile', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    expect(await service.findById('missing')).toBeNull();
  });
  it('removes passwords from user listings', async () => {
    const result = await service.findAll();
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('password');
  });
  it('does not turn database failure into an empty successful listing', async () => {
    prisma.user.findMany.mockRejectedValue(new Error('synthetic database failure'));
    await expect(service.findAll()).rejects.toThrow('synthetic database failure');
  });
});
