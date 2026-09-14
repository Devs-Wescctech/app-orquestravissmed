import { BookingConflictsService } from './booking-conflicts.service';
import { BookingConflictsController } from './booking-conflicts.controller';
import { Test } from '@nestjs/testing';
import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import request from 'supertest';

const record = { id: 'target', clinicId: 'clinic-a', patientName: 'Paciente teste', patientSurname: null,
    startAt: new Date('2026-09-15T10:30:00Z'), endAt: new Date('2026-09-15T10:40:00Z'),
    vismedAppointmentId: 'source-a', doctoraliaFacilityId: 'facility', doctoraliaAddressId: 'address', doctoraliaDoctorId: 'doctor' };
const related = { ...record, id: 'related', doctoraliaBreakId: 'break', vismedAppointmentId: 'source-b',
    status: 'BOOKED', syncedToDoctoralia: true, syncError: null };
function setup() {
    const prisma: any = {
        bookingSync: { findFirst: jest.fn().mockResolvedValue(record), findMany: jest.fn().mockResolvedValue([]) },
        mapping: { findMany: jest.fn().mockResolvedValue([]) },
        integrationConnection: { findFirst: jest.fn().mockResolvedValue({ clientId: 'client', clientSecret: 'test-only' }) },
    };
    const remote = { getCalendarBreaks: jest.fn().mockResolvedValue({ _items: [] }) };
    const docplanner: any = { createClient: jest.fn().mockReturnValue(remote) };
    const limiter: any = { acquire: jest.fn().mockResolvedValue(undefined) };
    return { prisma, remote, docplanner, limiter, service: new BookingConflictsService(prisma, docplanner, limiter) };
}

describe('Booking conflict evidence (read-only)', () => {
    it('reports a remote overlap and exactly three other local associations', async () => {
        const s = setup();
        s.remote.getCalendarBreaks.mockResolvedValue({ _items: [{ id: 'break', since: '2026-09-15T07:30:00-03:00', till: '2026-09-15T07:40:00-03:00' }] });
        s.prisma.bookingSync.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([1, 2, 3].map(i => ({ ...related, id: `other-${i}` })));
        const result = await s.service.inspect('clinic-a', 'target');
        expect(result.availability).toBe('complete');
        expect(result.overlaps[0].relatedBookings).toHaveLength(3);
        expect(s.prisma.bookingSync.findMany.mock.calls[1][0].where).toMatchObject({ clinicId: 'clinic-a', id: { not: 'target' }, doctoraliaAddressId: 'address', doctoraliaDoctorId: 'doctor', doctoraliaFacilityId: 'facility' });
        expect(s.limiter.acquire).toHaveBeenCalledWith('doctoralia');
        expect(JSON.stringify(result)).not.toContain('test-only');
    });

    it('includes longer overlapping blocks and excludes adjacent intervals', async () => {
        const s = setup();
        s.remote.getCalendarBreaks.mockResolvedValue({ _items: [
            { id: 'long', since: '2026-09-15T07:00:00-03:00', till: '2026-09-15T09:00:00-03:00' },
            { id: 'adjacent', since: '2026-09-15T07:40:00-03:00', till: '2026-09-15T07:50:00-03:00' },
        ] });
        const result = await s.service.inspect('clinic-a', 'target');
        expect(result.overlaps).toHaveLength(1);
        expect(s.remote.getCalendarBreaks).toHaveBeenCalledWith('facility', 'doctor', 'address', '2026-09-15T00:00:00-03:00', '2026-09-16T00:00:00-03:00');
    });

    it('distinguishes a synchronized similar record with a different source ID', async () => {
        const s = setup();
        s.prisma.bookingSync.findMany.mockResolvedValueOnce([related]);
        const result = await s.service.inspect('clinic-a', 'target');
        expect(result.sameNameBookings[0]).toMatchObject({ id: 'related', synchronized: true });
        expect(s.prisma.bookingSync.findMany.mock.calls[0][0].where).toMatchObject({ patientName: record.patientName, startAt: record.startAt, endAt: record.endAt, vismedAppointmentId: { not: 'source-a' } });
    });

    it('recovers a missing address only from an unambiguous linked mapping in the same clinic', async () => {
        const s = setup();
        s.prisma.bookingSync.findFirst.mockResolvedValue({ ...record, doctoraliaAddressId: null });
        s.prisma.mapping.findMany.mockResolvedValue([{ conflictData: { facilityId: 'facility', address: { id: 'address' } } }]);
        expect((await s.service.inspect('clinic-a', 'target')).availability).toBe('complete');
        expect(s.prisma.mapping.findMany.mock.calls[0][0].where.clinicId).toBe('clinic-a');
    });

    it('does not guess between two addresses or call Doctoralia', async () => {
        const s = setup();
        s.prisma.bookingSync.findFirst.mockResolvedValue({ ...record, doctoraliaAddressId: null });
        s.prisma.mapping.findMany.mockResolvedValue(['a', 'b'].map(id => ({ conflictData: { facilityId: 'facility', address: { id } } })));
        expect((await s.service.inspect('clinic-a', 'target')).availability).toBe('unavailable');
        expect(s.remote.getCalendarBreaks).not.toHaveBeenCalled();
    });

    it('does not expose a record from another clinic', async () => {
        const s = setup(); s.prisma.bookingSync.findFirst.mockResolvedValue(null);
        await expect(s.service.inspect('clinic-b', 'target')).rejects.toThrow('não encontrado');
        expect(s.prisma.bookingSync.findFirst.mock.calls[0][0].where).toEqual({ id: 'target', clinicId: 'clinic-b' });
        expect(s.remote.getCalendarBreaks).not.toHaveBeenCalled();
    });

    it('marks pagination as partial, not a clean absence of blocks', async () => {
        const s = setup(); s.remote.getCalendarBreaks.mockResolvedValue({ _items: [], _links: { next: 'next-page' } } as any);
        expect((await s.service.inspect('clinic-a', 'target')).availability).toBe('partial');
    });

    it('reports failure without leaking upstream errors or claiming resolution', async () => {
        const s = setup(); s.remote.getCalendarBreaks.mockRejectedValue(new Error('secret upstream error'));
        const result = await s.service.inspect('clinic-a', 'target');
        expect(result.availability).toBe('unavailable');
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    it('rejects malformed remote intervals', async () => {
        const s = setup(); s.remote.getCalendarBreaks.mockResolvedValue({ _items: [{ id: 'bad', since: 'invalid', till: 'invalid' }] });
        expect((await s.service.inspect('clinic-a', 'target')).availability).toBe('unavailable');
    });
});

describe('Conflict endpoint clinic authorization', () => {
    const service: any = { inspect: jest.fn().mockResolvedValue({ availability: 'complete' }) };
    const controller = new BookingConflictsController(service);
    beforeEach(() => jest.clearAllMocks());
    it('rejects missing clinic and unauthorized user before reading data', () => {
        expect(() => controller.inspect({ user: { roles: [] } }, 'target', 'clinic-a')).toThrow();
        expect(() => controller.inspect({ user: { roles: [{ role: 'SUPER_ADMIN' }] } }, 'target', '')).toThrow();
        expect(service.inspect).not.toHaveBeenCalled();
    });
    it('allows a member of the requested clinic', async () => {
        await controller.inspect({ user: { roles: [{ clinicId: 'clinic-a' }] } }, 'target', 'clinic-a');
        expect(service.inspect).toHaveBeenCalledWith('clinic-a', 'target');
    });
});

describe('GET conflict-details HTTP contract', () => {
    let app: any;
    const service = { inspect: jest.fn() };
    beforeAll(async () => {
        const module = await Test.createTestingModule({ controllers: [BookingConflictsController],
            providers: [{ provide: BookingConflictsService, useValue: service }],
        }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
            const req = context.switchToHttp().getRequest();
            if (!req.headers.authorization) throw new UnauthorizedException();
            req.user = { roles: [{ clinicId: 'clinic-a' }] };
            return true;
        } }).compile();
        app = module.createNestApplication(); await app.init();
    });
    afterAll(async () => { await app.close(); });
    beforeEach(() => jest.clearAllMocks());
    it('requires authentication and clinic membership', async () => {
        await request(app.getHttpServer()).get('/booking-sync/records/target/conflict-details?clinicId=clinic-a').expect(401);
        await request(app.getHttpServer()).get('/booking-sync/records/target/conflict-details?clinicId=clinic-b').set('Authorization', 'test-session').expect(403);
        expect(service.inspect).not.toHaveBeenCalled();
    });
    it('returns scoped evidence over the documented route', async () => {
        service.inspect.mockResolvedValue({ checkedAt: '2026-09-14T15:00:00Z', availability: 'complete', overlaps: [], sameNameBookings: [] });
        const result = await request(app.getHttpServer()).get('/booking-sync/records/target/conflict-details?clinicId=clinic-a').set('Authorization', 'test-session').expect(200);
        expect(result.body.availability).toBe('complete');
        expect(service.inspect).toHaveBeenCalledWith('clinic-a', 'target');
    });
    it('returns 404 for records outside the requested scope', async () => {
        service.inspect.mockRejectedValue(new NotFoundException());
        await request(app.getHttpServer()).get('/booking-sync/records/missing/conflict-details?clinicId=clinic-a').set('Authorization', 'test-session').expect(404);
    });
});
