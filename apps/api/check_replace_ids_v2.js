const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const latestSuccess = await prisma.auditLog.findFirst({
    where: { action: 'REPLACE_SLOTS', details: { path: ['status'], equals: 'success' } },
    orderBy: { timestamp: 'desc' }
  });

  if (latestSuccess) {
      console.log('Success details:', JSON.stringify(latestSuccess.details));
      const doctorIdExternal = latestSuccess.details.doctorId;
      const mapping = await prisma.mapping.findFirst({
          where: { externalId: doctorIdExternal, entityType: 'DOCTOR' }
      });
      console.log('Mapping conflictData:', JSON.stringify(mapping?.conflictData));
  }
  
  await prisma.$disconnect();
}

check();
