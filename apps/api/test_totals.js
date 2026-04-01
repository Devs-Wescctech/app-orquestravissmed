const { PrismaClient } = require('./node_modules/@prisma/client');
const prisma = new PrismaClient();
async function main() {
    console.log('Services:', await prisma.mapping.count({ where: { entityType: 'SERVICE' } }));
    console.log('Insurances:', await prisma.mapping.count({ where: { entityType: 'INSURANCE' } }));
    console.log('Vismed Units:', await prisma.vismedUnit.count());
    console.log('Vismed Specs:', await prisma.vismedSpecialty.count());
}
main().catch(console.error).finally(() => prisma.$disconnect());
