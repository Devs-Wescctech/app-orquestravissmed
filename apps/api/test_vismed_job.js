const { Queue } = require('bullmq');

async function run() {
    const syncQueue = new Queue('vismed-sync', {
        connection: {
            host: 'localhost',
            port: 6380,
            password: 'vismed_redis_sec'
        }
    });

    console.log('Limpando Jobs Limpos...');
    await syncQueue.obliterate({ force: true });
    console.log('Fila Limpa.');

    const run = await syncQueue.add('vismed-job', {
        clinicId: '2d25a9d8-66c5-4586-9adb-0d22ee8178af', // ID válido
        idEmpresaGestora: 286
    });

    console.log('Job Vismed adicionado com sucesso!');
    console.log(`ID do Job: ${run.id}`);

    process.exit(0);
}

run().catch(console.error);
