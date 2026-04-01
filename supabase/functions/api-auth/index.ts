import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const url = new URL(req.url);
  const path = url.pathname.replace('/api-auth', '');

  try {
    // POST /login
    if (req.method === 'POST' && (path === '/login' || path === '')) {
      const { email, password } = await req.json();
      if (!email || !password) {
        return new Response(JSON.stringify({ error: 'Email and password required' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Try Supabase Auth first
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });

      if (authError) {
        // Fallback: try legacy bcrypt login
        const { data: users } = await supabase
          .from('users')
          .select('*, user_clinic_roles(*, clinics(*))')
          .eq('email', email)
          .limit(1);

        const user = users?.[0];
        if (!user || !user.password) {
          return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
            status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Import bcrypt for legacy password check
        const { compare } = await import("https://deno.land/x/bcrypt@v0.4.1/mod.ts");
        const isMatch = await compare(password, user.password);
        if (!isMatch) {
          return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
            status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Create a Supabase Auth user if doesn't exist, for migration
        if (!user.auth_id) {
          const { data: newAuth } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { name: user.name }
          });
          if (newAuth?.user) {
            await supabase.from('users').update({ auth_id: newAuth.user.id }).eq('id', user.id);
          }
          // Re-sign in
          const { data: retryAuth } = await supabase.auth.signInWithPassword({ email, password });
          if (retryAuth?.session) {
            const roles = user.user_clinic_roles?.map((r: any) => ({
              clinicId: r.clinic_id,
              role: r.role,
              clinic: r.clinics
            })) || [];
            return new Response(JSON.stringify({
              access_token: retryAuth.session.access_token,
              user: { id: user.id, name: user.name, email: user.email, roles }
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        }

        // Fallback JWT-like response for legacy
        const roles = user.user_clinic_roles?.map((r: any) => ({
          clinicId: r.clinic_id,
          role: r.role,
          clinic: r.clinics
        })) || [];
        return new Response(JSON.stringify({
          access_token: 'legacy_' + btoa(JSON.stringify({ sub: user.id, email })),
          user: { id: user.id, name: user.name, email: user.email, roles }
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Supabase Auth succeeded
      const { data: userProfile } = await supabase
        .from('users')
        .select('*, user_clinic_roles(*, clinics(*))')
        .eq('auth_id', authData.user.id)
        .single();

      const roles = userProfile?.user_clinic_roles?.map((r: any) => ({
        clinicId: r.clinic_id,
        role: r.role,
        clinic: r.clinics
      })) || [];

      return new Response(JSON.stringify({
        access_token: authData.session?.access_token,
        user: {
          id: userProfile?.id || authData.user.id,
          name: userProfile?.name || authData.user.user_metadata?.name || email,
          email: authData.user.email,
          roles
        }
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // GET /profile
    if (req.method === 'GET' && path === '/profile') {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const token = authHeader.replace('Bearer ', '');
      const { data: { user: authUser }, error } = await supabase.auth.getUser(token);

      if (error || !authUser) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { data: profile } = await supabase
        .from('users')
        .select('*, user_clinic_roles(*, clinics(*))')
        .eq('auth_id', authUser.id)
        .single();

      if (!profile) {
        return new Response(JSON.stringify({ error: 'Profile not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const roles = profile.user_clinic_roles?.map((r: any) => ({
        clinicId: r.clinic_id,
        role: r.role,
        clinic: r.clinics
      })) || [];

      return new Response(JSON.stringify({
        id: profile.id,
        name: profile.name,
        email: profile.email,
        roles
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
