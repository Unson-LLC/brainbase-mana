import { describe, expect, it, vi } from "vitest";

import { createTenantCredentialFetch } from "../multitenancy/tenant-credential-fetch.js";
import type { TenantAccountingHttpClient } from "../multitenancy/http-clients.js";
import {
  createIdempotencyKey,
  signTenantContextEnvelope,
  type CredentialBrokerClient,
  type CredentialLease,
  type CredentialLeaseRequest,
  type ExpectedTenantScope,
  type UnsignedTenantContextEnvelope,
  type WorkspaceConnectionSnapshot,
} from "../multitenancy/index.js";

const NOW = "2026-08-17T01:00:00.000Z";
const SNAPSHOT: WorkspaceConnectionSnapshot = {
  connection_id: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connection_revision: "7",
  tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  installation_id: "I-A",
  workspace_id: "T-A",
  app_id: "A-MANA",
  installer_id: "U-INSTALLER",
  granted_scopes: ["files:read", "chat:write"],
  status: "active",
  deployment_id: "dep_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  profile: "shared_cloud",
  credential_mode: "customer_oauth",
  contract_revision: "11",
};

const EXPECTED_SCOPE: ExpectedTenantScope = {
  audience: "mana-runtime",
  workspace_id: "T-A",
  app_id: "A-MANA",
  channel_id: "C-A",
  thread_ts: "1723800000.000001",
  actor_principal_id: "person-a",
  project_id: "project-a",
  capability_id: "runtime.execute",
  deployment_id: SNAPSHOT.deployment_id,
};

async function signedEnvelope(index = 0) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const unsigned: UnsignedTenantContextEnvelope = {
    schema_version: "1.0",
    protocol_id: "mana-brainbase-tenant-context",
    protocol_version: "1.0",
    issuer: "brainbase",
    audience: ["mana-runtime"],
    tenant: { tenant_id: SNAPSHOT.tenant_id, tenant_revision: "3" },
    workspace_connection: {
      connection_id: SNAPSHOT.connection_id,
      connection_revision: SNAPSHOT.connection_revision,
      provider: "slack",
      installation_id: SNAPSHOT.installation_id,
      workspace_id: SNAPSHOT.workspace_id,
      app_id: SNAPSHOT.app_id,
      status: "active",
    },
    actor: { principal_id: "person-a", principal_type: "person", authenticated_subject_id: "U-A" },
    authorization: {
      organization_ids: ["organization-a"],
      project_ids: ["project-a"],
      data_scopes: ["tasks:tenant"],
      capability_ids: ["runtime.execute", "company_authority_v1"],
    },
    placement: { deployment_id: SNAPSHOT.deployment_id, profile: "shared_cloud" },
    slack: { event_id: `Ev-A-${index}`, channel_id: "C-A", thread_ts: "1723800000.000001", requester_id: "U-A" },
    correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAY",
    operation_id: `op_01ARZ3NDEKTSV4RRFFQ69G5FA${index}`,
    idempotency_key: "pending",
    contract_revision: SNAPSHOT.contract_revision,
    credential: { mode: "customer_oauth", credential_ref: "opaque-credential-ref-a", billing_principal_id: "billing-a" },
    issued_at: "2026-08-17T00:59:00.000Z",
    expires_at: "2026-08-17T01:04:00.000Z",
  };
  unsigned.idempotency_key = await createIdempotencyKey({
    protocol_id: unsigned.protocol_id,
    protocol_major: "1",
    tenant_id: unsigned.tenant.tenant_id,
    connection_id: unsigned.workspace_connection.connection_id,
    slack_event_id: unsigned.slack.event_id,
    operation_id: unsigned.operation_id,
  });
  return {
    envelope: await signTenantContextEnvelope(unsigned, keys.privateKey, "test-key-1"),
    publicKey: keys.publicKey,
  };
}


import { createReplyIntakeEffectFetch } from "../reply-intake-effect.js";
import { createBrainbaseTrustedProviderForwarderFromEnv } from "../multitenancy/trusted-provider-forwarder.js";
import { executeTenantRuntimeOperation, postTenantSlackReply } from "../multitenancy/production-consumer.js";
import { TenantAccountingLedger } from "../multitenancy/accounting.js";
import { IdempotencyMemoryStore } from "../multitenancy/idempotency.js";
import { TenantRuntimeBoundaryVerifier } from "../multitenancy/runtime-boundaries.js";
import type { TenantInteractionEffects } from "../slack-interactions.js";

describe("intake credential and delivery integration", () => {
  it("passes all four effects through real verification, ownership, leases, forwarding and accounting", async () => {
    const source = await signedEnvelope();
    const ownership = new IdempotencyMemoryStore();
    const ledger = new TenantAccountingLedger();
    const forwarded: string[] = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    const accounting = { write: vi.fn<TenantAccountingHttpClient["write"]>(async () => ({ result_ref: "recorded" })) };
    let child = 0;
    const intake = createReplyIntakeEffectFetch({
      event: {tenantId:SNAPSHOT.tenant_id,workspaceId:"T-A",eventId:"Ev-A-0",channelId:"C-A",
        threadTs:"1723800000.000001",messageTs:"1723800000.000002",userId:"U-A",
        eventType:"message",text:"test",receivedAt:NOW},
      getTenantContext: () => source.envelope,
      fallback: async () => { throw new Error("unexpected_fallback"); },
      resolveEffects: async () => ({
        async slackDelivery(effectId, _target, event, execute) {
          const { envelope, publicKey } = await signedEnvelope(++child);
          const read = async () => SNAPSHOT;
          const resolveKey = async () => publicKey;
          const verifier = new TenantRuntimeBoundaryVerifier({read_authoritative_snapshot:read,resolve_verification_key:resolveKey});
          const broker: CredentialBrokerClient = { acquire_lease: async request => ({
            message_type:"credential_lease_response",protocol_version:"1.0",
            lease_id:`lease_01ARZ3NDEKTSV4RRFFQ69G5FA${child}`,
            contract_revision:request.binding.contract_revision,binding:request.binding,
            issued_at:NOW,expires_at:"2026-08-17T01:00:59.000Z",max_uses:1,lease_token:"opaque-test-handle",
          })};
          const credentialFetch = createTenantCredentialFetch({envelope,expected_scope:EXPECTED_SCOPE,broker,
            read_authoritative_snapshot:read,resolve_verification_key:resolveKey,now:()=>NOW,
            trusted_forwarder:createBrainbaseTrustedProviderForwarderFromEnv({tenant_context:envelope,env:{
              BRAINBASE_TENANT_RUNTIME_SERVICE:{fetch:async(_input,init)=>{
                redirects.push(init?.redirect);
                const body = JSON.parse(String(init?.body));
                forwarded.push(body.provider_operation);
                expect(body.tenant_context.operation_id).toBe(envelope.operation_id);
                return Response.json({provider:"slack",operation_id:envelope.operation_id,
                  provider_operation:body.provider_operation,status:200,response_encoding:"json",
                  content_type:"application/json",body:{ok:true}});
              }},
            }}),
          });
          await executeTenantRuntimeOperation({tenant_context:envelope,expected_scope:EXPECTED_SCOPE,
            verifier,ledger,accounting,usage_unit:"interaction_effect",now:()=>NOW,
            quota:{read_authoritative_decision:async()=>({message_type:"quota_decision",tenant_id:SNAPSHOT.tenant_id,
              contract_revision:"11",quota_revision:"19",decision:"allowed",limit:100,used:1,remaining:99,
              unit:"tool_calls",window_started_at:"2026-08-01T00:00:00.000Z",window_ends_at:"2026-09-01T00:00:00.000Z",decided_at:NOW})},
            process:async()=>{
              await postTenantSlackReply({tenant_context:envelope,expected_scope:EXPECTED_SCOPE,ownership,
                read_authoritative_snapshot:read,resolve_verification_key:resolveKey,now:NOW,
                retention_until:"2026-09-17T01:00:00.000Z",event,text:`tenant_interaction_effect:${effectId}`,effect_id:effectId,
                post:async()=>{await execute(credentialFetch);return `interaction_effect:${envelope.operation_id}`;}});
              return {outcome:"completed"};
            },
          });
        },
      } as TenantInteractionEffects),
    });
    const reaction={channel:"C-A",timestamp:"1723800000.000002",name:"eyes"};
    const status={channel_id:"C-A",thread_ts:"1723800000.000001",status:"分析しています…"};
    for(const [path,body] of [["reactions.add",reaction],["assistant.threads.setStatus",status],
      ["assistant.threads.setStatus",{...status,status:""}],["reactions.remove",reaction]] as const) {
      const response=await intake(`https://slack.com/api/${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      expect(await response.json()).toEqual({ok:true});
    }
    expect(forwarded).toEqual(["slack.reactions.add.post","slack.assistant.threads.setStatus.post",
      "slack.assistant.threads.setStatus.post","slack.reactions.remove.post"]);
    expect(redirects).toEqual(Array(4).fill("manual"));
    expect(accounting.write).toHaveBeenCalledTimes(4);
    expect(accounting.write.mock.calls.every(([input])=>input.receipt.outcome==="succeeded")).toBe(true);
  });
});
