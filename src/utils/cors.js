export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function applyCors(input, corsHeaders = CORS_HEADERS) {
  let headers;
  if (!input || input instanceof Headers) {
    headers = input || new Headers();
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    return headers;
  }

  headers = new Headers(input.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);

  return new Response(input.body, {
    status: input.status,
    statusText: input.statusText,
    headers: headers,
  });
}
