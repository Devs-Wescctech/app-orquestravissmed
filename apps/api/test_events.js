const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkEvents() {
    const events = await prisma.syncEvent.findMany({
        where: { syncRunId: '48b15a48-9712-4fac-b74f-d346d5b86a27' },
        orderBy: { createdAt: 'asc' }
    });
    for (const ev of events) {
        console.log(`[${ev.entityType}] ${ev.action}: ${ev.message}`);
    }
}
checkEvents().finally(() => prisma.$disconnect());
