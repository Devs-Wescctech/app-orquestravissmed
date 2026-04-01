const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

const prisma = new PrismaClient();

async function main() {
    const sCount = await prisma.mapping.count({ where: { entityType: 'SERVICE', externalId: { not: null } } });
    const iCount = await prisma.mapping.count({ where: { entityType: 'INSURANCE', externalId: { not: null } } });
    const lCount = await prisma.mapping.count({ where: { entityType: 'LOCATION', externalId: { not: null } } });

    fs.writeFileSync('dp_counts.txt', `Services: ${sCount}\nInsurances: ${iCount}\nLocations: ${lCount}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
