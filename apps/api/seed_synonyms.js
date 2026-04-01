const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const synonyms = [
    { termA: 'Clínico Geral', termB: 'Consulta Clínica Geral' },
    { termA: 'Ortopedia', termB: 'Consulta Ortopédica' },
    { termA: 'Dermatologia', termB: 'Consulta Dermatológica' },
    { termA: 'Ginecologia', termB: 'Consulta Ginecologia' },
    { termA: 'Ginecologia', termB: 'Consulta Ginecológica' },
    { termA: 'Pediatria', termB: 'Consulta Pediátrica' },
    { termA: 'Cardiologia', termB: 'Consulta Cardiológica' },
    { termA: 'Oftalmologia', termB: 'Consulta Oftalmológica' },
    { termA: 'Psiquiatria', termB: 'Consulta Psiquiátrica' },
    { termA: 'Urologia', termB: 'Consulta Urológica' },
    { termA: 'Otorrinolaringologia', termB: 'Consulta Otorrinolaringológica' },
    { termA: 'Gastroenterologia', termB: 'Consulta Gastroenterológica' },
    { termA: 'Nutrologia', termB: 'Consulta Nutrológica' },
    { termA: 'Neurologia', termB: 'Consulta Neurológica' },
    { termA: 'Endocrinologia', termB: 'Consulta Endocrinológica' },
    { termA: 'Pneumologia', termB: 'Consulta Pneumológica' },
    { termA: 'Reumatologia', termB: 'Consulta Reumatológica' },
    { termA: 'Geriatria', termB: 'Consulta Geriátrica' },
    { termA: 'Infectologia', termB: 'Consulta Infectológica' },
    { termA: 'Nefrologia', termB: 'Consulta Nefrológica' },
    { termA: 'Alergia e Imunologia', termB: 'Consulta de Alergia' },
    { termA: 'Mastologia', termB: 'Consulta Mastológica' }
];

async function main() {
    console.log('Seeding synonyms...');
    for (const syn of synonyms) {
        await prisma.mappingSynonym.upsert({
            where: {
                termA_termB: { termA: syn.termA, termB: syn.termB }
            },
            update: {},
            create: {
                termA: syn.termA,
                termB: syn.termB,
                createdBy: 'system_seed'
            }
        });
    }
    console.log('Synonyms seeded successfully.');
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
