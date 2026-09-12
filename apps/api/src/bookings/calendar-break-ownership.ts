import { PrismaService } from '../prisma/prisma.service';

export type BreakScope = { clinicId: string; facilityId: string; doctorId: string; addressId: string };
const journalId = (bookingId: string) => `calendar-break:${bookingId}`;

/** Durable creation receipt. Time overlap is never evidence of ownership. */
export class CalendarBreakOwnership {
    constructor(private readonly prisma: PrismaService) {}

    async read(bookingId: string): Promise<any> {
        const entry = await this.prisma.auditLog.findUnique({ where: { id: journalId(bookingId) } });
        return entry?.action === 'CALENDAR_BREAK_CREATION' && entry.entityId === bookingId ? entry.details : null;
    }

    matches(receipt: any, scope: BreakScope, breakId?: string): boolean {
        return receipt?.state === 'OWNED' && typeof receipt.breakId === 'string' && !!receipt.breakId
            && (!breakId || receipt.breakId === breakId)
            && Object.entries(scope).every(([key, value]) => receipt[key] === String(value));
    }

    async requireOwned(bookingId: string, scope: BreakScope, breakId: string): Promise<void> {
        if (!this.matches(await this.read(bookingId), scope, breakId)) {
            throw new Error('BREAK_OWNERSHIP_PENDING: não há comprovante de criação deste bloqueio para este agendamento. Bloqueio preservado; conferir a associação.');
        }
        const other = await this.prisma.bookingSync.findFirst({ where: {
            id: { not: bookingId }, doctoraliaBreakId: breakId,
            doctoraliaFacilityId: scope.facilityId, doctoraliaDoctorId: scope.doctorId,
            doctoraliaAddressId: scope.addressId,
        }, select: { id: true } });
        if (other) throw new Error('BREAK_OWNERSHIP_PENDING: bloqueio também associado a outro agendamento. Bloqueio preservado.');
    }

    async begin(bookingId: string, scope: BreakScope): Promise<void> {
        // Unique primary key also prevents concurrent/restarted workers from repeating an uncertain POST.
        await this.prisma.auditLog.create({ data: {
            id: journalId(bookingId), action: 'CALENDAR_BREAK_CREATION', entity: 'BookingSync', entityId: bookingId,
            details: { ...scope, state: 'PENDING' },
        } });
    }

    async confirm(bookingId: string, scope: BreakScope, breakId: string): Promise<void> {
        await this.prisma.auditLog.update({ where: { id: journalId(bookingId) }, data: {
            details: { ...scope, state: 'OWNED', breakId },
        } });
    }

    async clear(bookingId: string): Promise<void> {
        await this.prisma.auditLog.deleteMany({ where: { id: journalId(bookingId), action: 'CALENDAR_BREAK_CREATION' } });
    }
}
