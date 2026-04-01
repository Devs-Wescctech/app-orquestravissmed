import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://cfwyglawggxmehgjzohz.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmd3lnbGF3Z2d4bWVoZ2p6b2h6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM3NzksImV4cCI6MjA4OTUxOTc3OX0.RSi4puczGsKkRqwPIZI8_W9QleDdCGI93tzbfuJA-74';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Call a Supabase Edge Function that replaces the old NestJS API.
 * Automatically attaches the auth token from cookies or Supabase session.
 */
export async function callEdgeFunction(
  functionName: string,
  options?: {
    method?: string;
    path?: string;
    body?: any;
    params?: Record<string, string>;
  }
) {
  const { method = 'POST', path = '', body, params } = options || {};
  
  // Build the URL with query params
  const queryString = params
    ? '?' + new URLSearchParams(params).toString()
    : '';
  
  // Get the current session token
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  
  // Also check for legacy cookie token
  let legacyToken: string | undefined;
  if (typeof window !== 'undefined') {
    const cookies = document.cookie.split(';');
    const authCookie = cookies.find(c => c.trim().startsWith('vismed_auth_token='));
    if (authCookie) {
      legacyToken = authCookie.split('=')[1];
    }
  }
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (legacyToken) {
    headers['Authorization'] = `Bearer ${legacyToken}`;
  }
  
  const url = `${supabaseUrl}/functions/v1/${functionName}${path}${queryString}`;
  
  const fetchOptions: RequestInit = {
    method,
    headers,
  };
  
  if (body && method !== 'GET') {
    fetchOptions.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, fetchOptions);
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText }));
    
    // Handle 401 - redirect to login
    if (response.status === 401) {
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        // Clear cookies
        document.cookie = 'vismed_auth_token=; path=/; max-age=0';
        window.location.href = '/login';
      }
    }
    
    throw new Error(errorData.error || `API Error: ${response.status}`);
  }
  
  return response.json();
}
