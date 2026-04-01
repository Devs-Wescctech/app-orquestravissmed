const DDomain = "www.doctoralia.com.br";
const CId = "17482_62csipuh254w84c4s4ck488o4scgs0gwcgccw4448cc8kwk8ck";
const CSec = "4zdl23s0i1wkwoococ0ksk44oosk884k0ooks8gk4owso8gkw4";

async function test() {
  const body = new URLSearchParams();
  body.append('grant_type', 'client_credentials');
  body.append('scope', 'integration');
  body.append('client_id', CId);
  body.append('client_secret', CSec);

  const basicAuth = Buffer.from(`${CId}:${CSec}`).toString('base64');
  const res = await fetch(`https://${DDomain}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basicAuth}` },
    body,
  });
  
  const auth = await res.json();
  const token = auth.access_token;
  console.log("Token obtained:", token ? "Yes" : "No");

  if (!token) {
    console.log("Auth failed:", auth);
    return;
  }

  const facRes = await fetch(`https://${DDomain}/api/v3/integration/facilities`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const facilities = await facRes.json();
  console.log("Facilities found:", JSON.stringify(facilities, null, 2));

  if (facilities._items && facilities._items.length > 0) {
     const facId = facilities._items[0].id;
     const insRes = await fetch(`https://${DDomain}/api/v3/integration/facilities/${facId}/insurances`, {
       headers: { 'Authorization': `Bearer ${token}` }
     });
     const insurances = await insRes.json();
     console.log("Insurances in first facility:", JSON.stringify(insurances, null, 2));
  }
}

test();
