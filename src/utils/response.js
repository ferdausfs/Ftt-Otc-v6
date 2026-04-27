// ============================================================
// HTTP RESPONSE HELPERS
// ============================================================
// ============================================
// JSON RESPONSE
// ============================================

function jsonResponse(data, status) {
  if (!status) status = 200;
  return new Response(JSON.stringify(data, null, 2), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

// ============================================
// [v6.5.0] CEREBRAS AI VALIDATION LAYER
// Sends full indicator snapshot to Cerebras llama3.1-8b.
// Returns independent BUY/SELL/NO_TRADE verdict.
// On any error/timeout → returns { status: 'UNAVAILABLE' }

// ============================================
// CORS
// ============================================

function applyCors(response, corsHeaders) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    h.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}

export { jsonResponse, applyCors };
