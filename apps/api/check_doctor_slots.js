const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const log = await prisma.auditLog.findFirst({
    where: { 
        action: 'FETCH_SLOTS',
        entityId: '1396868'
    },
    orderBy: { timestamp: 'desc' }
  });

  if (log) {
    console.log("FETCH_SLOTS FOR 1396868 DETAILS:", JSON.stringify(log.details, null, 2));
  } else {
    console.log("No FETCH_SLOTS log found for 1396868");
  }
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
