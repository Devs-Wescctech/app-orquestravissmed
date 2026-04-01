const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const mapping = await prisma.mapping.findFirst({
    where: { externalId: '1396868', entityType: 'DOCTOR' }
  });

  if (mapping) {
    console.log("MAPPING FOR 1396868:", JSON.stringify(mapping, null, 2));
  } else {
    console.log("No mapping found for 1396868");
  }
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
