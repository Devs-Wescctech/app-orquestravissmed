const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();
async function main() {
    const events = await prisma.syncLog.findMany({
        where: { action: 'fetch_success' },
        orderBy: { createdAt: 'desc' },
        take: 20
    });
    fs.writeFileSync('sync_events.json', JSON.stringify(events, null, 2));
}
main().finally(() => prisma.$disconnect());
