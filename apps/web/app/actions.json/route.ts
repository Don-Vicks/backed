// Maps campaign page URLs to their Solana Action so shared links unfurl as Blinks.
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Content-Type": "application/json" };

export const GET = () =>
  new Response(JSON.stringify({ rules: [{ pathPattern: "/c/*", apiPath: "/api/actions/back/*" }] }), { headers });

export const OPTIONS = () => new Response(null, { headers });
