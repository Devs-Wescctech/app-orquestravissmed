const { Client } = require('pg');

async function exportData() {
  const client = new Client({
    connectionString: "postgresql://vismed_admin:vismed_root_secr3t@localhost:5435/vismed_platform"
  });

  try {
    await client.connect();
    
    // Fetch Clinics
    const clinics = await client.query('SELECT * FROM "Clinic"');
    console.log('--- CLINICS ---');
    console.log(JSON.stringify(clinics.rows, null, 2));

    // Fetch Integrations
    const integrations = await client.query('SELECT * FROM "IntegrationConnection"');
    console.log('--- INTEGRATIONS ---');
    console.log(JSON.stringify(integrations.rows, null, 2));

    // Fetch UserClinicRoles
    const roles = await client.query('SELECT * FROM "UserClinicRole"');
    console.log('--- ROLES ---');
    console.log(JSON.stringify(roles.rows, null, 2));

  } catch (err) {
    console.error('Error connecting to local DB:', err);
  } finally {
    await client.end();
  }
}

exportData();
