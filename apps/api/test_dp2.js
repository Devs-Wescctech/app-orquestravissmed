const { PrismaClient } = require('./node_modules/@prisma/client');
const prisma = new PrismaClient();
async function main() {
    console.log('--- SAMPLE SERVICE ---');
    const s = await prisma.mapping.findFirst({ where: { entityType: 'SERVICE' } });
    console.log(JSON.stringify(s?.conflictData, null, 2));

    console.log('\n--- SAMPLE INSURANCE ---');
    const i = await prisma.mapping.findFirst({ where: { entityType: 'INSURANCE' } });
    console.log(JSON.stringify(i?.conflictData, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
