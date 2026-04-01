const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const conn = await prisma.integrationConnection.findFirst({
      where: { provider: 'doctoralia' }
  });
  console.log('Connection domain:', conn.domain);
  await prisma.$disconnect();
}

check();
