const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const units = await prisma.vismedUnit.findMany();
    const docs = await prisma.vismedDoctor.findMany();
    const specs = await prisma.vismedSpecialty.findMany();

    console.log('--- Unidades VisMed no Banco ---');
    console.log(`Total: ${units.length}`);
    if (units.length > 0) console.log(units[0]);

    console.log('\n--- Profissionais VisMed no Banco ---');
    console.log(`Total: ${docs.length}`);
    if (docs.length > 0) console.log(docs[0]);

    console.log('\n--- Especialidades VisMed no Banco ---');
    console.log(`Total: ${specs.length}`);
    if (specs.length > 0) console.log(specs[0]);
}

run().catch(console.error).finally(() => prisma.$disconnect());
