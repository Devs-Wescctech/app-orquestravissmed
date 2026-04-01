const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const vd = await prisma.vismedDoctor.count();
    const vs = await prisma.vismedSpecialty.count();
    console.log(`Vismed Doctors: ${vd}, Vismed Specialties: ${vs}`);
}

check().catch(console.error).finally(() => prisma.$disconnect());
