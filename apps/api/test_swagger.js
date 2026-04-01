const fs = require('fs');
async function run() {
    const res = await fetch('https://docplanner.github.io/integrations-hub-front-app/docs/swagger.json');
    const swagger = await res.json();

    // Find address update endpoint
    for (const path in swagger.paths) {
        if (path.includes('addresses') && swagger.paths[path].patch) {
            console.log("Found PATCH endpoint:", path);
            const op = swagger.paths[path].patch;
            console.log(JSON.stringify(op.parameters, null, 2));
            if (op.requestBody) {
                console.log("Request Body:", JSON.stringify(op.requestBody, null, 2));
            }
        }
        if (path.includes('addresses') && swagger.paths[path].put) {
            console.log("Found PUT endpoint:", path);
            const op = swagger.paths[path].put;
            console.log(JSON.stringify(op.parameters, null, 2));
        }
    }
}
run();
