const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

const prisma = new PrismaClient();

async function main() {
    const s = await prisma.mapping.findFirst({ where: { entityType: 'SERVICE' }, orderBy: { updatedAt: 'desc' } });
    const i = await prisma.mapping.findFirst({ where: { entityType: 'INSURANCE' }, orderBy: { updatedAt: 'desc' } });
    fs.writeFileSync('test_raw.json', JSON.stringify({ service: s, insurance: i }, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
