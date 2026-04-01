const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const lastSync = await prisma.syncRun.findFirst({
        orderBy: { startedAt: 'desc' }
    });
    console.log(JSON.stringify(lastSync, null, 2));
}

run().finally(() => prisma.$disconnect());
