const { Client } = require('pg');

async function exportFullData() {
  const client = new Client({
    connectionString: "postgresql://vismed_admin:vismed_root_secr3t@localhost:5435/vismed_platform"
  });

  try {
    await client.connect();
    
    // Fetch all relevant tables
    const tables = ['Clinic', 'IntegrationConnection', 'Mapping', 'VismedUnit', 'VismedDoctor', 'VismedSpecialty', 'VismedProfessionalSpecialty', 'DoctoraliaDoctor', 'DoctoraliaService', 'DoctoraliaAddressService', 'ProfessionalUnifiedMapping', 'SpecialtyServiceMapping'];
    
    const exportResult = {};

    for (const table of tables) {
      try {
        const res = await client.query(`SELECT * FROM "${table}"`);
        exportResult[table] = res.rows;
      } catch (e) {
        console.warn(`Table "${table}" skip: ${e.message}`);
      }
    }

    console.log(JSON.stringify(exportResult, null, 2));

  } catch (err) {
    console.error('Error connecting to local DB:', err);
  } finally {
    await client.end();
  }
}

exportFullData();
