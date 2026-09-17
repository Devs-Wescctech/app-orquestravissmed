import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { BookingSyncController } from './webhook.controller';
import { BookingSyncService } from './booking-sync.service';
import { BookingSafetySweepService } from './booking-safety-sweep.service';
import { QueueService } from './queue.service';
import { RateLimiterService } from './rate-limiter.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

const enabled = process.env.CONSULTATION_PG_TESTS === '1';
if (enabled) {
    const url = new URL(process.env.DATABASE_URL || '');
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/consultation_test') throw new Error('Disposable consultation_test database required');
}
(enabled ? describe : describe.skip)('consultation HTTP and persistence contract', () => {
    const prisma = new PrismaClient();
    const clinicId = `consultation-test-${randomUUID()}`;
    const foreignId = `${clinicId}-foreign`;
    let app: any;
    let service: any;
    let consultationId: string;
    beforeAll(async () => {
        const now = new Date('2030-01-01T12:00:00Z');
        for (const [index, tipo_servico] of ['Consulta', 'Exame', 'Procedimento', null].entries()) {
            const row = await prisma.bookingSync.create({ data: {
                clinicId, origin: 'VISMED', patientName: 'Synthetic fixture', startAt: now, endAt: now,
                vismedAppointmentId: `fixture-${index}`, doctoraliaBreakId: 'synthetic-shared-break',
                rawPayload: { tipo_servico },
            } });
            if (index === 0) consultationId = row.id;
        }
        await prisma.bookingSync.create({ data: { clinicId: foreignId, origin: 'VISMED',
            patientName: 'Synthetic foreign fixture', startAt: now, endAt: now, rawPayload: { tipo_servico: 'Consulta' } } });
        service = Object.create(BookingSyncService.prototype);
        service.prisma = prisma;
        service.onModuleInit = () => undefined;
        service.onModuleDestroy = () => undefined;
        const module = await Test.createTestingModule({ controllers: [BookingSyncController], providers: [
            { provide: BookingSyncService, useValue: service },
            { provide: PrismaService, useValue: prisma },
            ...[BookingSafetySweepService, QueueService, RateLimiterService].map(provide => ({ provide, useValue: {} })),
        ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
            const req = context.switchToHttp().getRequest();
            if (!req.headers.authorization) throw new UnauthorizedException();
            req.user = { roles: [{ clinicId }] };
            return true;
        } }).compile();
        app = module.createNestApplication(); await app.init();
    });
    afterAll(async () => {
        await app?.close();
        await prisma.bookingSync.deleteMany({ where: { clinicId: { in: [clinicId, foreignId] } } });
        await prisma.$disconnect();
    });
    it('keeps authentication and clinic isolation on both read routes', async () => {
        for (const route of ['records', 'stats']) {
            await request(app.getHttpServer()).get(`/booking-sync/${route}?clinicId=${clinicId}`).expect(401);
            await request(app.getHttpServer()).get(`/booking-sync/${route}?clinicId=${foreignId}`).set('Authorization', 'synthetic').expect(403);
        }
    });
    it('returns only consultations and matching statistics over HTTP', async () => {
        const rows = await request(app.getHttpServer()).get(`/booking-sync/records?clinicId=${clinicId}`).set('Authorization', 'synthetic').expect(200);
        expect(rows.body.map((r: any) => r.id)).toEqual([consultationId]);
        expect(rows.body[0].appointmentType).toBe('Consulta');
        const stats = await request(app.getHttpServer()).get(`/booking-sync/stats?clinicId=${clinicId}`).set('Authorization', 'synthetic').expect(200);
        expect(stats.body).toEqual({ total: 1, booked: 1, failed: 0, cancelled: 0 });
    });
    it('excludes new exams without creating database rows', async () => {
        expect(await service.upsertVismedAppointment(clinicId, { idpacienteagendamento: 'never-import', tipo_servico: 'Exame' })).toBe(false);
        expect(await prisma.bookingSync.count({ where: { clinicId } })).toBe(4);
    });
    it('quarantines reclassification without cancelling or losing the shared break', async () => {
        await service.upsertVismedAppointment(clinicId, { idpacienteagendamento: 'fixture-0', tipo_servico: 'Exame' });
        const saved = await prisma.bookingSync.findUniqueOrThrow({ where: { id: consultationId } });
        expect(saved.status).toBe('BOOKED');
        expect(saved.doctoraliaBreakId).toBe('synthetic-shared-break');
        expect(saved.rawPayload).toEqual({ idpacienteagendamento: 'fixture-0', tipo_servico: 'Exame' });
        expect(await service.getSyncStats(clinicId)).toEqual({ total: 0, booked: 0, failed: 0, cancelled: 0 });
    });
});
