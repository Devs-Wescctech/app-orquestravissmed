const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const connection = new Redis({
        host: 'localhost',
        port: 6380,
        password: 'vismed_redis_sec'
    });

    const queue = new Queue('sync-queue', { connection });
    const clinicId = '36749174-fb55-4ef6-94de-2f24ea97dc57';

    const syncRun = await prisma.syncRun.create({
        data: {
            clinicId,
            provider: 'doctoralia',
            status: 'running',
            type: 'full',
            startedAt: new Date(),
        }
    });

    await queue.add('sync-doctoralia', {
        clinicId,
        syncRunId: syncRun.id
    });

    console.log('Proper Job Triggered! SyncRunId:', syncRun.id);
    setTimeout(() => {
        connection.quit();
        process.exit(0);
    }, 2000);
}
main();
