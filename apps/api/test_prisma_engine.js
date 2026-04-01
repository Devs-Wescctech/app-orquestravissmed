const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        console.log("Checking if Prisma has professionalUnifiedMapping...");
        console.log(typeof prisma.professionalUnifiedMapping);
        console.log(typeof prisma.specialtyServiceMapping);
    } catch (e) {
        console.error(e);
    }
}
check().finally(() => prisma.$disconnect());
