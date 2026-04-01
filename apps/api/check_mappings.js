const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const mappings = await prisma.mapping.findMany({
      where: { entityType: 'DOCTOR' }
  });
  mappings.forEach(m => {
      const cd = m.conflictData || {};
      console.log(`ExternalID: ${m.externalId}, Name: ${cd.name}, Facility: ${cd.facilityId}, Address: ${cd.address?.id}`);
  });
  await prisma.$disconnect();
}

check();
