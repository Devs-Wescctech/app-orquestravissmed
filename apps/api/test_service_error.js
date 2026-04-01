const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const events = await prisma.syncEvent.findMany({
        where: {
            action: 'error',
            entityType: 'SERVICE_PUSH'
        },
        orderBy: { timestamp: 'desc' },
        take: 3
    });
    console.log(JSON.stringify(events, null, 2));
    await prisma.$disconnect();
}

check().catch(console.error);
