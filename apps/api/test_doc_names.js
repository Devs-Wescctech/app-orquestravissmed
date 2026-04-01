const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const docs = await prisma.doctoraliaDoctor.findMany();
    console.log("Doctoralia Doctors:");
    for (const d of docs) {
        console.log(`- ${d.name}`);
    }
}
check().catch(console.error).finally(() => prisma.$disconnect());
