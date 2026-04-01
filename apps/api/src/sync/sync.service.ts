import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SyncService {
    private readonly logger = new Logger(SyncService.name);

    constructor(
        @InjectQueue('vismed-sync') private vismedQueue: Queue,
        @InjectQueue('sync-queue') private doctoraliaQueue: Queue,
        private prisma: PrismaService
    ) { }

    async triggerManualSync(clinicId: string, type: 'full' | 'doctors' | 'services' | 'vismed-full' = 'full', idEmpresaGestora?: number) {
        // Audit log
        await this.prisma.auditLog.create({
            data: {
                action: 'MANUAL_SYNC_TRIGGERED',
                entity: 'Clinic',
                entityId: clinicId,
                details: { type }
            }
        });

        // Create sync run record
        const syncRun = await this.prisma.syncRun.create({
            data: {
                clinicId,
                type,
                status: 'running',
            }
        });

        // Dispatch job
        if (type === 'vismed-full') {
            await this.vismedQueue.add('vismed-sync', {
                syncRunId: syncRun.id,
                clinicId,
                idEmpresaGestora: idEmpresaGestora || 286 // Default to 286 based on specs
            }, {
                attempts: 1
            });
            this.logger.log(`Dispatched VISMED sync job for clinic ${clinicId} (EmpresaGestora: ${idEmpresaGestora || 286})`);
        } else {
            await this.doctoraliaQueue.add('process-sync', {
                syncRunId: syncRun.id,
                clinicId,
                type
            }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000,
                }
            });
            this.logger.log(`Dispatched DOCTORALIA sync job for clinic ${clinicId} with run ID ${syncRun.id}`);
        }

        return syncRun;
    }

    async triggerGlobalSync(clinicId: string, idEmpresaGestora?: number) {
        // Trigger VisMed
        const vismedRun = await this.triggerManualSync(clinicId, 'vismed-full', idEmpresaGestora);
        // Trigger Doctoralia
        const doctoraliaRun = await this.triggerManualSync(clinicId, 'full');

        return { vismedRunId: vismedRun.id, doctoraliaRunId: doctoraliaRun.id };
    }

    async getVismedStats() {
        const [units, doctors, specialties] = await Promise.all([
            this.prisma.vismedUnit.count(),
            this.prisma.vismedDoctor.count(),
            this.prisma.vismedSpecialty.count()
        ]);

        return {
            units,
            doctors,
            specialties
        };
    }
}
