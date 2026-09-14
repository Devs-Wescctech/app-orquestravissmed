import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import * as bcrypt from 'bcryptjs';
import { AuthController } from '../../src/auth/auth.controller';
import { AuthService } from '../../src/auth/auth.service';
import { JwtStrategy } from '../../src/auth/jwt.strategy';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { UsersController } from '../../src/users/users.controller';
import { UsersService } from '../../src/users/users.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ClinicsController } from '../../src/clinics/clinics.controller';
import { ClinicsService } from '../../src/clinics/clinics.service';

export async function createAuthTestApp() {
  const secret = 'synthetic-local-tests-only-not-a-real-secret';
  const password = 'Synthetic-password-123';
  const user = { id: 'synthetic-user', email: 'synthetic@example.invalid', name: 'Synthetic User',
    active: true, password: await bcrypt.hash(password, 4),
    roles: [{ clinicId: 'synthetic-clinic', role: 'OPERATOR', clinic: { id: 'synthetic-clinic' } }] };
  const prisma = { user: {
    findUnique: jest.fn().mockImplementation(async ({ where }) =>
      where.id === user.id || where.email === user.email ? { ...user } : null),
    findMany: jest.fn().mockResolvedValue([user]),
    update: jest.fn().mockImplementation(async ({ data }) => ({ ...user, ...data })),
    create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'synthetic-new', ...data })),
    delete: jest.fn().mockResolvedValue({ id: 'synthetic-other', password: 'synthetic-hash' }),
  } };
  const clinics = {
    findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue({ id: 'synthetic-clinic' }),
    findByUser: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'synthetic-clinic' }),
    update: jest.fn().mockResolvedValue({ id: 'synthetic-clinic' }), remove: jest.fn().mockResolvedValue({ id: 'synthetic-clinic' }),
    addUser: jest.fn().mockResolvedValue({ role: 'OPERATOR' }), removeUser: jest.fn().mockResolvedValue({ id: 'synthetic-role' }),
    testIntegration: jest.fn().mockResolvedValue({ success: true }), testVismedIntegration: jest.fn().mockResolvedValue({ success: true }),
  };
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  let moduleRef;
  try {
    moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret, signOptions: { expiresIn: '5m' } })],
      controllers: [AuthController, UsersController, ClinicsController],
      providers: [AuthService, UsersService, JwtStrategy, JwtAuthGuard, RolesGuard,
        { provide: PrismaService, useValue: prisma }, { provide: ClinicsService, useValue: clinics }],
    }).compile();
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  return { app, prisma, clinics, user, password, jwt: moduleRef.get(JwtService) as JwtService,
    auth: moduleRef.get(AuthService) as AuthService };
}
