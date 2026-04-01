import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';

const redis = new IORedis({ host: 'vismed-redis', port: 6379, password: 'vismed_redis_sec' });
const queue = new Queue('vismed-sync', { connection: redis });
const prisma = new PrismaClient();

async function run() {
    const syncRun = await prisma.syncRun.create({
        data: {
            clinicId: 'default-clinic-id',
            type: 'full',
            status: 'running',
        }
    });
    console.log('Created SyncRun', syncRun.id);
    await queue.add('process-sync', {
        syncRunId: syncRun.id,
        clinicId: 'default-clinic-id',
        type: 'full'
    });
    console.log('Added to queue successfully. The Worker should pick it up now.');
    process.exit(0);
}
run().catch(console.error);
