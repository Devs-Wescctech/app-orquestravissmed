import { Controller, ExecutionContext, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

@Controller('test-only')
class TestController {
  @Get('restricted')
  @Roles(Role.SUPER_ADMIN)
  restricted() {}
}

describe('RolesGuard with real permission metadata', () => {
  const guard = new RolesGuard(new Reflector());
  const context = (roles: any[]) => ({
    getHandler: () => TestController.prototype.restricted,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
  }) as unknown as ExecutionContext;
  it('denies OPERATOR when a route explicitly requires SUPER_ADMIN', () => {
    expect(() => guard.canActivate(context([{ role: Role.OPERATOR }]))).toThrow(ForbiddenException);
  });
  it('allows the explicitly required role', () => {
    expect(guard.canActivate(context([{ role: Role.SUPER_ADMIN }]))).toBe(true);
  });
  it('denies a user without roles on a restricted route', () => {
    expect(() => guard.canActivate(context([]))).toThrow(ForbiddenException);
  });
});
