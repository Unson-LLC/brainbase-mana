import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Use Wrangler's own bundler and Worker engine so Node's broader Request API
// cannot hide a production-only constructor failure.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");

describe("reply intake in the production Worker engine", () => {
  it("constructs all four effects with manual redirects and rejects a redirect response", async () => {
    const entry = fileURLToPath(new URL("../reply-intake-effect.ts", import.meta.url));
    const built = await build({
      stdin: { resolveDir: process.cwd(), contents: `
        import { createReplyIntakeEffectFetch } from ${JSON.stringify(entry)};
        export default { async fetch() {
          const event = {tenantId:'tenant',workspaceId:'T1',eventId:'Ev1',channelId:'D1',
            threadTs:'123.000001',messageTs:'123.000002',userId:'U1'};
          const context = {tenant:{tenant_id:'tenant'},workspace_connection:{workspace_id:'T1',app_id:'A1'},
            actor:{authenticated_subject_id:'U1'},slack:{event_id:'Ev1',channel_id:'D1',thread_ts:'123.000001',requester_id:'U1'}};
          const requests = []; let completed = 0; let redirect = false;
          const intake = createReplyIntakeEffectFetch({event,getTenantContext:()=>context,
            fallback:()=>{throw new Error('unexpected_fallback')},
            resolveEffects:async()=>({slackDelivery:async(_id,_target,_event,execute)=>{
              await execute(async request=>{
                requests.push({url:request.url,redirect:request.redirect,authorization:request.headers.has('authorization')});
                return redirect ? new Response(null,{status:302,headers:{location:'https://other.example/'}})
                  : Response.json({ok:true});
              });
              completed++;
            }})});
          const reaction = {channel:'D1',timestamp:'123.000002',name:'eyes'};
          const status = {channel_id:'D1',thread_ts:'123.000001',status:'分析しています…'};
          const results = [];
          for (const [path,body] of [['reactions.add',reaction],['assistant.threads.setStatus',status],
            ['assistant.threads.setStatus',{...status,status:''}],['reactions.remove',reaction]]) {
            try { const response = await intake('https://slack.com/api/'+path,{method:'POST',
              headers:{'content-type':'application/json'},body:JSON.stringify(body)});
              results.push({status:response.status});
            } catch(e) { results.push({error_name:e.name}); }
          }
          redirect = true;
          const response = await intake('https://slack.com/api/reactions.add',{method:'POST',
            headers:{'content-type':'application/json'},body:JSON.stringify(reaction)}).catch(e=>({status:0,error_name:e.name}));
          return Response.json({results,requests,completed,redirect_status:response.status});
        }};
      ` }, bundle: true, write: false, format: "esm", platform: "browser",
    });
    const options = { modules: true, compatibilityDate: "2026-09-07", script: built.outputFiles[0].text };
    const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
    try {
      const result = await (await mf.dispatchFetch("http://localhost/")).json();
      expect(result.results).toEqual(Array.from({ length: 4 }, () => ({ status: 200 })));
      expect(result.completed).toBe(4);
      expect(result.redirect_status).toBe(302);
      expect(result.requests).toHaveLength(5);
      expect(result.requests.every((request: { url: string; redirect: string; authorization: boolean }) =>
        new URL(request.url).origin === "https://slack.com" && request.redirect === "manual" && !request.authorization)).toBe(true);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
