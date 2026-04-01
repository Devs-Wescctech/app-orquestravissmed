const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const log = await prisma.auditLog.findFirst({
    where: { 
        details: { path: ['status'], equals: 'error' }
    },
    orderBy: { timestamp: 'desc' }
  });

  if (log) {
    console.log("ACTION:", log.action);
    console.log("DETAILS:", JSON.stringify(log.details, null, 2));
  } else {
    console.log("No error log found");
  }
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
