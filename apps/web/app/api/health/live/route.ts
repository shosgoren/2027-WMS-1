// Sığ canlılık ucu (T-129 Supervisor kararı): süreç HTTP isteğine yanıt veriyor mu. DB/kuyruğa DOKUNMAZ.
// Fly makine sağlık denetimi (`fly.staging.toml` http_service.checks) yalnızca bunu kullanır: derin `/api/health` DB kesintisinde
// Fly'ın web makinesini yeniden başlatmasına/servisten çıkarmasına yol açardı. Derin uç yalnızca uptime denetimi ve deploy-smoke içindir.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
