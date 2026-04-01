const { Queue } = require('bullmq');
const Redis = require('ioredis');

async function main() {
    const connection = new Redis({
        host: 'localhost',
        port: 6380,
        password: 'vismed_redis_sec'
    });

    const queue = new Queue('sync-queue', { connection });

    // Add job to sync doctoralia
    await queue.add('sync-doctoralia', {
        clinicId: '36749174-fb55-4ef6-94de-2f24ea97dc57'
    });

    console.log('Job added to BullMQ!');
    setTimeout(() => {
        connection.quit();
        process.exit(0);
    }, 2000);
}
main();
