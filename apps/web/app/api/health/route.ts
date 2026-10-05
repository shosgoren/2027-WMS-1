// Sağlık uç noktası: süreç ayakta mı. DB'ye bağlanmaz (DB sağlık kontrolü Faz 1).
// Route Handler ince giriş katmanıdır (ADR-001).
export function GET(): Response {
  return Response.json({ status: "ok" });
}
