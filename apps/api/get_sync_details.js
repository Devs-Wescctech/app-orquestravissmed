const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const syncRunId = process.argv[2];

async function main() {
  if (!syncRunId) {
    console.error('Usage: node get_sync_details.js <syncRunId>');
    process.exit(1);
  }
  
  const run = await prisma.syncRun.findUnique({
    where: { id: syncRunId },
    include: {
      events: true
    }
  });
  
  console.log(JSON.stringify(run, null, 2));
}

main().finally(() => prisma.$disconnect());
