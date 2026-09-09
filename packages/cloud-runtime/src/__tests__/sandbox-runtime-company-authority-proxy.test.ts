import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  gateway: vi.fn(),
  credentialFetchForResolvedContext: vi.fn(),
  createTaskSearchProxyHandler: vi.fn(),
  createTaskWriteProxyHandler: vi.fn(),
  handleBrainbaseMcpProxyRequest: vi.fn(),
  handleGoogleDriveMcpProxyRequest: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  getSandbox: vi.fn(),
}));

vi.mock("../multitenancy/durable-tenant-boundary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/durable-tenant-boundary.js")>();
  return { ...actual, resolveDurableTenantBoundaryContext: proxyMocks.resolve };
});

vi.mock("../multitenancy/tenant-provider-outbound.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/tenant-provider-outbound.js")>();
  return {
    ...actual,
    tenantCredentialFetchForResolvedContext: proxyMocks.credentialFetchForResolvedContext,
  };
});

vi.mock("../task-search-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-search-proxy.js")>();
  return { ...actual, createTaskSearchProxyHandler: proxyMocks.createTaskSearchProxyHandler };
});

vi.mock("../task-write-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-write-proxy.js")>();
  return { ...actual, createTaskWriteProxyHandler: proxyMocks.createTaskWriteProxyHandler };
});

vi.mock("../brainbase-mcp-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brainbase-mcp-proxy.js")>();
  return { ...actual, handleBrainbaseMcpProxyRequest: proxyMocks.handleBrainbaseMcpProxyRequest };
});

vi.mock("../google-drive-mcp-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../google-drive-mcp-proxy.js")>();
  return { ...actual, handleGoogleDriveMcpProxyRequest: proxyMocks.handleGoogleDriveMcpProxyRequest };
});

vi.mock("../runtime-gateway-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-gateway-proxy.js")>();
  return { ...actual, createRuntimeGatewayProxyHandler: proxyMocks.gateway };
});

import { RUNTIME_GATEWAY_PROXY_HOST } from "../runtime-gateway-proxy.js";
import {
  TechKnightSandbox,
} from "../sandbox-runtime.js";
import { BRAINBASE_MCP_PROXY_HOST } from "../brainbase-mcp-proxy.js";
import { GOOGLE_DRIVE_MCP_PROXY_HOST } from "../google-drive-mcp-proxy.js";
import { TASK_SEARCH_PROXY_HOST } from "../task-search-proxy.js";
import { TASK_WRITE_PROXY_HOST } from "../task-write-proxy.js";
import {
  TENANT_BOUNDARY_HANDLE_HEADER,
  type AuthorizedTenantBoundaryContext,
  type TenantBoundaryContextNamespace,
} from "../multitenancy/durable-tenant-boundary.js";
import type { SandboxRuntimeEnv } from "../sandbox-runtime.js";

const resolvedWithCompanyAuthority = {
  tenant_context: {
    workspace_connection: { workspace_id: "T-workspace" },
    slack: { channel_id: "D0BPK9TFZU6" },
  },
  expected_scope: {},
  company_authority_envelope: {
    company_authority_response: { schema_version: "1.0", authority: { decision: "auto" } },
  },
} as unknown as AuthorizedTenantBoundaryContext;

const resolvedWithoutCompanyAuthority = {
  tenant_context: {
    workspace_connection: { workspace_id: "T-workspace" },
  },
  expected_scope: {},
} as unknown as AuthorizedTenantBoundaryContext;

function request(host: string): Request {
  return new Request(`https://${host}/proxy`, {
    method: "POST",
    headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: "tb_test" },
    body: "{}",
  });
}

function env(): SandboxRuntimeEnv {
  return { TENANT_RUNTIME_STATE: {} as TenantBoundaryContextNamespace } as SandboxRuntimeEnv;
}

const outboundContext = {
  containerId: "container-test",
  className: "TechKnightSandbox",
};

describe("Company Authority sandbox proxy guard", () => {
  beforeEach(() => {
    proxyMocks.gateway.mockReset();
    proxyMocks.gateway.mockReturnValue(vi.fn(async () => Response.json({ handled: "gateway" })));
    proxyMocks.resolve.mockReset();
    proxyMocks.credentialFetchForResolvedContext.mockReset();
    proxyMocks.createTaskSearchProxyHandler.mockReset();
    proxyMocks.createTaskWriteProxyHandler.mockReset();
    proxyMocks.handleBrainbaseMcpProxyRequest.mockReset();
    proxyMocks.handleGoogleDriveMcpProxyRequest.mockReset();

    proxyMocks.credentialFetchForResolvedContext.mockReturnValue(vi.fn());
    proxyMocks.createTaskSearchProxyHandler.mockReturnValue(
      vi.fn(async () => Response.json({ handled: "task-search" })),
    );
    proxyMocks.createTaskWriteProxyHandler.mockReturnValue(
      vi.fn(async () => Response.json({ handled: "task-write" })),
    );
    proxyMocks.handleBrainbaseMcpProxyRequest.mockResolvedValue(
      Response.json({ handled: "brainbase-mcp" }),
    );
    proxyMocks.handleGoogleDriveMcpProxyRequest.mockResolvedValue(
      Response.json({ handled: "google-drive-mcp" }),
    );
  });

  it.each(["tenant_boundary", "credential_config"])("logs the fixed %s rejection without error content", async (phase) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      if (phase === "tenant_boundary") proxyMocks.resolve.mockResolvedValue(new Response("private body", { status: 503 }));
      else {
        proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);
        proxyMocks.credentialFetchForResolvedContext.mockImplementation(() => { throw new Error("secret config"); });
      }
      const response = await TechKnightSandbox.outboundByHost![BRAINBASE_MCP_PROXY_HOST](
        request(BRAINBASE_MCP_PROXY_HOST), env(), outboundContext);
      expect(response.status).toBe(503);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "brainbase_mcp_boundary_rejected", phase, status: 503 }));
      expect(proxyMocks.handleBrainbaseMcpProxyRequest).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it.each(["search_personal_kg", "register_personal_kg"])("wires only %s through the owner-authority gateway", async (tool) => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);
    const response = await TechKnightSandbox.outboundByHost![RUNTIME_GATEWAY_PROXY_HOST](new Request(
      `https://${RUNTIME_GATEWAY_PROXY_HOST}/api/runtime/gateway`, {
        method: "POST", headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: "tb_test" },
        body: JSON.stringify({ tool, arguments: {}, request_id: "Ev123" }),
      }), env(), outboundContext);
    expect(response.status).toBe(200);
    expect(proxyMocks.gateway).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      personalKnowledge: { tenantContext: resolvedWithCompanyAuthority.tenant_context, resolveAuthority: expect.any(Function) },
    }));
  });

  it.each(["search_tasks", "post_slack_message", "unknown"])("keeps %s denied on the generic gateway for Company Authority", async (tool) => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);
    const response = await TechKnightSandbox.outboundByHost![RUNTIME_GATEWAY_PROXY_HOST](new Request(
      `https://${RUNTIME_GATEWAY_PROXY_HOST}/api/runtime/gateway`, {
        method: "POST", headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: "tb_test" }, body: JSON.stringify({ tool }),
      }), env(), outboundContext);
    expect(response.status).toBe(403);
    expect(proxyMocks.gateway).not.toHaveBeenCalled();
    expect(proxyMocks.credentialFetchForResolvedContext).not.toHaveBeenCalled();
  });

  it("rejects Company Authority requests before credential or generic handler creation", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![TASK_SEARCH_PROXY_HOST];
    const response = await route(request(TASK_SEARCH_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "COMPANY_AUTHORITY_OPERATION_FORBIDDEN" });
    expect(proxyMocks.credentialFetchForResolvedContext).not.toHaveBeenCalled();
    expect(proxyMocks.createTaskSearchProxyHandler).not.toHaveBeenCalled();
  });

  it("keeps the exact Brainbase MCP host available for an accepted Company Authority context", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![BRAINBASE_MCP_PROXY_HOST];
    const response = await route(request(BRAINBASE_MCP_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "brainbase-mcp" });
    expect(proxyMocks.credentialFetchForResolvedContext).toHaveBeenCalledTimes(1);
    expect(proxyMocks.handleBrainbaseMcpProxyRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      expect.any(Function),
      {
        allowedTools: [
          "brainbase_resolve_turn",
          "brainbase_judgment_state_record",
          "brainbase_judgment_audit_read",
          "brainbase_knowledge_resolve",
        ],
        companyAuthorityResponse: { schema_version: "1.0", authority: { decision: "auto" } },
      },
    );
  });

  it("does not forward the personal owner authority to a non-DM Brainbase request", async () => {
    proxyMocks.resolve.mockResolvedValue({
      ...resolvedWithCompanyAuthority,
      tenant_context: {
        ...resolvedWithCompanyAuthority.tenant_context,
        slack: { channel_id: "C-channel" },
      },
    });

    const route = TechKnightSandbox.outboundByHost![BRAINBASE_MCP_PROXY_HOST];
    const response = await route(request(BRAINBASE_MCP_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(proxyMocks.handleBrainbaseMcpProxyRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      expect.any(Function),
      {
        allowedTools: [
          "brainbase_resolve_turn",
          "brainbase_judgment_state_record",
          "brainbase_judgment_audit_read",
          "brainbase_knowledge_resolve",
        ],
        companyAuthorityResponse: undefined,
      },
    );
  });

  it("keeps requester-scoped task writes available for an accepted Company Authority context", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![TASK_WRITE_PROXY_HOST];
    const response = await route(request(TASK_WRITE_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "task-write" });
    expect(proxyMocks.credentialFetchForResolvedContext).toHaveBeenCalledTimes(1);
    expect(proxyMocks.createTaskWriteProxyHandler).toHaveBeenCalledTimes(1);
  });

  it("keeps placement-scoped Google Drive MCP available with only the service credential", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithCompanyAuthority);
    const serviceEnv = {
      ...env(),
      GOOGLE_DRIVE_MCP_BASE_URL: "https://drive.example.test",
      GOOGLE_DRIVE_MCP_TOKEN: "service-token",
    };

    const route = TechKnightSandbox.outboundByHost![GOOGLE_DRIVE_MCP_PROXY_HOST];
    const response = await route(request(GOOGLE_DRIVE_MCP_PROXY_HOST), serviceEnv, outboundContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "google-drive-mcp" });
    expect(proxyMocks.credentialFetchForResolvedContext).toHaveBeenCalledTimes(1);
    expect(proxyMocks.handleGoogleDriveMcpProxyRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        GOOGLE_DRIVE_MCP_BASE_URL: "https://drive.example.test",
        GOOGLE_DRIVE_MCP_TOKEN: "service-token",
      }),
    );
  });

  it("preserves the existing generic proxy path without a Company Authority envelope", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithoutCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![TASK_SEARCH_PROXY_HOST];
    const response = await route(request(TASK_SEARCH_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "task-search" });
    expect(proxyMocks.credentialFetchForResolvedContext).toHaveBeenCalledTimes(1);
    expect(proxyMocks.createTaskSearchProxyHandler).toHaveBeenCalledTimes(1);
  });

  it("leaves the Brainbase policy unset for the existing T0 context", async () => {
    proxyMocks.resolve.mockResolvedValue(resolvedWithoutCompanyAuthority);

    const route = TechKnightSandbox.outboundByHost![BRAINBASE_MCP_PROXY_HOST];
    const response = await route(request(BRAINBASE_MCP_PROXY_HOST), env(), outboundContext);

    expect(response.status).toBe(200);
    expect(proxyMocks.handleBrainbaseMcpProxyRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });
});
