// Better Auth uç noktası (`/api/auth/*`). Route Handler ince giriş katmanıdır (ADR-001, ADR-014 §1):
// ortam doğrulaması ve örnek kurulumu ilk istekte (`@wms/auth` tembel), `next build` sırasında değil.
import { authRouteHandlers } from "../../../../lib/auth-service.ts";

export const { GET, POST } = authRouteHandlers;
