const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const result = await prisma.syncRun.create({
        data: {
            clinicId: '2d25a9d8-66c5-4586-9adb-0d22ee8178af',
            type: 'vismed-full',
            status: 'running',
            totalRecords: 0,
        }
    });
    console.log('Inserted: ', result.id);
    const runs = await prisma.syncRun.findMany({ where: { type: 'vismed-full' } });
    console.log('Total Vismed Runs in DB:', runs.length);
}

run().finally(() => prisma.$disconnect());
