import { OAuth2Client } from "google-auth-library";

export type TokenVerifier = (authorizationHeader: string | undefined) => Promise<boolean>;

/**
 * The service is public (GitHub must reach /webhook), so /reconcile and /janitor authenticate
 * callers themselves: a Google-signed OIDC token for the invoker service account and our audience.
 */
export function googleOidcVerifier(audience: string, expectedEmail: string): TokenVerifier {
  const client = new OAuth2Client();
  return async (header) => {
    if (!header?.startsWith("Bearer ")) return false;
    try {
      const ticket = await client.verifyIdToken({ idToken: header.slice("Bearer ".length), audience });
      const p = ticket.getPayload();
      return !!p && p.email === expectedEmail && p.email_verified === true;
    } catch {
      return false;
    }
  };
}
