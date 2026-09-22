import { handleRewrite } from "../_lib/rewrite-handler.mjs";

export async function onRequest(context) {
  return handleRewrite(context.request, context.env || {});
}
