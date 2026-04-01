async function get() {
    const res = await fetch('http://localhost:3333/mappings/professionals', {
        headers: { 'Authorization': 'Bearer vismed_super_secret_jwt_key_mock_or_something' }
    });
    console.log(res.status);
    const data = await res.json();
    console.log(JSON.stringify(data[0] || data, null, 2));
}
get().catch(console.error);
