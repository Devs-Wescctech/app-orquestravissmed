const cp = require('child_process');
try {
    const result = cp.execSync('powershell "Get-WmiObject Win32_Process -Filter \\"ProcessId=35120\\" | Select-Object -ExpandProperty CommandLine"');
    console.log('CMD:', result.toString());
} catch (e) {
    console.error(e.message);
}
