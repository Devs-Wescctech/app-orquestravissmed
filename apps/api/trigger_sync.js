const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');

const prisma = new PrismaClient();

async function trigger() {
    const queue = new Queue('sync-queue', {
        connection: {
            host: 'localhost',
            port: 6380,
            password: 'vismed_redis_sec'
        }
    });

    // same clinic as in DB integration row
    const clinicId = '36749174-fb55-4ef6-94de-2f24ea97dc57';

    const syncRun = await prisma.syncRun.create({
        data: {
            clinicId,
            type: 'full',
            status: 'running'
        }
    });

    await queue.add('process-sync', {
        syncRunId: syncRun.id,
        clinicId,
        type: 'full'
    });
    console.log(`Job added! SyncRun ID: ${syncRun.id}`);

    // waiting a bit for the worker to process it
    await new Promise(resolve => setTimeout(resolve, 10000));
}

trigger().catch(console.error).finally(() => prisma.$disconnect());
