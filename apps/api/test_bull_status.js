const { Queue } = require('bullmq');
const Redis = require('ioredis');

async function main() {
    const connection = new Redis({
        host: 'localhost',
        port: 6380,
        password: 'vismed_redis_sec'
    });

    const queue = new Queue('sync-queue', { connection });

    // Check jobs
    const failed = await queue.getFailed();
    const active = await queue.getActive();
    const waiting = await queue.getWaiting();
    const completed = await queue.getCompleted();

    console.log(`Failed: ${failed.length}`);
    if (failed.length > 0) {
        console.log('Last failed reason:', failed[0].failedReason);
    }
    console.log(`Active: ${active.length}`);
    console.log(`Waiting: ${waiting.length}`);
    console.log(`Completed: ${completed.length}`);

    connection.quit();
    process.exit(0);
}
main();
