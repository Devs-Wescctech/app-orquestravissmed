import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function getAuthUser(req: Request, supabase: any) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return null;
  const { data: profile } = await supabase.from('users').select('*').eq('auth_id', user.id).single();
  return profile;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const url = new URL(req.url);
  const path = url.pathname.replace('/api-users', '');
  const segments = path.split('/').filter(Boolean);

  try {
    // GET / — List all users
    if (req.method === 'GET' && segments.length === 0) {
      const { data, error } = await supabase
        .from('users')
        .select('id, email, name, active, created_at, updated_at, user_clinic_roles(id, clinic_id, role, clinics(id, name))')
        .order('name');
      if (error) throw error;
      return json(data);
    }

    // GET /:id — Get single user
    if (req.method === 'GET' && segments.length === 1) {
      const { data, error } = await supabase
        .from('users')
        .select('id, email, name, active, created_at, updated_at, user_clinic_roles(id, clinic_id, role, clinics(id, name))')
        .eq('id', segments[0])
        .single();
      if (error) throw error;
      return json(data);
    }

    // POST / — Create user
    if (req.method === 'POST' && segments.length === 0) {
      const body = await req.json();
      
      // Create Supabase Auth user
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
        user_metadata: { name: body.name }
      });
      
      if (authError) throw authError;

      // The trigger will create the user profile, but we need to update it
      // Wait briefly for trigger
      await new Promise(resolve => setTimeout(resolve, 500));

      const { data: profile } = await supabase
        .from('users')
        .select('*')
        .eq('auth_id', authUser.user.id)
        .single();

      if (profile && body.name) {
        await supabase.from('users').update({ name: body.name, active: body.active ?? true }).eq('id', profile.id);
      }

      // Add clinic role if specified
      if (body.clinicId && profile) {
        await supabase.from('user_clinic_roles').upsert({
          user_id: profile.id,
          clinic_id: body.clinicId,
          role: body.role || 'OPERATOR'
        }, { onConflict: 'user_id,clinic_id' });
      }

      const { data: result } = await supabase
        .from('users')
        .select('id, email, name, active, created_at, updated_at, user_clinic_roles(id, clinic_id, role, clinics(id, name))')
        .eq('id', profile?.id || authUser.user.id)
        .single();

      return json(result, 201);
    }

    // PUT /:id — Update user
    if (req.method === 'PUT' && segments.length === 1) {
      const body = await req.json();
      const { password, role, clinicId, ...updateData } = body;

      await supabase.from('users').update(updateData).eq('id', segments[0]);

      // Update auth password if provided
      if (password) {
        const { data: user } = await supabase.from('users').select('auth_id').eq('id', segments[0]).single();
        if (user?.auth_id) {
          await supabase.auth.admin.updateUserById(user.auth_id, { password });
        }
      }

      // Update role if provided
      if (role && clinicId) {
        await supabase.from('user_clinic_roles').upsert({
          user_id: segments[0],
          clinic_id: clinicId,
          role
        }, { onConflict: 'user_id,clinic_id' });
      }

      const { data: result } = await supabase
        .from('users')
        .select('id, email, name, active, created_at, updated_at, user_clinic_roles(id, clinic_id, role, clinics(id, name))')
        .eq('id', segments[0])
        .single();

      return json(result);
    }

    // DELETE /:id — Delete user
    if (req.method === 'DELETE' && segments.length === 1) {
      const { data: user } = await supabase.from('users').select('auth_id').eq('id', segments[0]).single();
      if (user?.auth_id) {
        await supabase.auth.admin.deleteUser(user.auth_id);
      }
      await supabase.from('users').delete().eq('id', segments[0]);
      return json({ deleted: true });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
