import { afterEach, expect, it, vi } from "vitest";
import { oauthTokenRequest } from "../src/providers";
afterEach(() => vi.restoreAllMocks());
it.each([
  [
    400,
    { error: "invalid_grant", error_description: "PRIVATE" },
    "invalid_grant",
  ],
  [401, { error: "invalid_client", token: "PRIVATE" }, "invalid_client"],
  [403, { error: "PRIVATE" }, "unrecognized_error"],
  [429, { error: { message: "PRIVATE" } }, "unrecognized_error"],
  [500, { error: "server_error" }, "server_error"],
] as const)(
  "logs only safe token rejection fields for %s",
  async (status, body, category) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const network = vi.fn(async () => Response.json(body, { status }));
    await expect(
      oauthTokenRequest("https://oauth2.googleapis.com/token", {}, network),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "oauth_token_exchange_failure",
      status,
      category,
    );
    expect(network).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ["not json PRIVATE", "error_body_unreadable"],
  [
    JSON.stringify({
      error: "invalid_client",
      error_description: "PRIVATE".repeat(2000),
    }),
    "error_body_too_large",
  ],
])("bounds and sanitizes error bodies", async (body, category) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(
    oauthTokenRequest(
      "https://oauth2.googleapis.com/token",
      {},
      async () => new Response(body, { status: 400 }),
    ),
  ).rejects.toThrow();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "oauth_token_exchange_failure",
    400,
    category,
  );
});
it("does not expose transport exception text or retry", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const network = vi.fn(async () => {
    throw new Error("PRIVATE");
  });
  await expect(
    oauthTokenRequest("https://oauth2.googleapis.com/token", {}, network),
  ).rejects.toThrow();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "oauth_token_exchange_failure",
    0,
    "transport_failure",
  );
  expect(network).toHaveBeenCalledTimes(1);
});
it("reports malformed success without logging token fields", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(
    oauthTokenRequest(
      "https://oauth2.googleapis.com/token",
      {},
      async () => new Response("PRIVATE", { status: 200 }),
    ),
  ).rejects.toThrow();
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "oauth_token_exchange_failure",
    200,
    "success_body_unreadable",
  );
});
it("does not log successful token payloads", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const tokens = { access_token: "PRIVATE", refresh_token: "PRIVATE" };
  expect(
    await oauthTokenRequest(
      "https://oauth2.googleapis.com/token",
      {},
      async () => Response.json(tokens),
    ),
  ).toEqual(tokens);
  expect(warn).not.toHaveBeenCalled();
});
