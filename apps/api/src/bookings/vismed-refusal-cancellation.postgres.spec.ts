import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { VismedRefusalCancellation } from './vismed-refusal-cancellation';

// Explicit opt-in, restricted to the disposable test database. Never uses clinic credentials.
const enabled = process.env.REFUSAL_DB_TEST === '1';
if (enabled) {
    const url = new URL(process.env.DATABASE_URL || '');
    const disposableHost = url.hostname === 'orq-refusal-test-db' || (url.hostname === '127.0.0.1' && url.port === '55439');
    if (!disposableHost || url.pathname !== '/refusal_test') throw new Error('Disposable test database required');
}
(enabled ? describe : describe.skip)('Refusal receipt persistence in PostgreSQL', () => {
    const prisma = new PrismaService();
    const ids: string[] = [];
    afterAll(async () => {
        await prisma.auditLog.deleteMany({ where: { id: { in: ids.map(id => `vismed-refusal:${id}`) } } });
        await prisma.bookingSync.deleteMany({ where: { id: { in: ids } } });
        await prisma.$disconnect();
    });
    it('resumes from durable REQUESTED in a new service instance without repeating DELETE', async () => {
        const id = randomUUID(); ids.push(id);
        const record = await prisma.bookingSync.create({ data: {
            id, clinicId: 'refusal-test', vismedDoctorId: 'vm-test', origin: 'DOCTORALIA', patientName: 'Synthetic test',
            doctoraliaBookingId: id, doctoraliaFacilityId: 'f', doctoraliaDoctorId: 'd', doctoraliaAddressId: 'a',
            startAt: new Date('2026-10-01T13:00:00Z'), endAt: new Date('2026-10-01T13:30:00Z'),
        } });
        const client = { getBooking: jest.fn().mockResolvedValue({ id, status: 'booked', start_at: record.startAt.toISOString(), end_at: record.endAt.toISOString() }),
            cancelBooking: jest.fn().mockRejectedValue(new Error('timeout')) };
        const deps = { observedRefusal: true, confirmAbsent: async () => true, getClient: async () => client, signal: new AbortController().signal };
        await expect(new VismedRefusalCancellation(prisma).run(record, deps)).rejects.toThrow('não confirmou');
        expect((await prisma.auditLog.findUnique({ where: { id: `vismed-refusal:${id}` } }))?.details).toMatchObject({ state: 'REQUESTED' });
        const resumed = await prisma.bookingSync.findUniqueOrThrow({ where: { id } });
        await expect(new VismedRefusalCancellation(prisma).run(resumed, { ...deps, observedRefusal: false })).rejects.toThrow('não será repetido');
        client.getBooking.mockResolvedValue({ id, status: 'cancelled', start_at: record.startAt.toISOString(), end_at: record.endAt.toISOString() });
        await new VismedRefusalCancellation(prisma).run(resumed, { ...deps, observedRefusal: false });
        expect(client.cancelBooking).toHaveBeenCalledTimes(1);
        expect(await prisma.bookingSync.findUnique({ where: { id } })).toMatchObject({ status: 'CANCELLED', cancelledBy: 'INTEGRATION', syncError: null });
    });
});
