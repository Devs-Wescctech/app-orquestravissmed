const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const vDocs = await prisma.vismedDoctor.findMany({ take: 20 });
  const dDocs = await prisma.doctoraliaDoctor.findMany({ take: 20 });
  
  console.log('=== VISMED DOCTORS ===');
  vDocs.forEach(d => console.log(d.name));
  
  console.log('\n=== DOCTORALIA DOCTORS ===');
  dDocs.forEach(d => console.log(d.name));
}

main().finally(() => prisma.$disconnect());
