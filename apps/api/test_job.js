const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { PrismaClient } = require('@prisma/client');

const redis = new IORedis({ host: 'vismed-redis', port: 6379, password: 'vismed_redis_sec' });
const queue = new Queue('vismed-sync', { connection: redis });
const prisma = new PrismaClient();

async function run() {
    console.log('Starting job injection...');
    const syncRun = await prisma.syncRun.create({
        data: { clinicId: 'default-clinic-id', type: 'full', status: 'running' }
    });
    console.log('Created SyncRun', syncRun.id);
    await queue.add('process-sync', { syncRunId: syncRun.id, clinicId: 'default-clinic-id', type: 'full' });
    console.log('Added to queue successfully.');

    // Check back in 10 seconds to see events
    setTimeout(async () => {
        const events = await prisma.syncEvent.findMany({ where: { syncRunId: syncRun.id }, orderBy: { createdAt: 'asc' } });
        console.log('EVENTS:', JSON.stringify(events, null, 2));
        const run = await prisma.syncRun.findUnique({ where: { id: syncRun.id } });
        console.log('FINAL RUN STATUS:', JSON.stringify(run, null, 2));
        process.exit(0);
    }, 12000);
}
run().catch(console.error);
