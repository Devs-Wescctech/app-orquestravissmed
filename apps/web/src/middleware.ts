import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// This function can be marked `async` if using `await` inside
export function middleware(request: NextRequest) {
    const token = request.cookies.get('vismed_auth_token')?.value;
    const { pathname } = request.nextUrl;

    // By default, assume all routes EXCEPT these require auth
    const isPublicRoute = pathname.startsWith('/login') || pathname.startsWith('/reset-password');

    if (!token && !isPublicRoute) {
        // Redirect completely unauthenticated users to login
        return NextResponse.redirect(new URL('/login', request.url));
    }

    if (token && isPublicRoute) {
        // Redirect already authenticated users away from login
        return NextResponse.redirect(new URL('/', request.url));
    }

    return NextResponse.next();
}

// See "Matching Paths" below to learn more
export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - api (API routes)
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         */
        '/((?!api|_next/static|_next/image|favicon.ico).*)',
    ],
};
