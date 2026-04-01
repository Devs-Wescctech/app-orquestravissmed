
const empId = 286;
const url = `https://app.vissmed.com.br/api-vissmed-4/api/v1.0/convenio-by-idempresagestora?idempresagestora=${empId}`;

async function test() {
    try {
        console.log(`Fetching ${url}`);
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`Error: ${res.status}`);
            return;
        }
        const data = await res.json();
        console.log(`Received ${data.length} items`);
        if (data.length > 0) {
            console.log('Sample item:', JSON.stringify(data[0], null, 2));
        }
        
        const budgets = data.filter(i => (i.nomeconvenio || '').toUpperCase().includes('ORÇAMENTO'));
        console.log(`Budgets found: ${budgets.length}`);
        
        const active = data.filter(i => i.ativo === '1');
        console.log(`Active items: ${active.length}`);
        
        const realInsurances = data.filter(i => 
            i.ativo === '1' && 
            !(i.nomeconvenio || '').toUpperCase().includes('ORÇAMENTO') &&
            !(i.nomeconvenio || '').toUpperCase().includes('CARTAO CLINICA')
        );
        console.log(`Real active insurances (filtered): ${realInsurances.length}`);

    } catch (e) {
        console.error('Fetch failed:', e);
    }
}

test();
