// EPL OS — 카카오 알림톡 발송 (솔라피)
// Supabase Edge Function 이름: alimtalk
// Secrets: SOLAPI_API_KEY, SOLAPI_API_SECRET  (없으면 실제 발송 없이 테스트 모드로 응답)
// 솔라피 키는 이 함수 안에서만 쓰이고 브라우저로 나가지 않는다.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS),
  });
}

// EPL OS에 로그인한 계정만 발송할 수 있다 (공개 키만으로는 통과하지 못함)
async function signedIn(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  const key = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  if (!auth || !base) return false;
  try {
    const r = await fetch(base + "/auth/v1/user", { headers: { Authorization: auth, apikey: key } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (_e) {
    return false;
  }
}

async function solapiAuth(key: string, secret: string): Promise<string> {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(date + salt));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return "HMAC-SHA256 apiKey=" + key + ", date=" + date + ", salt=" + salt + ", signature=" + hex;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST만 지원합니다." }, 405);
  if (!(await signedIn(req))) return json({ error: "로그인이 필요합니다." }, 401);

  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "요청 형식 오류" }, 400);
  }
  const pfId = String((body && body.pfId) || "").trim();
  const templateId = String((body && body.templateId) || "").trim();
  const from = String((body && body.from) || "").replace(/[^0-9]/g, "");
  const list = body && Array.isArray(body.messages) ? body.messages : [];
  if (!pfId || !templateId) return json({ error: "채널 pfId와 템플릿 ID가 필요합니다." }, 400);
  if (!list.length) return json({ error: "보낼 알림장이 없습니다." }, 400);
  if (list.length > 300) return json({ error: "한 번에 300건까지 보낼 수 있습니다." }, 400);

  // deno-lint-ignore no-explicit-any
  const messages: any[] = [];
  for (const m of list) {
    const to = String((m && m.to) || "").replace(/[^0-9]/g, "");
    if (!/^01\d{8,9}$/.test(to)) return json({ error: "수신 번호 형식 오류: " + to }, 400);
    const variables: Record<string, string> = {};
    const src = (m && m.variables) || {};
    for (const k of Object.keys(src)) {
      const v = String(src[k] == null ? "" : src[k]).trim();
      variables[k] = v || "-"; // 빈 변수는 솔라피가 거절하므로 "-"로 채운다
    }
    // deno-lint-ignore no-explicit-any
    const kakaoOptions: any = { pfId, templateId, variables };
    if (!from) kakaoOptions.disableSms = true; // 발신번호가 없으면 문자 대체발송 끔
    // deno-lint-ignore no-explicit-any
    const msg: any = { to, kakaoOptions, customFields: { ref: String((m && m.ref) || "") } };
    if (from) msg.from = from;
    messages.push(msg);
  }

  const apiKey = Deno.env.get("SOLAPI_API_KEY") || "";
  const apiSecret = Deno.env.get("SOLAPI_API_SECRET") || "";
  if (!apiKey || !apiSecret) return json({ dryRun: true, count: messages.length });

  let r: Response;
  try {
    r = await fetch("https://api.solapi.com/messages/v4/send-many/detail", {
      method: "POST",
      headers: { Authorization: await solapiAuth(apiKey, apiSecret), "Content-Type": "application/json" },
      // 형제는 학부모 번호가 같으므로 같은 번호로 여러 건을 허용한다
      body: JSON.stringify({ messages, allowDuplicates: true }),
    });
  } catch (e) {
    return json({ error: "솔라피 연결 실패: " + String(e) }, 502);
  }
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try {
    data = await r.json();
  } catch (_e) {
    data = null;
  }
  if (!r.ok || !data) {
    const why = data ? (data.errorMessage || data.message || data.errorCode || "") : "";
    return json({ error: "솔라피 오류 " + r.status + (why ? " · " + why : "") }, 502);
  }
  // deno-lint-ignore no-explicit-any
  const failed = (Array.isArray(data.failedMessageList) ? data.failedMessageList : []).map((f: any) => ({
    ref: (f && f.customFields && f.customFields.ref) || "",
    to: (f && f.to) || "",
    code: (f && f.statusCode) || "",
    message: (f && f.statusMessage) || "",
  }));
  return json({
    ok: true,
    total: messages.length,
    failed,
    groupId: (data.groupInfo && data.groupInfo.groupId) || "",
  });
});
