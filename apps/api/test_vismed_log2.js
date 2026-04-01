const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const runs = await prisma.syncRun.findMany({
        where: { type: 'vismed-full' },
        orderBy: { startedAt: 'desc' },
        take: 5
    });
    console.log('Resultados Vismed Sync:');
    console.log(JSON.stringify(runs, null, 2));
}

run().finally(() => prisma.$disconnect());
