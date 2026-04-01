const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const clinic = await prisma.clinic.findFirst();
    console.log(JSON.stringify(clinic));
}

main().catch(console.error).finally(() => prisma.$disconnect());
