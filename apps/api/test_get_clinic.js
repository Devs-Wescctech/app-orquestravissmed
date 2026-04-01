const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const clinic = await prisma.clinic.findFirst();
    console.log(clinic ? clinic.id : 'No clinic found');
}

run().finally(() => prisma.$disconnect());
