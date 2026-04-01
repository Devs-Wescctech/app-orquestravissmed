const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const events = await prisma.syncEvent.findMany({
        orderBy: { timestamp: 'desc' },
        take: 10
    });
    console.log(events.map(e => `${e.entityType} [${e.action}]: ${e.message}`).join('\n'));
    await prisma.$disconnect();
}
check().catch(console.error);
