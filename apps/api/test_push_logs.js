const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const events = await prisma.syncEvent.findMany({
        where: {
            entityType: { in: ['ADDRESS_PUSH', 'SERVICE_PUSH'] }
        },
        orderBy: { timestamp: 'desc' },
        take: 10
    });
    console.log(`Found ${events.length} push events.`);
    events.forEach(e => {
        console.log(`[${e.timestamp.toISOString()}] ${e.entityType} (${e.action}): ${e.message}`);
    });
    await prisma.$disconnect();
}

check().catch(console.error);
