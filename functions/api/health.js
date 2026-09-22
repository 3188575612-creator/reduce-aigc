import { handleHealth } from "../_lib/rewrite-handler.mjs";

export async function onRequest(context) {
  const cors = { "Access-Control-Allow-Origin": new URL(context.request.url).origin };
  return handleHealth(cors);
}
